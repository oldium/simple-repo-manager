import fs from "fs/promises";
import * as openpgp from "openpgp";

const SIGN_CONFIG: openpgp.PartialConfig = { preferredHashAlgorithm: openpgp.enums.hash.sha256 };

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
