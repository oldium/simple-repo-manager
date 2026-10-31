import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import fs from "fs/promises";
import osPath from "path";
import * as openpgp from "openpgp";
import { fileURLToPath } from "url";
import { clearsign } from "../../server/backend/pgp.ts";
import { checkChangesName, checkRpmSignature, verifiedControlText } from "../../server/backend/upload-signature.ts";
import { RepoValidationError } from "../../server/lib/errors.ts";
import logger from "../../server/lib/logger.ts";
import { rpmHeaderBounds, signRpm } from "../signing.ts";
import { withLocalTmpDir } from "../utils.ts";

const RPM = fileURLToPath(new URL("../fixtures/packages/rpm/fedora/42/srm-hello-1.0-1.fc42.x86_64.rpm", import.meta.url));
const NAME = "srm-hello-1.0-1.fc42.x86_64.rpm";
const TEXT = "Source: srm-hello\nVersion: 1.0-1\n";
// Lower-cased, as OpenPGP.js prints a key id
const hexId = (key: openpgp.PublicKey | openpgp.PrivateKey): string => key.getKeyID().toHex();

let rsa: openpgp.PrivateKey;
let eddsa: openpgp.PrivateKey;
let other: openpgp.PrivateKey;

beforeAll(async () => {
    [rsa, eddsa, other] = await Promise.all([
        openpgp.generateKey({ type: "rsa", rsaBits: 2048, userIDs: [{ name: "rsa" }], format: "object" }),
        openpgp.generateKey({ type: "ecc", curve: "ed25519Legacy", userIDs: [{ name: "eddsa" }], format: "object" }),
        openpgp.generateKey({ type: "rsa", rsaBits: 2048, userIDs: [{ name: "other" }], format: "object" }),
    ].map(async key => (await key).privateKey));
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe("verifiedControlText", () => {
    test("A text signed with one of the keys comes back as what the signature covers", async () => {
        const signed = await clearsign(TEXT, rsa);

        expect((await verifiedControlText("x.changes", signed, [other.toPublic(), rsa.toPublic()])).trimEnd()).toBe(TEXT.trimEnd());
    });

    test("Text after the signature is refused, it would be stored with the file", async () => {
        const signed = `${ await clearsign(TEXT, rsa) }\nSource: evil\nVersion: 6.6.6\n`;

        await expect(verifiedControlText("x.changes", signed, [rsa.toPublic()])).rejects.toThrow("x.changes holds more than its signature covers");
    });

    test("White space after the signature is fine", async () => {
        expect((await verifiedControlText("x.changes", `${ await clearsign(TEXT, rsa) }\n\n  \n`, [rsa.toPublic()])).trimEnd()).toBe(TEXT.trimEnd());
    });

    test("Text the plain parser would read instead of the signed one is refused", async () => {
        const signed = (await clearsign(TEXT, rsa)).replaceAll("\n\n", "\n \n");
        const crafted = `${ signed.trimEnd() }\nSource: evil\nVersion: 6.6.6\n-----BEGIN PGP SIGNATURE-----\n`;

        await expect(verifiedControlText("x.changes", crafted, [rsa.toPublic()])).rejects.toThrow("x.changes holds more than its signature covers");
    });

    test("Dash escaping is undone, and trailing spaces, which a signature does not cover, are gone", async () => {
        const text = "Source: srm-hello\nVersion: 1.0-1\nChanges:\n - fix  \n- not a list\n";

        expect((await verifiedControlText("x.changes", await clearsign(text, rsa), [rsa.toPublic()])).trimEnd()).toBe("Source: srm-hello\nVersion: 1.0-1\nChanges:\n - fix\n- not a list");
    });

    test("More signatures than anyone needs are refused", async () => {
        const signed = await clearsign(TEXT, rsa);
        const start = signed.indexOf("-----BEGIN PGP SIGNATURE-----");
        const { data } = await openpgp.unarmor(signed.slice(start));
        const many = openpgp.armor(openpgp.enums.armor.signature, Buffer.concat(Array.from({ length: 5 }, () => Buffer.from(data as Uint8Array))));

        await expect(verifiedControlText("x.changes", `${ signed.slice(0, start) }${ many }`, [rsa.toPublic()])).rejects.toThrow("x.changes has more than 4 signatures");
    });

    test("An unsigned text is refused", async () => {
        await expect(verifiedControlText("x.changes", TEXT, [rsa.toPublic()])).rejects.toThrow(new RepoValidationError("x.changes is not signed"));
    });

    test("Text in front of a signed part counts as unsigned", async () => {
        await expect(verifiedControlText("x.changes", `Source: evil\n\n${ await clearsign(TEXT, rsa) }`, [rsa.toPublic()])).rejects.toThrow("x.changes is not signed");
    });

    test("A text signed with another key is refused, naming the key", async () => {
        await expect(verifiedControlText("x.changes", await clearsign(TEXT, other), [rsa.toPublic()]))
            .rejects.toThrow(`x.changes is signed by ${ hexId(other) }, none of the keys that verify uploads`);
    });

    test("A text changed after signing is refused", async () => {
        const signed = (await clearsign(TEXT, rsa)).replace("1.0-1", "6.6.6");

        await expect(verifiedControlText("x.changes", signed, [rsa.toPublic()]))
            .rejects.toThrow(`x.changes has a signature that does not verify, by ${ hexId(rsa) }`);
    });

    test("A broken signature block is refused", async () => {
        const signed = `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n${ TEXT }-----BEGIN PGP SIGNATURE-----\n\nbroken\n-----END PGP SIGNATURE-----\n`;

        await expect(verifiedControlText("x.changes", signed, [rsa.toPublic()])).rejects.toThrow(/^x\.changes has a malformed signature/);
    });

    test.each([[undefined], [[]]])("With keys %j a signed text is only warned about and comes back as it is", async keys => {
        const warn = jest.spyOn(logger, "warn").mockReturnValue(logger);
        const signed = await clearsign(TEXT, other);

        expect(await verifiedControlText("x.changes", signed, keys)).toBe(signed);

        expect(warn.mock.calls).toEqual([["Could not verify the signature of x.changes: there are no keys to verify uploads with"]]);
    });

    test("Without keys an unsigned text has nothing to warn about", async () => {
        const warn = jest.spyOn(logger, "warn").mockReturnValue(logger);

        expect(await verifiedControlText("x.changes", TEXT, [])).toBe(TEXT);

        expect(warn).not.toHaveBeenCalled();
    });
});

describe("checkRpmSignature", () => {
    const check = async (bytes: Buffer, keys: openpgp.PublicKey[] | undefined): Promise<void> => {
        await fs.writeFile(NAME, bytes);
        await checkRpmSignature(NAME, NAME, keys);
    };
    const unsigned = (): Promise<Buffer> => fs.readFile(RPM);

    test("An rpm signed with RSA verifies", withLocalTmpDir(async () => {
        await check(await signRpm(await unsigned(), rsa), [other.toPublic(), rsa.toPublic()]);
    }));

    test("An rpm signed with EdDSA, which rpm keeps in its own tag, verifies", withLocalTmpDir(async () => {
        await check(await signRpm(await unsigned(), eddsa), [eddsa.toPublic()]);
    }));

    test("An rpm with the base64 signature of the rpm 6 format verifies", withLocalTmpDir(async () => {
        await check(await signRpm(await unsigned(), rsa, 6), [rsa.toPublic()]);
    }));

    test("An rpm with no algorithm for its payload digest, as the rpm 6 format writes it, is checked with SHA-256", withLocalTmpDir(async () => {
        const bytes = await unsigned();
        const { start } = rpmHeaderBounds(bytes);
        const count = bytes.readUInt32BE(start + 8);
        for (let i = 0; i < count; i++) {
            const at = start + 16 + i * 16;
            if (bytes.readUInt32BE(at) === 5093) {
                bytes.writeUInt32BE(5098, at);
            }
        }
        const signed = await signRpm(bytes, rsa);

        await check(signed, [rsa.toPublic()]);
        signed[signed.length - 3] ^= 1;
        await expect(check(signed, [rsa.toPublic()])).rejects.toThrow(`${ NAME } has a payload that does not match its signed digest`);
    }));

    test.each(["srm-hello-doc-1.0-1.fc42.noarch.rpm", "srm-hello-2.0-1.fc42.x86_64.rpm", "x.rpm"])("A signed rpm under the name %s is refused, it could replace that package", name => withLocalTmpDir(async () => {
        await fs.writeFile(name, await signRpm(await unsigned(), rsa));

        await expect(checkRpmSignature(name, name, [rsa.toPublic()])).rejects.toThrow(`${ name } does not match what it is signed for, ${ NAME }`);
    })());

    test("A signed source rpm takes its own name", withLocalTmpDir(async () => {
        const name = "srm-hello-1.0-1.fc42.src.rpm";
        await fs.writeFile(name, await signRpm(await fs.readFile(osPath.join(osPath.dirname(RPM), name)), rsa));

        await checkRpmSignature(name, name, [rsa.toPublic()]);
    }));

    test.each([["too many packets", (signature: Buffer) => Buffer.concat(Array.from({ length: 5 }, () => signature))], ["too many bytes", () => Buffer.alloc(64 * 1024 + 1)]])("%s are refused", (_, mangle) => withLocalTmpDir(async () => {
        await expect(check(await signRpm(await unsigned(), rsa, 4, mangle), [rsa.toPublic()])).rejects.toThrow(/has more signature data than an rpm signature takes/);
    })());

    test("An unsigned rpm is refused", withLocalTmpDir(async () => {
        await expect(check(await unsigned(), [rsa.toPublic()])).rejects.toThrow(new RepoValidationError(`${ NAME } is not signed`));
    }));

    test("An rpm signed with another key is refused, naming the key", withLocalTmpDir(async () => {
        await expect(check(await signRpm(await unsigned(), other), [rsa.toPublic()]))
            .rejects.toThrow(`${ NAME } is signed by ${ hexId(other) }, none of the keys that verify uploads`);
    }));

    test("A header changed after signing is refused", withLocalTmpDir(async () => {
        const signed = await signRpm(await unsigned(), rsa);
        signed[rpmHeaderBounds(signed).end - 3] ^= 1;

        await expect(check(signed, [rsa.toPublic()])).rejects.toThrow(`${ NAME } has a signature that does not verify, by ${ hexId(rsa) }`);
    }));

    test("A payload changed after signing is refused", withLocalTmpDir(async () => {
        const signed = await signRpm(await unsigned(), rsa);
        signed[signed.length - 3] ^= 1;

        await expect(check(signed, [rsa.toPublic()])).rejects.toThrow(`${ NAME } has a payload that does not match its signed digest`);
    }));

    test("A payload that grew after signing is refused", withLocalTmpDir(async () => {
        await expect(check(Buffer.concat([await signRpm(await unsigned(), rsa), Buffer.from("x")]), [rsa.toPublic()]))
            .rejects.toThrow(`${ NAME } has a payload that does not match its signed digest`);
    }));

    test("A signature with no payload digest covers too little and is refused", withLocalTmpDir(async () => {
        const bytes = await unsigned();
        const { start } = rpmHeaderBounds(bytes);
        const count = bytes.readUInt32BE(start + 8);
        for (let i = 0; i < count; i++) {
            const at = start + 16 + i * 16;
            if (bytes.readUInt32BE(at) === 5092) {
                bytes.writeUInt32BE(5098, at);
            }
        }

        await expect(check(await signRpm(bytes, rsa), [rsa.toPublic()])).rejects.toThrow(`${ NAME } has no payload digest its signature could cover, as rpm before 4.14 built it`);
    }));

    test.each([[undefined], [[]]])("With keys %j a signed rpm is only warned about", keys => withLocalTmpDir(async () => {
        const warn = jest.spyOn(logger, "warn").mockReturnValue(logger);

        await check(await signRpm(await unsigned(), other), keys);

        expect(warn.mock.calls).toEqual([[`Could not verify the signature of ${ NAME }: there are no keys to verify uploads with`]]);
    })());

    test("Without keys an unsigned rpm has nothing to warn about", withLocalTmpDir(async () => {
        const warn = jest.spyOn(logger, "warn").mockReturnValue(logger);

        await check(await unsigned(), []);

        expect(warn).not.toHaveBeenCalled();
    }));

    test("A file that is no rpm is refused", withLocalTmpDir(async () => {
        await expect(check(Buffer.alloc(200), [rsa.toPublic()])).rejects.toThrow(`${ NAME } is not an rpm package`);
    }));
});

describe("checkChangesName", () => {
    test.each([["srm-hello_1.0-1_amd64.changes", "1.0-1"], ["srm-hello_1.0-1_source.changes", "1.0-1"], ["srm-hello_1.0-1_multi.changes", "1.0-1"], ["srm-hello_1.0-1_amd64.changes", "2:1.0-1"]])("%s fits the version %s", (name, version) => {
        expect(() => checkChangesName(name, "srm-hello", version, [rsa.toPublic()])).not.toThrow();
    });

    test.each([["srm-hello_1.1-1_amd64.changes"], ["srm-hello_1.0-1.changes"], ["other_1.0-1_amd64.changes"], ["srm-hello_1.0-10_amd64.changes"]])("%s does not fit the version 1.0-1, it could take the place of that upload", name => {
        expect(() => checkChangesName(name, "srm-hello", "1.0-1", [rsa.toPublic()])).toThrow(`${ name } does not match what it is signed for, a name starting with srm-hello_1.0-1_`);
    });

    test.each([[undefined], [[]]])("With keys %j any name goes", keys => {
        expect(() => checkChangesName("other.changes", "srm-hello", "1.0-1", keys)).not.toThrow();
    });
});
