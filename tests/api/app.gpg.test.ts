// noinspection DuplicatedCode

import { createFiles, withLocalTmpDir } from "../utils.ts";
import createTestApp from "../testapp.ts";
import logger from "../../server/lib/logger.ts";
import { jest } from "@jest/globals";
import osPath from "path";
import dedent from "dedent";
import request from "supertest";

const GPG_PRIVATE_KEYS = [
    dedent`
        -----BEGIN PGP PRIVATE KEY BLOCK-----
        
        xUkEauMY3BsZk0ZOmIvgFg7YYlYfHGUa5Vr+Qd3+dEmOE2JPnfXSUADLqcdp
        Q+3YYmGq9UaCCAeyLp4OdZeiQmtkL7fAAfDpKg/azQhUZXN0IEtlecLADwQT
        GwoAhQWCauMY3AMLCQcJEJRE11HzxkX6RRQAAAAAABwAIHNhbHRAbm90YXRp
        b25zLm9wZW5wZ3Bqcy5vcmdgrRosxX/+6U73jtCazgi1SwgdETpxHcOHzFPY
        2gNvRAUVCggODAQWAAIBAhkBApsDAh4BFiEEmDxmfLvssZTZqKjLlETXUfPG
        RfoAAM39j1kmM5F8zqcuSb1JKZ3whD22k9ZJ/ivIFawFucEAxLjknEUZs6s6
        2vkLrM+8ZSVt3ic/YfcyABhngyyIFBMzDsdJBGrjGNwZ2w9Tfo2MTRsq+o4i
        u8+BjseShS2RkP9ZGO+K9AhivUAASCiOnZTzjic1w+o7MK4n4UdydzLWAIek
        RMkp8PGVVlkPmMK6BBgbCgBwBYJq4xjcCRCURNdR88ZF+kUUAAAAAAAcACBz
        YWx0QG5vdGF0aW9ucy5vcGVucGdwanMub3JnzZY9sUgMRRfJzcLNAr6GlcN1
        ERhXvdmc5QXyNdiAC+sCmwwWIQSYPGZ8u+yxlNmoqMuURNdR88ZF+gAAVgO1
        HbqgxO694CqU7yVky758+O+h/4pL6B0uDo/0sLy+2sqxPT+O+sREtgo78rnM
        hXxgY36tIw/e7MH26fpP7nIO
        =HktE
        -----END PGP PRIVATE KEY BLOCK-----\n
    `,
    dedent`
        -----BEGIN PGP PRIVATE KEY BLOCK-----
        
        xUkEauMY3BtfETdGDe4dARelSgV+T0YraFnlTcznUSrOCHRipt2STwD+wv0I
        YBqtChDmGwtoxXgLFXdgRltW3k0mcTahi4IUgQzgzRBBbm90aGVyIFRlc3Qg
        S2V5wsAPBBMbCgCFBYJq4xjcAwsJBwkQwObVEZRcJlRFFAAAAAAAHAAgc2Fs
        dEBub3RhdGlvbnMub3BlbnBncGpzLm9yZ0vBFaWhAZkg8tirEey7i0xXFDKw
        nAt8RyMW7UUYgc77BRUKCA4MBBYAAgECGQECmwMCHgEWIQQWuDiiG04vkuKR
        bt/A5tURlFwmVAAA/ZC9/2d4d6Zko+NsowCBx3UsjeooBApA8sg2Klfgx0lg
        KQ0z8hmy2pzwaXGbN2cIGsfVInTHNm/MBhPEYWp2Vq4Lx0kEauMY3BklYeNL
        i4o3mukOBNFsv735hVtmpCpE4Q8b17ntofJcUgB4oFZCt9n8mDZv9q34+uY5
        hlj+0GNkQhiTS5TEvnhsRhIYwroEGBsKAHAFgmrjGNwJEMDm1RGUXCZURRQA
        AAAAABwAIHNhbHRAbm90YXRpb25zLm9wZW5wZ3Bqcy5vcmeoQkxXikl1oCZw
        N4oJw0RWIuoYJff2OniGSZcw9W6gHAKbDBYhBBa4OKIbTi+S4pFu38Dm1RGU
        XCZUAACP/sZojxJlqTbnqYE8iCSFz6DKDYqBbt/PFLadv5c0B5ILMDSpniOC
        zgmY05po0DiDf23Ag3w87MygADMv1T4/rgM=
        =LM3j
        -----END PGP PRIVATE KEY BLOCK-----\n
    `,
    dedent`
        -----BEGIN PGP PRIVATE KEY BLOCK-----
        
        xUkEauMY3BtIwvr/6pcYlnq3OjsmOZsgtoJ26T+j4KUWF9xogJxMkgD6N3eB
        oAmqvZZPMmbBFS8RUYcy/a/dMkqEA0pgW19IXw1tzRRZZXQgQW5vdGhlciBU
        ZXN0IEtlecLADwQTGwoAhQWCauMY3AMLCQcJEL4jpDk7y/E3RRQAAAAAABwA
        IHNhbHRAbm90YXRpb25zLm9wZW5wZ3Bqcy5vcmdwCoPFXrBmv3tIMPp9EWDl
        epuHz7eLQg94M6KkWDDICQUVCggODAQWAAIBAhkBApsDAh4BFiEEjgP7f+2z
        7FN6O5M0viOkOTvL8TcAAPxLvrU3eo/7zjjV9BTa+m5VE1bpHOz4sYPpVRXR
        ll5Ff97CA7OwCFfe7bfOp0KkH99XUHPEhQQg2TbGyEf0Sqo0DMdJBGrjGNwZ
        5uQm1rpyH8ZCnUH9TQ1HtoN5erb5axosgpOyjWL8omIAoLWCCaygqN2e9wMc
        YcK4/aO+R37OHrH2JYTsM+i6Q1QR98K6BBgbCgBwBYJq4xjcCRC+I6Q5O8vx
        N0UUAAAAAAAcACBzYWx0QG5vdGF0aW9ucy5vcGVucGdwanMub3JnuHQB8PKG
        ho1Cl3qHLUjWm4OmtYD3gXYEaIwYxU8iXIgCmwwWIQSOA/t/7bPsU3o7kzS+
        I6Q5O8vxNwAAB+4m8ylpGpuPdH/rk4OlRLHkQg6EwqLHpKn1Rqz6iG/zqnC3
        0qAY155UZnL6cahWNsXAHysy1asLwiNIW8q6E/0J
        =oT2J
        -----END PGP PRIVATE KEY BLOCK-----\n
    `
]

const GPG_PUBLIC_KEYS = [
    dedent`
        -----BEGIN PGP PUBLIC KEY BLOCK-----
        
        xiYEauMY3BsZk0ZOmIvgFg7YYlYfHGUa5Vr+Qd3+dEmOE2JPnfXSUM0IVGVz
        dCBLZXnCwA8EExsKAIUFgmrjGNwDCwkHCRCURNdR88ZF+kUUAAAAAAAcACBz
        YWx0QG5vdGF0aW9ucy5vcGVucGdwanMub3JnYK0aLMV//ulO947Qms4ItUsI
        HRE6cR3Dh8xT2NoDb0QFFQoIDgwEFgACAQIZAQKbAwIeARYhBJg8Zny77LGU
        2aioy5RE11HzxkX6AADN/Y9ZJjORfM6nLkm9SSmd8IQ9tpPWSf4ryBWsBbnB
        AMS45JxFGbOrOtr5C6zPvGUlbd4nP2H3MgAYZ4MsiBQTMw7OJgRq4xjcGdsP
        U36NjE0bKvqOIrvPgY7HkoUtkZD/WRjvivQIYr1AwroEGBsKAHAFgmrjGNwJ
        EJRE11HzxkX6RRQAAAAAABwAIHNhbHRAbm90YXRpb25zLm9wZW5wZ3Bqcy5v
        cmfNlj2xSAxFF8nNws0CvoaVw3URGFe92ZzlBfI12IAL6wKbDBYhBJg8Zny7
        7LGU2aioy5RE11HzxkX6AABWA7UduqDE7r3gKpTvJWTLvnz476H/ikvoHS4O
        j/SwvL7ayrE9P476xES2CjvyucyFfGBjfq0jD97swfbp+k/ucg4=
        =KXpJ
        -----END PGP PUBLIC KEY BLOCK-----\n
    `,
    dedent`
        -----BEGIN PGP PUBLIC KEY BLOCK-----
        
        xiYEauMY3BtfETdGDe4dARelSgV+T0YraFnlTcznUSrOCHRipt2ST80QQW5v
        dGhlciBUZXN0IEtlecLADwQTGwoAhQWCauMY3AMLCQcJEMDm1RGUXCZURRQA
        AAAAABwAIHNhbHRAbm90YXRpb25zLm9wZW5wZ3Bqcy5vcmdLwRWloQGZIPLY
        qxHsu4tMVxQysJwLfEcjFu1FGIHO+wUVCggODAQWAAIBAhkBApsDAh4BFiEE
        Frg4ohtOL5LikW7fwObVEZRcJlQAAP2Qvf9neHemZKPjbKMAgcd1LI3qKAQK
        QPLINipX4MdJYCkNM/IZstqc8GlxmzdnCBrH1SJ0xzZvzAYTxGFqdlauC84m
        BGrjGNwZJWHjS4uKN5rpDgTRbL+9+YVbZqQqROEPG9e57aHyXFLCugQYGwoA
        cAWCauMY3AkQwObVEZRcJlRFFAAAAAAAHAAgc2FsdEBub3RhdGlvbnMub3Bl
        bnBncGpzLm9yZ6hCTFeKSXWgJnA3ignDRFYi6hgl9/Y6eIZJlzD1bqAcApsM
        FiEEFrg4ohtOL5LikW7fwObVEZRcJlQAAI/+xmiPEmWpNuepgTyIJIXPoMoN
        ioFu388Utp2/lzQHkgswNKmeI4LOCZjTmmjQOIN/bcCDfDzszKAAMy/VPj+u
        Aw==
        =e0DS
        -----END PGP PUBLIC KEY BLOCK-----\n
    `,
    dedent`
        -----BEGIN PGP PUBLIC KEY BLOCK-----
        
        xiYEauMY3BtIwvr/6pcYlnq3OjsmOZsgtoJ26T+j4KUWF9xogJxMks0UWWV0
        IEFub3RoZXIgVGVzdCBLZXnCwA8EExsKAIUFgmrjGNwDCwkHCRC+I6Q5O8vx
        N0UUAAAAAAAcACBzYWx0QG5vdGF0aW9ucy5vcGVucGdwanMub3JncAqDxV6w
        Zr97SDD6fRFg5Xqbh8+3i0IPeDOipFgwyAkFFQoIDgwEFgACAQIZAQKbAwIe
        ARYhBI4D+3/ts+xTejuTNL4jpDk7y/E3AAD8S761N3qP+8441fQU2vpuVRNW
        6Rzs+LGD6VUV0ZZeRX/ewgOzsAhX3u23zqdCpB/fV1BzxIUEINk2xshH9Eqq
        NAzOJgRq4xjcGebkJta6ch/GQp1B/U0NR7aDeXq2+WsaLIKTso1i/KJiwroE
        GBsKAHAFgmrjGNwJEL4jpDk7y/E3RRQAAAAAABwAIHNhbHRAbm90YXRpb25z
        Lm9wZW5wZ3Bqcy5vcme4dAHw8oaGjUKXeoctSNabg6a1gPeBdgRojBjFTyJc
        iAKbDBYhBI4D+3/ts+xTejuTNL4jpDk7y/E3AAAH7ibzKWkam490f+uTg6VE
        seRCDoTCosekqfVGrPqIb/OqcLfSoBjXnlRmcvpxqFY2xcAfKzLVqwvCI0hb
        yroT/Qk=
        =b4Lc
        -----END PGP PUBLIC KEY BLOCK-----\n
    `
];

describe('Test repository keyring files', () => {
    test("Check that the file naming line is logged right before the signing key line", withLocalTmpDir(async () => {
        await createFiles({ "gpg-repo-private-key.asc": GPG_PRIVATE_KEYS[0] });
        const info = jest.spyOn(logger, "info");

        try {
            await createTestApp({
                gpg: { gpgRepoPrivateKeyFile: "gpg-repo-private-key.asc" },
                fileNaming: { caseSensitive: false, shortNames: true },
            });
            const lines = info.mock.calls.map(([line]) => String(line));
            const fileNames = lines.indexOf("File names: case-insensitive (configured), 8.3 short names on (configured), up to 240 bytes (auto)");
            expect(fileNames).toBeGreaterThanOrEqual(0);
            expect(lines[fileNames + 1]).toMatch(/^Signing repository metadata with /);
        } finally {
            info.mockRestore();
        }
    }));

    test("Check that repository GPG public key is created", withLocalTmpDir(async () => {
        await createFiles({
            "gpg-repo-private-key.asc": GPG_PRIVATE_KEYS[0],
            "repo/deb/": undefined,
            "repo/rpm/": undefined,
        })

        await createTestApp({
            paths: {
                repoDir: "repo",
            },
            gpg: {
                gpgRepoPrivateKeyFile: "gpg-repo-private-key.asc",
            },
            upload: {
                enabledApi: {
                    deb: true,
                }
            }
        });

        expect(osPath.join("repo", "deb", "archive-keyring.asc")).toPathExist();
        await expect(osPath.join("repo", "deb", "archive-keyring.asc")).toBeGpgKeyMatching(GPG_PUBLIC_KEYS[0]);

        expect(osPath.join("repo", "rpm", "RPM-GPG-KEY.asc")).toPathExist();
        await expect(osPath.join("repo", "rpm", "RPM-GPG-KEY.asc")).toBeGpgKeyMatching(GPG_PUBLIC_KEYS[0]);
    }));

    test("Check that new repository GPG private key is appended during startup", withLocalTmpDir(async () => {
        await createFiles({
            "gpg-repo-private-key.asc": GPG_PRIVATE_KEYS[1],
            "repo/deb/archive-keyring.asc": GPG_PUBLIC_KEYS[0],
            "repo/rpm/RPM-GPG-KEY.asc": GPG_PUBLIC_KEYS[0],
        })

        await createTestApp({
            paths: {
                repoDir: "repo",
            },
            gpg: {
                gpgRepoPrivateKeyFile: "gpg-repo-private-key.asc",
            },
            upload: {
                enabledApi: {
                    deb: true,
                }
            }
        });

        expect(osPath.join("repo", "deb", "archive-keyring.asc")).toPathExist();
        await expect(osPath.join("repo", "deb", "archive-keyring.asc")).toBeGpgKeyMatching(`${ GPG_PUBLIC_KEYS[1] }${ GPG_PUBLIC_KEYS[0] }`);

        expect(osPath.join("repo", "rpm", "RPM-GPG-KEY.asc")).toPathExist();
        await expect(osPath.join("repo", "rpm", "RPM-GPG-KEY.asc")).toBeGpgKeyMatching(`${ GPG_PUBLIC_KEYS[1] }${ GPG_PUBLIC_KEYS[0] }`);
    }));

    test("Check that new repository GPG private key is appended to multiple previous keys during startup", withLocalTmpDir(async () => {
        await createFiles({
            "gpg-repo-private-key.asc": GPG_PRIVATE_KEYS[2],
            "repo/deb/archive-keyring.asc": `${ GPG_PUBLIC_KEYS[1] }${ GPG_PUBLIC_KEYS[0] }`,
            "repo/rpm/RPM-GPG-KEY.asc": `${ GPG_PUBLIC_KEYS[1] }${ GPG_PUBLIC_KEYS[0] }`,
        })

        await createTestApp({
            paths: {
                repoDir: "repo",
            },
            gpg: {
                gpgRepoPrivateKeyFile: "gpg-repo-private-key.asc",
            },
            upload: {
                enabledApi: {
                    deb: true,
                }
            }
        });

        expect(osPath.join("repo", "deb", "archive-keyring.asc")).toPathExist();
        await expect(osPath.join("repo", "deb", "archive-keyring.asc")).toBeGpgKeyMatching(`${ GPG_PUBLIC_KEYS[2] }${ GPG_PUBLIC_KEYS[1] }${ GPG_PUBLIC_KEYS[0] }`);

        expect(osPath.join("repo", "rpm", "RPM-GPG-KEY.asc")).toPathExist();
        await expect(osPath.join("repo", "rpm", "RPM-GPG-KEY.asc")).toBeGpgKeyMatching(`${ GPG_PUBLIC_KEYS[2] }${ GPG_PUBLIC_KEYS[1] }${ GPG_PUBLIC_KEYS[0] }`);
    }));

    test("Check that the keyring files are served on a fresh install before any import", withLocalTmpDir(async () => {
        await createFiles({
            "gpg-repo-private-key.asc": GPG_PRIVATE_KEYS[0],
        })

        const app = await createTestApp({
            paths: {
                repoDir: "repo",
            },
            gpg: {
                gpgRepoPrivateKeyFile: "gpg-repo-private-key.asc",
            }
        });

        const deb = await request(app).get("/deb/archive-keyring.asc");
        expect(deb.status).toBe(200);
        await expect(deb.text).toBeGpgKeyMatching(GPG_PUBLIC_KEYS[0]);

        const rpm = await request(app).get("/rpm/RPM-GPG-KEY.asc");
        expect(rpm.status).toBe(200);
        await expect(rpm.text).toBeGpgKeyMatching(GPG_PUBLIC_KEYS[0]);
    }));

    test("Check that only an enabled format gets its keyring on a fresh install", withLocalTmpDir(async () => {
        await createFiles({
            "gpg-repo-private-key.asc": GPG_PRIVATE_KEYS[0],
        })

        await createTestApp({
            paths: {
                repoDir: "repo",
            },
            gpg: {
                gpgRepoPrivateKeyFile: "gpg-repo-private-key.asc",
            },
            upload: {
                enabledApi: {
                    rpm: false,
                }
            }
        });

        expect(osPath.join("repo", "deb", "archive-keyring.asc")).toPathExist();
        await expect(osPath.join("repo", "deb", "archive-keyring.asc")).toBeGpgKeyMatching(GPG_PUBLIC_KEYS[0]);
        expect(osPath.join("repo", "rpm")).not.toPathExist();
    }));

});
