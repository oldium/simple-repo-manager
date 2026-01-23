import { createFiles, withLocalTmpDir } from "../utils.ts";
import { jest } from "@jest/globals";
import osPath from "path";
import dns from "node:dns/promises";
import { mockExecution, spawnMock } from "../mocks.ts";

const env = { ...process.env };

afterEach(() => {
    process.env = { ...env };
    jest.resetModules();
});

describe("Test environment variables and config.ts", () => {
    test("Check production defaults", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.paths.incomingDir).toEqual("data/incoming");
        expect(config.app.paths.repoStateDir).toEqual("data/repo-state");
        expect(config.app.paths.repoDir).toEqual("data/repo");
        expect(config.app.paths.signScript).not.toBeDefined();
        expect(config.app.paths.createrepoScript).toEqual(osPath.join("scripts", "createrepo.sh"));
        expect(config.app.paths.repreproBin).toEqual("reprepro");
        expect(config.app.gpg.gpgBin).toEqual("gpg");
        expect(config.app.gpg.gpgPublicKeysFile).not.toBeDefined();
        expect(config.app.gpg.gpgPublicKeysDir).not.toBeDefined();
        expect(config.app.gpg.gpgRepoPrivateKeyFile).not.toBeDefined();
        expect(config.app.upload.enabledApi.deb).toEqual(true);
        expect(config.app.upload.enabledApi.rpm).toEqual(true);
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
        process.env.GPG_BIN = "~/gpg";
        process.env.GPG_REPO_PRIVATE_KEY_FILE = "~/private.key";
        process.env.GPG_PUBLIC_KEYS_FILE = "~/public.key";
        process.env.GPG_PUBLIC_KEYS_DIR = "~/public-keys";
        process.env.SIGN_SCRIPT = "~/sign.sh";
        process.env.CREATEREPO_SCRIPT = "~/createrepo.sh";
        process.env.REPREPRO_BIN = "~/reprepro";

        await createFiles({
            "home/private.key": "",
        });

        jest.unstable_mockModule("untildify", () => ({
            __esModule: true,
            default: jest.fn((path: string) => path.replace(/^~/, "home")),
        }));

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.paths.incomingDir).toEqual("home/incoming");
        expect(config.app.paths.repoStateDir).toEqual("home/repo-state");
        expect(config.app.paths.repoDir).toEqual("home/repo");
        expect(config.app.gpg.gpgBin).toEqual("home/gpg");
        expect(config.app.gpg.gpgRepoPrivateKeyFile).toEqual("home/private.key");
        expect(config.app.gpg.gpgPublicKeysFile).toEqual("home/public.key");
        expect(config.app.gpg.gpgPublicKeysDir).toEqual("home/public-keys");
        expect(config.app.paths.signScript).toEqual("home/sign.sh");
        expect(config.app.paths.createrepoScript).toEqual("home/createrepo.sh");
        expect(config.app.paths.repreproBin).toEqual("home/reprepro");
    }));

    test("Check that environment is set correctly", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "development";

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");
        expect(config.environment).toEqual("development");
    }));

    test("Check custom paths configuration", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.INCOMING_DIR = "custom/incoming";
        process.env.REPO_STATE_DIR = "custom/repo-state";
        process.env.REPO_DIR = "custom/repo";
        process.env.CREATEREPO_SCRIPT = "custom/createrepo.sh";
        process.env.REPREPRO_BIN = "custom/reprepro";
        process.env.GPG_BIN = "custom/gpg";
        process.env.GPG_PUBLIC_KEYS_FILE = "custom/public.key";
        process.env.GPG_PUBLIC_KEYS_DIR = "custom/public-keys";

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.paths.incomingDir).toEqual("custom/incoming");
        expect(config.app.paths.repoStateDir).toEqual("custom/repo-state");
        expect(config.app.paths.repoDir).toEqual("custom/repo");
        expect(config.app.paths.createrepoScript).toEqual("custom/createrepo.sh");
        expect(config.app.paths.repreproBin).toEqual("custom/reprepro");
        expect(config.app.gpg.gpgBin).toEqual("custom/gpg");
        expect(config.app.gpg.gpgPublicKeysFile).toEqual("custom/public.key");
        expect(config.app.gpg.gpgPublicKeysDir).toEqual("custom/public-keys");
    }));

    test("Check private key and sign script configuration", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.GPG_REPO_PRIVATE_KEY_FILE = "custom/private.key";
        process.env.SIGN_SCRIPT = "custom/sign.sh";

        await createFiles({
            "custom/private.key": "",
        })

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.gpg.gpgRepoPrivateKeyFile).toEqual("custom/private.key");
        expect(config.app.paths.signScript).toEqual("custom/sign.sh");
    }));

    test("Check private key and default sign script configuration", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.GPG_REPO_PRIVATE_KEY_FILE = "custom/private.key";

        await createFiles({
            "custom/private.key": "",
        })

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.gpg.gpgRepoPrivateKeyFile).toEqual("custom/private.key");
        expect(config.app.paths.signScript).toEqual(osPath.join("scripts", "sign.sh"));
    }));

    test("Check unset createrepo wrapper script handling", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.CREATEREPO_SCRIPT = "";

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.paths.createrepoScript).toBeNil();
        expect(config.app.upload.enabledApi.rpm).toBeFalse();
        expect(config.app.paths.repreproBin).toEqual("reprepro");
        expect(config.app.upload.enabledApi.deb).toBeTrue();
    }));

    test("Check missing createrepo wrapper script handling", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.CREATEREPO_SCRIPT = "custom/createrepo.sh";

        const spawn = mockExecution(0, "stdout data", "", undefined);
        spawn.mockImplementationOnce(spawnMock(1, "", "not found", undefined));

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.paths.createrepoScript).toBeNil();
        expect(config.app.upload.enabledApi.rpm).toBeFalse();
    }));

    test("Check unset reprepro bin handling", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.REPREPRO_BIN = "";

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.paths.createrepoScript).toEqual(osPath.join("scripts", "createrepo.sh"));
        expect(config.app.upload.enabledApi.rpm).toBeTrue();
        expect(config.app.paths.repreproBin).toBeNil();
        expect(config.app.upload.enabledApi.deb).toBeFalse();
    }));

    test("Check missing reprepro bin handling", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.REPREPRO_BIN = "custom/reprepro";

        const spawn = mockExecution(0, "stdout data", "", undefined);
        spawn.mockImplementationOnce(spawnMock(0, "", "stdout data", undefined));
        spawn.mockImplementationOnce(spawnMock(1, "", "not found", undefined));

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.paths.createrepoScript).toEqual(osPath.join("scripts", "createrepo.sh"));
        expect(config.app.upload.enabledApi.rpm).toBeTrue();
        expect(config.app.paths.repreproBin).toBeNil();
        expect(config.app.upload.enabledApi.deb).toBeFalse();
    }));

    test("Check unset gpg bin handling", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.GPG_BIN = "";

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.gpg.gpgBin).toBeNil();
    }));

    test("Check missing gpg bin handling", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.GPG_BIN = "custom/gpg";

        const spawn = mockExecution(0, "stdout data", "", undefined);
        spawn.mockImplementationOnce(spawnMock(0, "", "stdout data", undefined));
        spawn.mockImplementationOnce(spawnMock(0, "", "stdout data", undefined));
        spawn.mockImplementationOnce(spawnMock(1, "", "not found", undefined));

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.gpg.gpgBin).toBeNil();
    }));

    test("Check trusted proxy IP for single address", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.TRUST_PROXY = "127.1.2.3";

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.security.trustProxy).toBeDefined();
        expect(config.app.security.trustProxy!("127.1.2.3")).toBeTrue();
        expect(config.app.security.trustProxy!("127.5.5.5")).toBeFalse();
    }));

    test("Check trusted proxy IP for multiple addresses", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.TRUST_PROXY = "127.1.2.3,192.168.1.0/24";

        mockExecution(0, "stdout data", "", undefined);

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

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.basicAuth).toBeDefined();
        expect(config.app.upload.basicAuth).toEqual(["user1:pass1"]);
    }));

    test("Check basic auth multiple credentials parsing", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_BASIC_AUTH = "user1:pass1,user2:pass2";

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.basicAuth).toBeDefined();
        expect(config.app.upload.basicAuth).toEqual(["user1:pass1", "user2:pass2"]);
    }));

    test("Check basic auth multiple credentials parsing with spaces", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_BASIC_AUTH = " user1:pass1 , user2:pass2, user3:pass me ";

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.basicAuth).toBeDefined();
        expect(config.app.upload.basicAuth).toEqual(["user1:pass1", "user2:pass2", "user3:pass me"]);
    }));

    test("Check basic auth with empty definition containing just comma", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_BASIC_AUTH = ",";

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.basicAuth).not.toBeDefined();
    }));

    test("Check basic auth dictionary-like multiple credentials parsing", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_BASIC_AUTH = "{user1:pass1, user2:pass2}";

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.basicAuth).toBeDefined();
        expect(config.app.upload.basicAuth).toEqual(["user1:pass1", "user2:pass2"]);
    }));

    test("Check basic auth dictionary-like parsing with errors", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_BASIC_AUTH = '{upload:"my \\"secret:,password\\\\;", "upload 2":"other password", upload 3: third password}';

        mockExecution(0, "stdout data", "", undefined);

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

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.basicAuth).toBeDefined();
        expect(config.app.upload.basicAuth).toEqual(["user1:pass with \"specials:@#$%^&*()[]", "user 2:pass2"]);
    }));

    test("Check basic auth with empty dictionary-like config", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_BASIC_AUTH = "{}";

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.basicAuth).not.toBeDefined();
    }));

    test("Check allowed IPs for single address", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_ALLOWED_IPS = "127.1.2.3";

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.allowedIps).toBeDefined();
        expect(config.app.upload.allowedIps!("127.1.2.3")).toBeTrue();
        expect(config.app.upload.allowedIps!("127.5.5.5")).toBeFalse();
    }));

    test("Check allowed IPs for multiple addresses", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_ALLOWED_IPS = "127.1.2.3,192.168.1.0/24";

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.allowedIps).toBeDefined();
        expect(config.app.upload.allowedIps!("127.1.2.3")).toBeTrue();
        expect(config.app.upload.allowedIps!("192.168.1.2")).toBeTrue();
        expect(config.app.upload.allowedIps!("127.5.5.5")).toBeFalse();
        expect(config.app.upload.allowedIps!("192.168.2.1")).toBeFalse();
    }));

    test("Check upload size limit configuration", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_SIZE_LIMIT = "1000";

        mockExecution(0, "stdout data", "", undefined);

        const { default: config } = await import("../../server/lib/config.ts");

        expect(config.environment).toEqual("production");
        expect(config.app.upload.sizeLimit).toEqual(1000);
    }));

    test("Check upload post field configuration", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.UPLOAD_POST_FIELD = "custom-field";

        mockExecution(0, "stdout data", "", undefined);

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

        mockExecution(0, "stdout data", "", undefined);

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

        mockExecution(0, "stdout data", "", undefined);

        try {
            await import("../../server/lib/config.ts");
            fail("Should have thrown an error");
        } catch (err) {
            expect(err).toBeInstanceOf(Error);
            expect((err as Error).code).toEqual("ENOENT");
        }
    }));

    test("Check that host name is translated to IP", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "production";
        process.env.HTTP_HOST = "one.example.com, two.example.com";
        process.env.HTTP_PORT = "80, 8080";

        mockExecution(0, "stdout data", "", undefined);

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
    
    
    
})
