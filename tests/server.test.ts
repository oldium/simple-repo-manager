import { withLocalTmpDir } from "./utils.ts";
import { jest } from "@jest/globals";

const env = { ...process.env };

afterEach(() => {
    process.env = { ...env };
    jest.resetModules();
});

describe("Test environment variables and config", () => {
    test("Check server startup with default configuration and localhost", withLocalTmpDir(async () => {
        process.env.NODE_ENV = "test";
        process.env.HTTP_PORT = "0";
        process.env.HTTP_HOST = "localhost";

        // We actually do not need to mock dotenv/config here, because we are
        // running in a temporary directory, but we do it to ensure that
        // the server does not try to load any real environment variables
        jest.unstable_mockModule("dotenv/config", () => ({}));

        jest.spyOn(process, "on").mockImplementation((event, listener) => {
            if (event === "SIGINT") {
                listener();
            }
            return process;
        });

        await import("../server/server.ts");
    }));
});
