import { createFiles, withLocalTmpDir } from "../utils.ts";
import { jest } from "@jest/globals";
import dns from "node:dns/promises";

const env = { ...process.env };

afterEach(() => {
    process.env = { ...env };
    jest.resetModules();
});

describe("Test environment variables and config.ts", () => {
    test("Check production defaults", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.paths.incomingDir).toEqual("data/incoming");
        expect(config.app.paths.repoStateDir).toEqual("data/repo-state");
        expect(config.app.paths.repoDir).toEqual("data/repo");
        expect(config.app.gpg.gpgRepoPrivateKeyFile).not.toBeDefined();
        expect(config.app.upload.allowedIps).not.toBeDefined();
        expect(config.app.upload.basicAuth).not.toBeDefined();
        expect(config.app.upload.sizeLimit).not.toBeDefined();
        expect(config.app.upload.postField).toEqual("package");
        expect(config.http.serverOptions.ports).toEqual([3000]);
        expect(config.http.serverOptions.hosts).toBeEmpty();
        expect(config.http.serverOptions.addresses).toEqual([null]);
        expect(config.http.serverOptions.key).not.toBeDefined();
        expect(config.http.serverOptions.cert).not.toBeDefined();
        expect(config.http.secure).toBeFalse();
    }));

    test("Check tilde expansion in paths", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.INCOMING_DIR = "~/incoming";
        process.env.REPO_STATE_DIR = "~/repo-state";
        process.env.REPO_DIR = "~/repo";
        process.env.GPG_REPO_PRIVATE_KEY_FILE = "~/private.key";

        await createFiles({
            "home/private.key": "",
        });

        jest.unstable_mockModule("untildify", () => ({
            __esModule: true,
            default: jest.fn((path: string) => path.replace(/^~/, "home")),
        }));

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.paths.incomingDir).toEqual("home/incoming");
        expect(config.app.paths.repoStateDir).toEqual("home/repo-state");
        expect(config.app.paths.repoDir).toEqual("home/repo");
        expect(config.app.gpg.gpgRepoPrivateKeyFile).toEqual("home/private.key");
    }));

    test("Check that environment is set correctly", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "development";

        const { default: config } = await import("../../server/lib/config.ts");
        expect(config.environment).toEqual("development");
    }));

    test("Check custom paths configuration", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.INCOMING_DIR = "custom/incoming";
        process.env.REPO_STATE_DIR = "custom/repo-state";
        process.env.REPO_DIR = "custom/repo";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.paths.incomingDir).toEqual("custom/incoming");
        expect(config.app.paths.repoStateDir).toEqual("custom/repo-state");
        expect(config.app.paths.repoDir).toEqual("custom/repo");
    }));

    test("Legacy tool variables only warn", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        for (const name of ["REPREPRO_BIN", "CREATEREPO_SCRIPT", "GPG_BIN", "SIGN_SCRIPT", "GPG_PUBLIC_KEYS_FILE",
            "GPG_PUBLIC_KEYS_DIR", "GNUPGHOME"]) {
            delete process.env[name];
        }
        process.env.REPREPRO_BIN = "custom/bin";
        process.env.GNUPGHOME = "custom/gnupg";

        const { default: logger } = await import("../../server/lib/logger.ts");
        const warnSpy = jest.spyOn(logger, "warn");
        await import("../../server/lib/config.ts");

        expect(warnSpy.mock.calls.map(([message]) => message)).toEqual([
            "Deprecated REPREPRO_BIN is set but no longer used; please remove it from the environment",
            "Deprecated GNUPGHOME is set but no longer used; please remove it from the environment",
        ]);
    }));

    test("Reads where the keys that verify uploads are", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.GPG_PUBLIC_KEYS_FILE = "keys.asc";
        process.env.GPG_PUBLIC_KEYS_DIR = "keys";

        const { default: logger } = await import("../../server/lib/logger.ts");
        const warnSpy = jest.spyOn(logger, "warn");
        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.app.gpg.gpgPublicKeysFile).toEqual("keys.asc");
        expect(config.app.gpg.gpgPublicKeysDir).toEqual("keys");
        expect(warnSpy).not.toHaveBeenCalled();
    }));

    test("Check trusted proxy IP for single address", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.TRUST_PROXY = "127.1.2.3";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.security.trustProxy).toBeDefined();
        expect(config.app.security.trustProxy!("127.1.2.3")).toBeTrue();
        expect(config.app.security.trustProxy!("127.5.5.5")).toBeFalse();
    }));

    test("Check trusted proxy IP for multiple addresses", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.TRUST_PROXY = "127.1.2.3,192.168.1.0/24";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.security.trustProxy).toBeDefined();
        expect(config.app.security.trustProxy!("127.1.2.3")).toBeTrue();
        expect(config.app.security.trustProxy!("192.168.1.2")).toBeTrue();
        expect(config.app.security.trustProxy!("127.5.5.5")).toBeFalse();
        expect(config.app.security.trustProxy!("192.168.2.1")).toBeFalse();
    }));

    test("Check basic auth credentials parsing", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_BASIC_AUTH = "user1:pass1";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.basicAuth).toBeDefined();
        expect(config.app.upload.basicAuth).toEqual(["user1:pass1"]);
    }));

    test("Check basic auth multiple credentials parsing", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_BASIC_AUTH = "user1:pass1,user2:pass2";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.basicAuth).toBeDefined();
        expect(config.app.upload.basicAuth).toEqual(["user1:pass1", "user2:pass2"]);
    }));

    test("Check basic auth multiple credentials parsing with spaces", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_BASIC_AUTH = " user1:pass1 , user2:pass2, user3:pass me ";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.basicAuth).toBeDefined();
        expect(config.app.upload.basicAuth).toEqual(["user1:pass1", "user2:pass2", "user3:pass me"]);
    }));

    test("Check basic auth with empty definition containing just comma", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_BASIC_AUTH = ",";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.basicAuth).not.toBeDefined();
    }));

    test("Check basic auth dictionary-like multiple credentials parsing", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_BASIC_AUTH = "{user1:pass1, user2:pass2}";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.basicAuth).toBeDefined();
        expect(config.app.upload.basicAuth).toEqual(["user1:pass1", "user2:pass2"]);
    }));

    test("Check basic auth dictionary-like parsing with errors", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_BASIC_AUTH = '{upload:"my \\"secret:,password\\\\;", "upload 2":"other password", upload 3: third password}';

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.basicAuth).toBeDefined();
        expect(config.app.upload.basicAuth).toEqual([
            'upload:my "secret:,password\\;',
            "upload 2:other password",
            "upload 3:third password",
        ]);
    }));

    test("Check basic auth dictionary-like multiple credentials parsing with special characters", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_BASIC_AUTH = '{user1:"pass with \\"specials:@#$%^&*()[]", "user 2": pass2}';

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.basicAuth).toBeDefined();
        expect(config.app.upload.basicAuth).toEqual(["user1:pass with \"specials:@#$%^&*()[]", "user 2:pass2"]);
    }));

    test("Check basic auth with empty dictionary-like config", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_BASIC_AUTH = "{}";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.basicAuth).not.toBeDefined();
    }));

    test("Check allowed IPs for single address", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_ALLOWED_IPS = "127.1.2.3";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.allowedIps).toBeDefined();
        expect(config.app.upload.allowedIps!("127.1.2.3")).toBeTrue();
        expect(config.app.upload.allowedIps!("127.5.5.5")).toBeFalse();
    }));

    test("Check allowed IPs for multiple addresses", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_ALLOWED_IPS = "127.1.2.3,192.168.1.0/24";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.allowedIps).toBeDefined();
        expect(config.app.upload.allowedIps!("127.1.2.3")).toBeTrue();
        expect(config.app.upload.allowedIps!("192.168.1.2")).toBeTrue();
        expect(config.app.upload.allowedIps!("127.5.5.5")).toBeFalse();
        expect(config.app.upload.allowedIps!("192.168.2.1")).toBeFalse();
    }));

    test("API_PUBLIC_READ=true enables public reads", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.API_PUBLIC_READ = "true";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.app.upload.publicRead).toBeTrue();
    }));

    test("API_PUBLIC_READ=1 enables public reads", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.API_PUBLIC_READ = "1";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.app.upload.publicRead).toBeTrue();
    }));

    test("Public reads are off when API_PUBLIC_READ is not set", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        delete process.env.API_PUBLIC_READ;

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.app.upload.publicRead).toBeFalse();
    }));

    test("Other API_PUBLIC_READ values keep public reads off", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.API_PUBLIC_READ = "yes";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.app.upload.publicRead).toBeFalse();
    }));

    test("Check upload size limit configuration", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_SIZE_LIMIT = "1000";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.sizeLimit).toEqual(1000);
    }));

    test("Check upload post field configuration", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_POST_FIELD = "custom-field";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.postField).toEqual("custom-field");
    }));

    test("Check development environment HTTPS certificate creation", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "development";
        process.env.HTTPS_CERT_FILE = "certs/cert.pem";
        process.env.HTTPS_KEY_FILE = "certs/key.pem";

        jest.unstable_mockModule("selfsigned", () => ({
            generate: jest.fn(() => ({
                private: "private key",
                cert: "public certificate"
            }))
        }));

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("development");
        expect(process.env.HTTPS_KEY_FILE).toPathExist();
        expect(config.http.serverOptions.key).toEqual(Buffer.from("private key", "utf8"));
        expect(process.env.HTTPS_CERT_FILE).toPathExist();
        expect(config.http.serverOptions.cert).toEqual(Buffer.from("public certificate", "utf8"));
    }));

    test("Check production environment HTTPS certificates check", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.HTTPS_CERT_FILE = "certs/cert.pem";
        process.env.HTTPS_KEY_FILE = "certs/key.pem";

        const { default: logger } = await import("../../server/lib/logger.ts");
        const errorSpy = jest.spyOn(logger, "error").mockReturnValue(logger);
        const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
            throw new Error(`process.exit(${ code })`);
        });
        try {
            await expect(import("../../server/lib/config.ts")).rejects.toThrow("process.exit(1)");
            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringMatching(/^HTTPS key file .*key\.pem is not readable for .*: ENOENT$/));
        } finally {
            exitSpy.mockRestore();
            errorSpy.mockRestore();
        }
    }));

    test("Check public URL configuration", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.PUBLIC_URL = "https://repo.example.com/packages";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.app.publicUrl?.href).toEqual("https://repo.example.com/packages");
    }));

    test("Check that invalid public URL stops the server", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.PUBLIC_URL = "https://repo.example.com/?query";

        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
            throw new Error(`process.exit(${ code })`);
        });
        try {
            await expect(import("../../server/lib/config.ts")).rejects.toThrow("process.exit(1)");
            expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^PUBLIC_URL must be .*\?query$/));
        } finally {
            exitSpy.mockRestore();
            errorSpy.mockRestore();
        }
    }));

    test("Check that the file naming settings default to auto", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.app.fileNaming).toEqual({ caseSensitive: "auto", shortNames: "auto" });
    }));

    describe.each([["REPO_CASE_SENSITIVE", "caseSensitive"], ["REPO_SHORT_NAMES", "shortNames"]] as const)("Check %s", (name, field) => {
        test.each<[string, boolean | "auto"]>([["auto", "auto"], ["true", true], ["false", false], [" true ", true], ["", "auto"], ["  ", "auto"]])("%j is taken as %j", (value, expected) => withLocalTmpDir(async () => {
            process.env.NODE_ENV = "production";
            process.env[name] = value;

            const { default: config } = await import("../../server/lib/config.ts");

            expect(config.app.fileNaming).toEqual({ caseSensitive: "auto", shortNames: "auto", [field]: expected });
        })());

        test.each(["yes", "no", "TRUE", "Auto", "1", "0", "on"])("%j stops the server", value => withLocalTmpDir(async () => {
            process.env.NODE_ENV = "production";
            process.env[name] = value;

            const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
            const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
                throw new Error(`process.exit(${ code })`);
            });
            try {
                await expect(import("../../server/lib/config.ts")).rejects.toThrow("process.exit(1)");
                expect(errorSpy).toHaveBeenCalledWith(`${ name } must be auto, true or false: ${ value }`);
            } finally {
                exitSpy.mockRestore();
                errorSpy.mockRestore();
            }
        })());
    });

    test("Check that host name is translated to IP", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.HTTP_HOST = "one.example.com, two.example.com";
        process.env.HTTP_PORT = "80, 8080";

        // @ts-expect-error one particular implementation
        jest.spyOn(dns, "lookup").mockImplementation((hostname: string) => {
            switch (hostname) {
                case "one.example.com":
                    return Promise.resolve([{ address: "127.1.1.1", family: 4 }]);
                case "two.example.com":
                    return Promise.resolve([{ address: "127.2.2.2", family: 4 }]);
                default:
                    return Promise.reject(new Error("Unknown host"));
            }
        });

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.http.serverOptions.ports).toEqual([80, 8080]);
        expect(config.http.serverOptions.hosts).toEqual(["one.example.com", "two.example.com"]);
        expect(config.http.serverOptions.addresses).toEqual(["127.1.1.1", "127.2.2.2"]);
    }));

    test("instanceLabel is undefined when INSTANCE_LABEL is not set", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        delete process.env.INSTANCE_LABEL;

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.app.instanceLabel).toBeUndefined();
    }));

    test("instanceLabel is parsed from INSTANCE_LABEL", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.INSTANCE_LABEL = "Home repository";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.app.instanceLabel).toEqual("Home repository");
    }));

    test("instanceLabel trims whitespace", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.INSTANCE_LABEL = "  Home repository  ";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.app.instanceLabel).toEqual("Home repository");
    }));

    test("instanceLabel is undefined when INSTANCE_LABEL is whitespace only", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.INSTANCE_LABEL = "   ";

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.app.instanceLabel).toBeUndefined();
    }));
})
