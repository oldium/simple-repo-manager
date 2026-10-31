import crypto from "crypto";
import { createReadStream } from "fs";
import { pipeline } from "stream/promises";
import * as openpgp from "openpgp";
import { hasTextAfterSignature, isClearsigned, stripClearsign } from "./control.ts";
import { readRpmSignedParts } from "./rpm/header.ts";
import { RepoValidationError } from "../lib/errors.ts";
import logger from "../lib/logger.ts";

type Signatures = Awaited<ReturnType<typeof openpgp.verify>>["signatures"];

// rpm's numbers of the digest algorithms
const PAYLOAD_DIGESTS: Record<number, string> = { 8: "sha256", 9: "sha384", 10: "sha512", 11: "sha224", 12: "sha3-256", 14: "sha3-512" };
// The rpm 6 format leaves the algorithm out, its digest tag always means this one
const DEFAULT_PAYLOAD_DIGEST = 8;
// Each packet hashes all that is signed before it can fail, and a forged one takes 31 bytes
const MAX_SIGNATURE_PACKETS = 4;
const MAX_SIGNATURE_BYTES = 64 * 1024;

function withoutTrailingSpace(text: string): string {
    return text.split("\n").map(line => line.trimEnd()).join("\n").trimEnd();
}

function problemText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function warnNotVerified(name: string): void {
    logger.warn(`Could not verify the signature of ${ name }: there are no keys to verify uploads with`);
}

/** Fine when one signature verifies with one of the keys */
async function checkVerified(name: string, signatures: Signatures, keys: openpgp.PublicKey[]): Promise<void> {
    let invalid: string | undefined;
    for (const { keyID, verified } of signatures) {
        try {
            await verified;
            return;
        } catch (err) {
            if (keys.some(key => key.getKeys(keyID).length > 0)) {
                invalid ??= `${ keyID.toHex() }: ${ problemText(err) }`;
            }
        }
    }
    if (invalid !== undefined) {
        throw new RepoValidationError(`${ name } has a signature that does not verify, by ${ invalid }`);
    }
    throw new RepoValidationError(`${ name } is signed by ${ signatures.map(({ keyID }) => keyID.toHex()).join(", ") }, none of the keys that verify uploads`);
}

/** The text of a .changes or .dsc to go on with. With keys that is what the signature covers, so nothing around it can slip in. */
export async function verifiedControlText(name: string, text: string, keys: openpgp.PublicKey[] | undefined): Promise<string> {
    const signed = isClearsigned(text);
    if (keys === undefined || keys.length === 0) {
        if (signed) {
            warnNotVerified(name);
        }
        return text;
    }
    if (!signed) {
        throw new RepoValidationError(`${ name } is not signed`);
    }
    let message: openpgp.CleartextMessage;
    try {
        message = await openpgp.readCleartextMessage({ cleartextMessage: text });
    } catch (err) {
        throw new RepoValidationError(`${ name } has a malformed signature: ${ problemText(err) }`);
    }
    // There at run time, though the types leave it out
    if ((message as unknown as { signature: openpgp.Signature }).signature.packets.length > MAX_SIGNATURE_PACKETS) {
        throw new RepoValidationError(`${ name } has more than ${ MAX_SIGNATURE_PACKETS } signatures`);
    }
    const { signatures } = await openpgp.verify({ message, verificationKeys: keys });
    await checkVerified(name, signatures, keys);
    // A rebuild reads the stored file with the plain parser, which has to find the same text
    if (hasTextAfterSignature(text) || withoutTrailingSpace(stripClearsign(text)) !== withoutTrailingSpace(message.getText())) {
        throw new RepoValidationError(`${ name } holds more than its signature covers`);
    }
    return message.getText();
}

/** Nothing signs the name of the .changes itself, and the catalog keys an upload by it */
export function checkChangesName(name: string, source: string, version: string, keys: openpgp.PublicKey[] | undefined): void {
    const prefix = `${ source }_${ version.slice(version.indexOf(":") + 1) }_`;
    if (keys !== undefined && keys.length > 0 && !name.startsWith(prefix)) {
        throw new RepoValidationError(`${ name } does not match what it is signed for, a name starting with ${ prefix }`);
    }
}

async function payloadDigest(file: string, start: number, algorithm: string): Promise<string> {
    const hash = crypto.createHash(algorithm);
    await pipeline(createReadStream(file, { start }), hash);
    return hash.digest("hex");
}

/** The signature covers the header, and the header holds the digest of the payload, so both have to agree */
export async function checkRpmSignature(file: string, name: string, keys: openpgp.PublicKey[] | undefined): Promise<void> {
    const parts = await readRpmSignedParts(file);
    if (keys === undefined || keys.length === 0) {
        if (parts.signatures.length > 0) {
            warnNotVerified(name);
        }
        return;
    }
    if (parts.signatures.length === 0) {
        throw new RepoValidationError(`${ name } is not signed`);
    }
    if (parts.signatures.length > MAX_SIGNATURE_PACKETS || parts.signatures.some(signature => signature.length > MAX_SIGNATURE_BYTES)) {
        throw new RepoValidationError(`${ name } has more signature data than an rpm signature takes`);
    }
    const signatures: Signatures = [];
    let unreadable: string | undefined;
    for (const binarySignature of parts.signatures) {
        try {
            const signature = await openpgp.readSignature({ binarySignature });
            if (signature.packets.length > MAX_SIGNATURE_PACKETS) {
                throw new RepoValidationError(`${ name } has more signature data than an rpm signature takes`);
            }
            const message = await openpgp.createMessage({ binary: parts.header });
            signatures.push(...(await openpgp.verify({ message, signature, verificationKeys: keys, format: "binary" })).signatures);
        } catch (err) {
            unreadable ??= problemText(err);
        }
    }
    if (signatures.length === 0) {
        throw new RepoValidationError(`${ name } has a signature that cannot be read: ${ unreadable as string }`);
    }
    await checkVerified(name, signatures, keys);
    // The catalog keys a package by its file name, which nothing signs, so a signed package could replace any other
    if (!parts.signedNames.includes(name)) {
        throw new RepoValidationError(`${ name } does not match what it is signed for, ${ parts.signedNames[0] }`);
    }
    const algorithm = PAYLOAD_DIGESTS[parts.payloadDigestAlgorithm ?? DEFAULT_PAYLOAD_DIGEST];
    if (parts.payloadDigest === undefined || algorithm === undefined) {
        throw new RepoValidationError(`${ name } has no payload digest its signature could cover, as rpm before 4.14 built it`);
    }
    if (await payloadDigest(file, parts.payloadStart, algorithm) !== parts.payloadDigest) {
        throw new RepoValidationError(`${ name } has a payload that does not match its signed digest`);
    }
}
