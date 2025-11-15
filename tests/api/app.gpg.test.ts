// noinspection DuplicatedCode

import { createFiles, withLocalTmpDir } from "../utils.ts";
import { jest } from "@jest/globals";
import { mockExecution } from "../mocks.ts";
import assert from "node:assert";
import osPath from "path";
import dedent from "dedent";
import request from "supertest";

type CapturedState = {
    executable: string,
    args: string[],
}

afterEach(() => {
    jest.resetModules();
})

const GPG_PRIVATE_KEYS = [
    dedent`\
        -----BEGIN PGP PRIVATE KEY BLOCK-----

        lQHYBGgqWBcBBAC1MGJ7RPgMfcEqBorhFAQlBQYC+iMjeERcmFWgesgp3j+1vA4Z
        Sh2jJzOAqczZy8uJ87hnZaM9qLqw4wnA1se/L8YWIQyzLrEmke9KXDDsfYDTYSk6
        yigBjzILHF8hZWlw0/YQgH9VSclnGx5KVhZoYu8yQgxST3fPHs52uoC6pwARAQAB
        AAP7B2i4/9E6rKJ9AlLUXZuiOo20u+0IADY1r9M7RFdkLv4bfQff5bdxQQL93EGI
        eTfk4blZhygRuRg/H7OXajWXyY9JEVV1XGaFmv79d+lj3ALomT4OcIJTD4IgRb20
        4Y2cUx5UuY5na4qBxObCTz8UI9etwvAG9S4nVaMoCmvnyH0CAMyClIFqU4yt9Ml1
        7t5pV4oKoGR2FqRpR2mEJwnWzZ/VUxnnjkT0/P/+clI9jMqzlmZhKR9WIJc6y+Tl
        hy0DviUCAOLOrR+juXKwOApcmCd+aKigMABepGnghWYmzR6YaHkaRR3KixDj7MCK
        RleQX7hSnfYYzf8eggIWiR3CsHQRfdsCAMboAw1raTx5yfutXV+g2Ni8/gac0S6n
        +dnzDKZDCFb9NlY51eNg031ZGmhlE2ETAf40PtwYQ3hwb1vHbsBXc6ydObQIVGVz
        dCBLZXmI1wQTAQoAQRYhBCaRk/Z8xWafYBykDrjLOvIcqeKuBQJoKlgXAhsDBQkF
        o5qABQsJCAcCAiICBhUKCQgLAgQWAgMBAh4HAheAAAoJELjLOvIcqeKukbcD/irA
        2Oe1UQ6QTu8d5eVnbn6KGA/TLs/hCvbiuaaam7q5YLmSjxv00JzK6maTXJmUNvLr
        yI+LM3jdLnI0BBE2vMnliWRZF6g0llvBHmKZ0wYKl5e7WkapoqeadcI58MZh3ATW
        x/xb89G+SmEIxJ2U8MGoJNuZcL2ddBh08R9+gb7L
        =0u8B
        -----END PGP PRIVATE KEY BLOCK-----\n
    `,
    dedent`\
        -----BEGIN PGP PRIVATE KEY BLOCK-----

        lQHYBGgqXboBBACbeODKkV3JWiD0lw/EfiVU4COD+sxr06FgkShxeJP17tiq7j/Y
        1XuX/umfWDy9rsdeq4AqRjfP2d2GNfOL2EsjE/ByHI9fbEsy3FZbmm8+p/3nxIbh
        e8wD7Q342AyJb6v6a2fkIZYM0sr6Pm9C7XN7ecRKPpGEgCkv/CAFOUtJVwARAQAB
        AAP9Gg5SojBlpvK3djaA+n3ntMdRvHNCYknYEG6TeBzsszlhz5fZVHZG3ezna4Cm
        wWVy3V9hvfQBs5CAS1dsZ0ILKWV1oXxXj6oX0+y+wVtZFwBw/vCQ4xKTwoGm3G45
        dfD1u1QUOlITpFXWwtuOxvu4215PBMXN33JOlfzUtbqIIsECAMdlAJDDxK/PWzMF
        qQpotsnLu6FZrA4LOPUUqlt7osqdgMa73DFPARnuacvWc39m1nwHVBl5GVEMu54k
        Iu5LC8ECAMeb0YccARCo31np059FHYmcyNhf5lLBSsFPCsCgg2QMIEM+mo9mZYzm
        qd5wPgZebddgVbji1BZ2Z1oKUlnH+xcCAKwXnT2tWmmmeAtbCWBCEkT11bGAq4sr
        q+jZERntjawDb/I9Jbf0H6A2xImvKENWeHwg/Ug0wL6eWuFXbl4EY2egYLQQQW5v
        dGhlciBUZXN0IEtleYjXBBMBCgBBFiEENiSFsWiw14radiViBbFdAfjurt0FAmgq
        XboCGwMFCQWjmoAFCwkIBwICIgIGFQoJCAsCBBYCAwECHgcCF4AACgkQBbFdAfju
        rt3w4wP+OY3niIx1ysTin7nPR4fgySx59Gr1N2FxVdskOhPmLi4KIoS4UiUnWvQ+
        a125GlPgaCM04Vyzx3JuET5EPOBOXABLjfkvO+L/9QeHyxWuJddkp5JofZKM9l+I
        ErqFy0LBuRPQSaLhblLABwB++I4AxAMEPkUVZMBwXFxkeDaZ+aE=
        =zmfT
        -----END PGP PRIVATE KEY BLOCK-----\n
    `,
    dedent`\
        -----BEGIN PGP PRIVATE KEY BLOCK-----

        lQHYBGgqYrQBBADK/7j14nMsx3SOV9zLP4+DK9VFB27H5Bj5VTjdQlGj8ENN3TUu
        KkbNJ4uf5Fyorv6OieGZ1yawFy7C/q6HRJPp5JKpI4V1fuj/h9sfJzCCZM+EETt4
        aJ5QFI5rt5RJcY7EoEh+2up76Y8HttmTTJOl6jIsxOsy9zSQFSRjuVdf7QARAQAB
        AAP9GnUziHq0C79QUfgiKyx02kIViSpzliKE3cRthasN5Hndb9HXy1VPxo/zqwqS
        yBqMy4uth4VLAdL3sYsLuM4nn+4XVBPO363f+cyiEQ+XFm3hv+kqcqryNupYTmOC
        1FXAHADXQeGrc2TzGOg66+qo2x0jCU++sIb/qBHLtclCpRECANDUq5wFMnzG7ENL
        6OS7ztH9nHbzkbSVCG1J3oXrvepHHulo4TAHRYG9TjbcHIsit732PUE7vQhDWq32
        XDC0rR0CAPjZ1dgnJwvDksBVd9SI6nrzW6DVaV68hbKqNjXTQe0XU85/VEWo8MmF
        6y5e6IsgZD/BX399T92CR0oR88EOlRECALC+QpuffNDL20DiIsQ+78cNbz+RGWQJ
        zASE2mumxRKtIsHMIXfqtaDwPhE0J47xKbKIK8hBbSGl2p3h54Un2smowbQUWWV0
        IEFub3RoZXIgVGVzdCBLZXmI1wQTAQoAQRYhBKvc9UeZg3UEL7yIE9GnHz/8FxHy
        BQJoKmK0AhsDBQkFo5qABQsJCAcCAiICBhUKCQgLAgQWAgMBAh4HAheAAAoJENGn
        Hz/8FxHyMZ8EAKjv27qoqi31XnSyntKaSUh8nyvwjTiIOUhlM3gYbUMCmNou/TwQ
        6un/q/Fjrs7cxosdPJa8FoZ7TBSzwyOvU83f52tbRFr7Wr2do/1QAPcMzJfh5a0Q
        tOGwCYx9YMnk7LvQfTegeqIcDTAtd7z6Ik0zhVfSvLeC/Ax3O8wRVQ8e
        =cZwq
        -----END PGP PRIVATE KEY BLOCK-----\n
    `
]

const GPG_PUBLIC_KEYS = [
    dedent`\
        -----BEGIN PGP PUBLIC KEY BLOCK-----

        mI0EaCpYFwEEALUwYntE+Ax9wSoGiuEUBCUFBgL6IyN4RFyYVaB6yCneP7W8DhlK
        HaMnM4CpzNnLy4nzuGdloz2ourDjCcDWx78vxhYhDLMusSaR70pcMOx9gNNhKTrK
        KAGPMgscXyFlaXDT9hCAf1VJyWcbHkpWFmhi7zJCDFJPd88ezna6gLqnABEBAAG0
        CFRlc3QgS2V5iNcEEwEKAEEWIQQmkZP2fMVmn2AcpA64yzryHKnirgUCaCpYFwIb
        AwUJBaOagAULCQgHAgIiAgYVCgkICwIEFgIDAQIeBwIXgAAKCRC4yzryHKnirpG3
        A/4qwNjntVEOkE7vHeXlZ25+ihgP0y7P4Qr24rmmmpu6uWC5ko8b9NCcyupmk1yZ
        lDby68iPizN43S5yNAQRNrzJ5YlkWReoNJZbwR5imdMGCpeXu1pGqaKnmnXCOfDG
        YdwE1sf8W/PRvkphCMSdlPDBqCTbmXC9nXQYdPEffoG+yw==
        =r7zi
        -----END PGP PUBLIC KEY BLOCK-----\n
    `,
    dedent`\
        -----BEGIN PGP PUBLIC KEY BLOCK-----

        mI0EaCpdugEEAJt44MqRXclaIPSXD8R+JVTgI4P6zGvToWCRKHF4k/Xu2KruP9jV
        e5f+6Z9YPL2ux16rgCpGN8/Z3YY184vYSyMT8HIcj19sSzLcVluabz6n/efEhuF7
        zAPtDfjYDIlvq/prZ+QhlgzSyvo+b0Ltc3t5xEo+kYSAKS/8IAU5S0lXABEBAAG0
        EEFub3RoZXIgVGVzdCBLZXmI1wQTAQoAQRYhBDYkhbFosNeK2nYlYgWxXQH47q7d
        BQJoKl26AhsDBQkFo5qABQsJCAcCAiICBhUKCQgLAgQWAgMBAh4HAheAAAoJEAWx
        XQH47q7d8OMD/jmN54iMdcrE4p+5z0eH4MksefRq9TdhcVXbJDoT5i4uCiKEuFIl
        J1r0PmtduRpT4GgjNOFcs8dybhE+RDzgTlwAS435Lzvi//UHh8sVriXXZKeSaH2S
        jPZfiBK6hctCwbkT0Emi4W5SwAcAfviOAMQDBD5FFWTAcFxcZHg2mfmh
        =GBBu
        -----END PGP PUBLIC KEY BLOCK-----\n
    `,
    dedent`\
        -----BEGIN PGP PUBLIC KEY BLOCK-----

        mI0EaCpitAEEAMr/uPXicyzHdI5X3Ms/j4Mr1UUHbsfkGPlVON1CUaPwQ03dNS4q
        Rs0ni5/kXKiu/o6J4ZnXJrAXLsL+rodEk+nkkqkjhXV+6P+H2x8nMIJkz4QRO3ho
        nlAUjmu3lElxjsSgSH7a6nvpjwe22ZNMk6XqMizE6zL3NJAVJGO5V1/tABEBAAG0
        FFlldCBBbm90aGVyIFRlc3QgS2V5iNcEEwEKAEEWIQSr3PVHmYN1BC+8iBPRpx8/
        /BcR8gUCaCpitAIbAwUJBaOagAULCQgHAgIiAgYVCgkICwIEFgIDAQIeBwIXgAAK
        CRDRpx8//BcR8jGfBACo79u6qKot9V50sp7SmklIfJ8r8I04iDlIZTN4GG1DApja
        Lv08EOrp/6vxY67O3MaLHTyWvBaGe0wUs8Mjr1PN3+drW0Ra+1q9naP9UAD3DMyX
        4eWtELThsAmMfWDJ5Oy70H03oHqiHA0wLXe8+iJNM4VX0ry3gvwMdzvMEVUPHg==
        =CHVq
        -----END PGP PUBLIC KEY BLOCK-----\n
    `
];

describe('Test initial GPG import', () => {
    test('Check that GPG file is imported during startup', withLocalTmpDir(async () => {
        const spawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            spawn.push({ executable, args });
        });

        await createFiles({
            "gpg-public-keys.asc": "",
            "repo/deb/": undefined,
            "repo/rpm/": undefined,
        })

        const createTestApp = (await import("../testapp.ts")).default;
        await createTestApp({
            paths: {
                repoDir: "repo",
            },
            gpg: {
                gpgPublicKeysFile: "gpg-public-keys.asc",
            }
        });

        expect(spawn).toHaveLength(1);
        expect(spawn[0].executable).toBe("gpg");
        expect(spawn[0].args).toContain("gpg-public-keys.asc");
    }));

    test('Check that GPG file is not imported when missing', withLocalTmpDir(async () => {
        let spawn: CapturedState | undefined;

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            if (!spawn) {
                spawn = { executable, args };
            }
        });

        await createFiles({
            "repo/deb/": undefined,
            "repo/rpm/": undefined,
        })

        const createTestApp = (await import("../testapp.ts")).default;
        await createTestApp({
            paths: {
                repoDir: "repo",
            },
            gpg: {
                gpgPublicKeysFile: "gpg-public-keys.asc",
            }
        });

        expect(spawn).not.toBeDefined();
    }));

    test('Check that files from GPG directory are imported during startup', withLocalTmpDir(async () => {
        const spawns: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            spawns.push({ executable, args });
        });

        await createFiles({
            "gpg/gpg-public-key-1.asc": "",
            "gpg/gpg-public-key-2.asc": "",
            "repo/deb/": undefined,
            "repo/rpm/": undefined,
        })

        const createTestApp = (await import("../testapp.ts")).default;
        await createTestApp({
            paths: {
                repoDir: "repo",
            },
            gpg: {
                gpgPublicKeysDir: "gpg",
            }
        });

        expect(spawns).toHaveLength(2);
        expect(spawns.map(s => s.executable)).toEqual(["gpg", "gpg"]);
        expect(spawns.map(s => s.args)).toSatisfyAny((a: string[]) => a.includes(osPath.join("gpg", "gpg-public-key-1.asc")));
        expect(spawns.map(s => s.args)).toSatisfyAny((a: string[]) => a.includes(osPath.join("gpg", "gpg-public-key-2.asc")));
    }));

    test("Check that repository GPG private key is imported during startup", withLocalTmpDir(async () => {
        let spawn: CapturedState | undefined;

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            if (!spawn) {
                spawn = { executable, args };
            }
        });

        await createFiles({
            "gpg-repo-private-key.asc": GPG_PRIVATE_KEYS[0],
            "repo/deb/": undefined,
            "repo/rpm/": undefined,
        })

        const createTestApp = (await import("../testapp.ts")).default;
        await createTestApp({
            paths: {
                repoDir: "repo",
            },
            gpg: {
                gpgBin: "gpg",
                gpgRepoPrivateKeyFile: "gpg-repo-private-key.asc",
            },
            upload: {
                enabledApi: {
                    deb: true,
                }
            }
        });

        expect(spawn).toBeDefined();
        assert(spawn);
        expect(spawn.executable).toBe("gpg");
        expect(spawn.args).toContain(osPath.join("repo", "deb", "archive-keyring.asc"));
    }));

    test("Check that repository GPG public key is created", withLocalTmpDir(async () => {
        mockExecution(0, "stdout data", "", undefined);

        await createFiles({
            "gpg-repo-private-key.asc": GPG_PRIVATE_KEYS[0],
            "repo/deb/": undefined,
            "repo/rpm/": undefined,
        })

        const createTestApp = (await import("../testapp.ts")).default;
        await createTestApp({
            paths: {
                repoDir: "repo",
            },
            gpg: {
                gpgBin: "gpg",
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

    test('Check that GPG is imported and repository public key is created when Debian repository is built', withLocalTmpDir(async () => {
        const spawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            spawn.push({ executable, args });
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoStateDir: "repo-state",
                repoDir: "repo",
                signScript: "sign.sh"
            },
            gpg: {
                gpgBin: "gpg",
                gpgPublicKeysDir: "gpg",
                gpgPublicKeysFile: "gpg-public-keys.asc",
                gpgRepoPrivateKeyFile: "gpg-repo-private-key.asc",
            }
        });

        await createFiles({
            "gpg-public-keys.asc": "",
            "gpg-repo-private-key.asc": GPG_PRIVATE_KEYS[0],
            "gpg/gpg-public-key-1.asc": "",
            "gpg/gpg-public-key-2.asc": "",
            "incoming/staging/deb/debian/bookworm/main/test.changes": dedent`
                Architecture: source amd64\n
            `
        })

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(200);

        expect(spawn).toHaveLength(7);
        expect(spawn.map(s => s.executable)).toEqual(["gpg", "gpg", "gpg", "gpg", "reprepro", "reprepro", "reprepro"]);

        // Check GPG import
        expect(spawn.slice(0, 4).map(s => s.args)).toSatisfyAny((a: string[]) => a.includes(osPath.join("repo", "deb", "archive-keyring.asc")));
        expect(spawn.slice(0, 4).map(s => s.args)).toSatisfyAny((a: string[]) => a.includes(osPath.join("gpg-public-keys.asc")));
        expect(spawn.slice(0, 4).map(s => s.args)).toSatisfyAny((a: string[]) => a.includes(osPath.join("gpg", "gpg-public-key-1.asc")));
        expect(spawn.slice(0, 4).map(s => s.args)).toSatisfyAny((a: string[]) => a.includes(osPath.join("gpg", "gpg-public-key-2.asc")));

        // Check repository GPG key creation
        expect(osPath.join("repo", "rpm", "RPM-GPG-KEY.asc")).not.toPathExist();
        expect(osPath.join("repo", "deb", "archive-keyring.asc")).toPathExist();
        await expect(osPath.join("repo", "deb", "archive-keyring.asc")).toBeGpgKeyMatching(GPG_PUBLIC_KEYS[0]);
    }));

    test('Check that repository GPG public key is created when RedHat repository is built', withLocalTmpDir(async () => {
        const spawn: CapturedState[] = [];

        mockExecution(0, "stdout data", "", undefined, async (executable: string, args: string[]) => {
            spawn.push({ executable, args });
        });

        const createTestApp = (await import("../testapp.ts")).default;
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repoDir: "repo",
                createrepoScript: "createrepo.sh",
                signScript: "sign.sh"
            },
            gpg: {
                gpgBin: "gpg",
                gpgPublicKeysDir: "gpg",
                gpgPublicKeysFile: "gpg-public-keys.asc",
                gpgRepoPrivateKeyFile: "gpg-repo-private-key.asc",
            }
        });

        await createFiles({
            "gpg-public-keys.asc": "",
            "gpg-repo-private-key.asc": GPG_PRIVATE_KEYS[0],
            "gpg/gpg-public-key-1.asc": "",
            "gpg/gpg-public-key-2.asc": "",
            "incoming/staging/rpm/fedora/41/test.rpm": ""
        })

        const res = await request(app).post("/upload/build-repo");
        expect(res.status).toBe(200);

        expect(spawn).toHaveLength(1);
        expect(spawn[0].executable).toEqual("createrepo.sh");

        // Check repository GPG key creation
        expect(osPath.join("repo", "deb", "archive-keyring.asc")).not.toPathExist();
        expect(osPath.join("repo", "rpm", "RPM-GPG-KEY.asc")).toPathExist();
        await expect(osPath.join("repo", "rpm", "RPM-GPG-KEY.asc")).toBeGpgKeyMatching(GPG_PUBLIC_KEYS[0]);
    }));

    test("Check that new repository GPG private key is appended during startup", withLocalTmpDir(async () => {
        mockExecution(0, "stdout data", "", undefined);

        await createFiles({
            "gpg-repo-private-key.asc": GPG_PRIVATE_KEYS[1],
            "repo/deb/archive-keyring.asc": GPG_PUBLIC_KEYS[0],
            "repo/rpm/RPM-GPG-KEY.asc": GPG_PUBLIC_KEYS[0],
        })

        const createTestApp = (await import("../testapp.ts")).default;
        await createTestApp({
            paths: {
                repoDir: "repo",
            },
            gpg: {
                gpgBin: "gpg",
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
        mockExecution(0, "stdout data", "", undefined);

        await createFiles({
            "gpg-repo-private-key.asc": GPG_PRIVATE_KEYS[2],
            "repo/deb/archive-keyring.asc": `${ GPG_PUBLIC_KEYS[1] }${ GPG_PUBLIC_KEYS[0] }`,
            "repo/rpm/RPM-GPG-KEY.asc": `${ GPG_PUBLIC_KEYS[1] }${ GPG_PUBLIC_KEYS[0] }`,
        })

        const createTestApp = (await import("../testapp.ts")).default;
        await createTestApp({
            paths: {
                repoDir: "repo",
            },
            gpg: {
                gpgBin: "gpg",
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

});
