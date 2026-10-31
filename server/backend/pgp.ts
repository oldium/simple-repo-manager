import fs from "fs/promises";
import osPath from "path";
import * as openpgp from "openpgp";
import { statQuietly } from "./publish-fs.ts";
import logger from "../lib/logger.ts";

const SIGN_CONFIG: openpgp.PartialConfig = { preferredHashAlgorithm: openpgp.enums.hash.sha256 };

/** Date and size tell a changed key file without reading it; undefined when there is no file */
export async function keyFileStamp(file: string | undefined): Promise<string | undefined> {
    const stat = file === undefined ? undefined : await statQuietly(file);
    return stat === undefined ? undefined : `${ stat.mtimeMs }:${ stat.size }`;
}

export async function loadSigningKey(file: string | undefined): Promise<openpgp.PrivateKey | undefined> {
    if (!file) {
        return undefined;
    }
    let data: Buffer;
    try {
        data = await fs.readFile(file);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw err;
    }
    let key: openpgp.PrivateKey;
    try {
        // Every OpenPGP packet tag has bit 7 set; armor is ASCII
        key = data.length > 0 && (data[0] & 0x80) !== 0
            ? await openpgp.readPrivateKey({ binaryKey: data })
            : await openpgp.readPrivateKey({ armoredKey: data.toString("utf8") });
    } catch (err) {
        throw new Error(`Failed to read private key ${ file }`, { cause: err });
    }
    let signing: openpgp.PrivateKey | openpgp.Subkey;
    try {
        signing = await key.getSigningKey();
    } catch (err) {
        throw new Error(`No usable signing key in ${ file }`, { cause: err });
    }
    // key.isDecrypted() is true when any packet is, so check the packet that signs
    if (!signing.keyPacket.isDecrypted()) {
        throw new Error(`Signing key in ${ file } is passphrase-protected, signing needs an unprotected key`);
    }
    return key;
}

/** A configured key that is not there: a wrong configuration at the start, during a run the keys loaded before stay */
export class MissingKeyError extends Error { }

const ARMORED_KEY = /-----BEGIN PGP (PUBLIC|PRIVATE) KEY BLOCK-----[\s\S]+?-----END PGP \1 KEY BLOCK-----/g;

/** Any number of keys, armored or binary */
async function readKeyFile(file: string): Promise<openpgp.PublicKey[]> {
    let data: Buffer;
    try {
        data = await fs.readFile(file);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            throw new MissingKeyError(`GPG key file ${ file } does not exist`);
        }
        throw err;
    }
    try {
        // Every OpenPGP packet tag has bit 7 set; armor is ASCII
        const keys = data.length > 0 && (data[0] & 0x80) !== 0
            ? await openpgp.readKeys({ binaryKeys: data })
            : (await Promise.all((data.toString("utf8").match(ARMORED_KEY) ?? []).map(armoredKeys => openpgp.readKeys({ armoredKeys })))).flat();
        if (keys.length === 0) {
            throw new Error("it holds no key");
        }
        return keys.map(key => key.toPublic());
    } catch (err) {
        throw new Error(`Failed to read public keys from ${ file }`, { cause: err });
    }
}

export type UploadKeySources = { file?: string; dir?: string };

/** What uploads have to be signed with: the configured keys and the one signing the repository, each once */
export async function loadUploadKeys({ file, dir }: UploadKeySources, signingKey: openpgp.PrivateKey | undefined): Promise<openpgp.PublicKey[]> {
    const files = file === undefined ? [] : [file];
    if (dir !== undefined) {
        try {
            // A secret mounted by Kubernetes is a link
            const entries = await Promise.all((await fs.readdir(dir)).map(async name => ({ file: osPath.join(dir, name), isFile: (await statQuietly(osPath.join(dir, name)))?.isFile() === true })));
            const found = entries.filter(entry => entry.isFile).map(entry => entry.file).sort();
            if (found.length === 0) {
                throw new MissingKeyError(`GPG keys directory ${ dir } holds no file`);
            }
            files.push(...found);
        } catch (err) {
            throw (err as NodeJS.ErrnoException).code === "ENOENT" ? new MissingKeyError(`GPG keys directory ${ dir } does not exist`) : err;
        }
    }
    const keys = (await Promise.all(files.map(readKeyFile))).flat();
    const unique = new Map([...signingKey === undefined ? [] : [signingKey.toPublic()], ...keys].map(key => [key.getFingerprint(), key]));
    return [...unique.values()];
}

export function logUploadKeys(keys: openpgp.PublicKey[]): void {
    if (keys.length === 0) {
        logger.warn("Uploads cannot be verified: there is no GPG_PUBLIC_KEYS_FILE, GPG_PUBLIC_KEYS_DIR or GPG_REPO_PRIVATE_KEY_FILE key");
    } else {
        logger.info(`Verifying uploads with ${ keys.map(key => key.getFingerprint()).join(", ") }`);
    }
}

/** The key that signs; its algorithm number is what clients read from every signature, and not all of them know each one */
export async function describeSigningKey(key: openpgp.PrivateKey): Promise<string> {
    const signing = await key.getSigningKey();
    const { algorithm, bits, curve } = signing.getAlgorithmInfo();
    const details = [algorithm, curve ?? (bits === undefined ? undefined : `${ bits } bits`)].filter(detail => detail !== undefined).join(", ");
    return `algorithm ${ signing.keyPacket.algorithm } (${ details }), fingerprint ${ signing.getFingerprint() }`;
}

export async function clearsign(text: string, key: openpgp.PrivateKey): Promise<string> {
    const message = await openpgp.createCleartextMessage({ text });
    const signed = await openpgp.sign({ message, signingKeys: key, config: SIGN_CONFIG });
    // The signature covers the canonical form, so the CRLF body verifies as LF too
    return signed.replaceAll("\r\n", "\n");
}

export async function detachedSignature(data: string | Uint8Array, key: openpgp.PrivateKey): Promise<string> {
    const binary = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const message = await openpgp.createMessage({ binary });
    return openpgp.sign({ message, signingKeys: key, detached: true, format: "armored", config: SIGN_CONFIG });
}

async function anyVerifies(signatures: openpgp.VerifyMessageResult["signatures"]): Promise<boolean> {
    for (const signature of signatures) {
        if (await signature.verified.catch(() => false)) {
            return true;
        }
    }
    return false;
}

/** Whether the armored detached signature covers data and was made by the key; malformed armor counts as not */
export async function verifyDetached(data: string | Uint8Array, armoredSignature: string, key: openpgp.PrivateKey): Promise<boolean> {
    const binary = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    try {
        const signature = await openpgp.readSignature({ armoredSignature });
        const message = await openpgp.createMessage({ binary });
        return await anyVerifies((await openpgp.verify({ message, signature, verificationKeys: key })).signatures);
    } catch {
        return false;
    }
}

/** Whether the clearsigned message carries exactly text and was signed by the key; malformed armor counts as not */
export async function verifyClearsigned(cleartextMessage: string, text: string, key: openpgp.PrivateKey): Promise<boolean> {
    try {
        const message = await openpgp.readCleartextMessage({ cleartextMessage });
        return message.getText() === text && await anyVerifies((await openpgp.verify({ message, verificationKeys: key })).signatures);
    } catch {
        return false;
    }
}
