import { withLocalTmpDir } from "../utils.ts";
import crypto from "crypto";
import fs from "fs/promises";
import { Readable, Writable } from "stream";
import { pipeline } from "stream/promises";
import * as openpgp from "openpgp";
import { hashFile, hashingTransform, MultiHash } from "../../server/backend/hash.ts";
import type { Digests, HashName } from "../../server/backend/hash.ts";
import { clearsign, describeSigningKey, detachedSignature, loadSigningKey } from "../../server/backend/pgp.ts";

const ALL: HashName[] = ["md5", "sha1", "sha256", "sha512"];
const SAMPLE = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function expectedDigests(data: Buffer): Digests {
    const digests = { size: data.length } as Digests;
    for (const name of ALL) {
        digests[name] = crypto.createHash(name).update(data).digest("hex");
    }
    return digests;
}

function chunks(data: Buffer, size: number): Buffer[] {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < data.length; offset += size) {
        parts.push(data.subarray(offset, offset + size));
    }
    return parts;
}

function collector(into: Buffer[]): Writable {
    return new Writable({
        write(chunk: Buffer, _encoding, callback) {
            into.push(chunk);
            callback();
        },
    });
}

async function verifyDetached(data: Uint8Array, armoredSignature: string, key: openpgp.PrivateKey) {
    const signature = await openpgp.readSignature({ armoredSignature });
    const result = await openpgp.verify({
        message: await openpgp.createMessage({ binary: data }),
        signature,
        verificationKeys: key.toPublic(),
    });
    await expect(result.signatures[0].verified).resolves.toBe(true);
    expect(signature.packets[0].hashAlgorithm).toBe(openpgp.enums.hash.sha256);
}

async function verifyClearsigned(out: string, key: openpgp.PrivateKey) {
    const message = await openpgp.readCleartextMessage({ cleartextMessage: out });
    const result = await openpgp.verify({ message, verificationKeys: key.toPublic() });
    await expect(result.signatures[0].verified).resolves.toBe(true);
    return message.getText();
}

describe("Tests for MultiHash", () => {
    test("MultiHash matches node:crypto for all four algorithms", () => {
        const hash = new MultiHash(ALL);
        for (const part of chunks(SAMPLE, 7919)) {
            hash.update(part);
        }
        expect(hash.digest()).toEqual(expectedDigests(SAMPLE));
    });

    test("Computes only the requested algorithms", () => {
        expect(new MultiHash(["sha256"]).digest()).toEqual({ size: 0, sha256: SHA256_EMPTY });
        expect(new MultiHash([]).digest()).toEqual({ size: 0 });
    });

    test("Digests only once", () => {
        const hash = new MultiHash(["sha256"]);
        hash.update(SAMPLE);
        hash.digest();
        expect(() => hash.digest()).toThrow(/Digest already called/);
    });
});

describe("Tests for hashFile", () => {
    test("Hashes a file and reports its size", withLocalTmpDir(async () => {
        await fs.writeFile("sample.bin", SAMPLE);
        await expect(hashFile("sample.bin")).resolves.toEqual(expectedDigests(SAMPLE));
        await fs.writeFile("empty.bin", "");
        await expect(hashFile("empty.bin")).resolves.toEqual(expectedDigests(Buffer.alloc(0)));
    }));

    test("Rejects a missing file", withLocalTmpDir(async () => {
        await expect(hashFile("missing.bin")).rejects.toThrow(/ENOENT/);
    }));
});

describe("Tests for hashingTransform", () => {
    test("hashingTransform passes data through unchanged and reports digests", async () => {
        const received: Buffer[] = [];
        let reported: Digests | undefined;
        await pipeline(Readable.from(chunks(SAMPLE, 65_536)), hashingTransform(d => { reported = d; }), collector(received));
        expect(Buffer.concat(received).equals(SAMPLE)).toBe(true);
        expect(reported).toEqual(expectedDigests(SAMPLE));
    });

    test("Reports the digests of an empty stream", async () => {
        let reported: Digests | undefined;
        await pipeline(Readable.from([]), hashingTransform(d => { reported = d; }), collector([]));
        expect(reported).toEqual(expectedDigests(Buffer.alloc(0)));
    });

    test("A throwing onEnd rejects the pipeline", async () => {
        const failing = hashingTransform(() => { throw new Error("boom"); });
        await expect(pipeline(Readable.from([SAMPLE]), failing, collector([]))).rejects.toThrow("boom");
    });
});

describe("Tests for pgp", () => {
    let key: openpgp.PrivateKey;

    beforeAll(async () => {
        const { privateKey } = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "t" }], format: "armored" });
        key = await openpgp.readPrivateKey({ armoredKey: privateKey });
    });

    test("Clearsigns with a SHA2 Hash header and verifies", async () => {
        const out = await clearsign("Origin: x\n", key);
        expect(out).toMatch(/^-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA(256|384|512)\n/);
        const v = await openpgp.verify({ message: await openpgp.readCleartextMessage({ cleartextMessage: out }), verificationKeys: key.toPublic() });
        await expect(v.signatures[0].verified).resolves.toBe(true);
    });

    test("Returns an LF body that verifies and keeps dash lines", async () => {
        const text = "Origin: x\nSuite: a\n-dash\n";
        const out = await clearsign(text, key);
        expect(out).not.toContain("\r");
        expect(out).toContain("\n\nOrigin: x\nSuite: a\n- -dash\n");
        expect(out.endsWith("-----END PGP SIGNATURE-----\n")).toBe(true);
        expect(await verifyClearsigned(out, key)).toBe(text);
    });

    test("Detached signature verifies over bytes", async () => {
        const data = Buffer.from("Origin: x\nSuite: a\n", "utf8");
        const out = await detachedSignature(data, key);
        expect(out.startsWith("-----BEGIN PGP SIGNATURE-----\n")).toBe(true);
        expect(out.endsWith("-----END PGP SIGNATURE-----\n")).toBe(true);
        await verifyDetached(data, out, key);
        await verifyDetached(data, await detachedSignature(data.toString("utf8"), key), key);
    });

    test("Signs with an RSA key", async () => {
        const { privateKey } = await openpgp.generateKey({ type: "rsa", rsaBits: 2048, userIDs: [{ name: "t" }], format: "object" });
        const out = await clearsign("Origin: x\n", privateKey);
        expect(out.startsWith("-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n")).toBe(true);
        expect(await verifyClearsigned(out, privateKey)).toBe("Origin: x\n");
        const data = Buffer.from("repomd");
        await verifyDetached(data, await detachedSignature(data, privateKey), privateKey);
    }, 30_000);

    test("Describes the key that signs, with the algorithm number clients read", async () => {
        const generate = async (options: object): Promise<openpgp.PrivateKey> =>
            (await openpgp.generateKey({ ...options, userIDs: [{ name: "t" }], format: "object" } as openpgp.GenerateKeyOptions & { format: "object" })).privateKey;
        const rsa = await generate({ type: "rsa", rsaBits: 2048 });
        const legacy = await generate({ type: "ecc", curve: "curve25519Legacy" });
        const withSigningSubkey = await generate({ type: "curve25519", subkeys: [{ sign: true }] });

        expect(await describeSigningKey(rsa)).toBe(`algorithm 1 (rsaEncryptSign, 2048 bits), fingerprint ${ rsa.getFingerprint() }`);
        expect(await describeSigningKey(legacy)).toBe(`algorithm 22 (eddsaLegacy, ed25519Legacy), fingerprint ${ legacy.getFingerprint() }`);
        expect(await describeSigningKey(key)).toBe(`algorithm 27 (ed25519), fingerprint ${ key.getFingerprint() }`);
        expect(await describeSigningKey(withSigningSubkey)).toBe(`algorithm 27 (ed25519), fingerprint ${ withSigningSubkey.subkeys[0].getFingerprint() }`);
    }, 30_000);

    test("Loads binary and armored keys", withLocalTmpDir(async () => {
        await fs.writeFile("key.asc", key.armor());
        await fs.writeFile("key.gpg", key.write());
        const armored = await loadSigningKey("key.asc");
        const binary = await loadSigningKey("key.gpg");
        expect(armored?.getFingerprint()).toBe(key.getFingerprint());
        expect(binary?.getFingerprint()).toBe(key.getFingerprint());
        expect(armored?.isDecrypted()).toBe(true);
    }));

    test("Returns undefined without a key file", withLocalTmpDir(async () => {
        await expect(loadSigningKey(undefined)).resolves.toBeUndefined();
        await expect(loadSigningKey("missing.gpg")).resolves.toBeUndefined();
    }));

    test("Rejects a passphrase-protected key", withLocalTmpDir(async () => {
        const { privateKey } = await openpgp.generateKey({
            type: "curve25519", userIDs: [{ name: "t" }], passphrase: "secret", format: "armored",
        });
        await fs.writeFile("protected.asc", privateKey);
        await expect(loadSigningKey("protected.asc")).rejects.toThrow(/protected/);
    }));

    test("Rejects a key whose signing subkey is protected", withLocalTmpDir(async () => {
        const { privateKey } = await openpgp.generateKey({
            type: "curve25519", userIDs: [{ name: "t" }], passphrase: "secret", subkeys: [{ sign: true }], format: "object",
        });
        await (privateKey.keyPacket as openpgp.SecretKeyPacket).decrypt("secret");
        expect(privateKey.isDecrypted()).toBe(true);
        expect((await privateKey.getSigningKey()).keyPacket.isDecrypted()).toBe(false);
        await fs.writeFile("subkey.asc", privateKey.armor());
        await expect(loadSigningKey("subkey.asc")).rejects.toThrow(/protected/);
    }));

    test("Rejects an expired key", withLocalTmpDir(async () => {
        const { privateKey } = await openpgp.generateKey({
            type: "curve25519", userIDs: [{ name: "t" }], keyExpirationTime: 1, date: new Date(Date.now() - 100_000), format: "armored",
        });
        await fs.writeFile("expired.asc", privateKey);
        const error: Error = await loadSigningKey("expired.asc").then(() => { throw new Error("resolved"); }, e => e);
        expect(error.message).toMatch(/No usable signing key in expired\.asc/);
        expect((error.cause as Error).message).toMatch(/expired/);
    }));

    test("Rejects a file that is not a key", withLocalTmpDir(async () => {
        await fs.writeFile("text.asc", "not a key\n");
        await fs.writeFile("bytes.gpg", Buffer.from([0xc5, 0x01, 0x02]));
        await expect(loadSigningKey("text.asc")).rejects.toThrow(/text\.asc/);
        await expect(loadSigningKey("bytes.gpg")).rejects.toThrow(/bytes\.gpg/);
    }));
});
