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

        const { default: logger } = await import("../server/lib/logger.ts");
        const infoSpy = jest.spyOn(logger, "info");

        await import("../server/server.ts");

        // The very first info-level message must be the version banner
        // emitted by server/bootstrap.ts, before any config.ts warning
        // or HTTP listening / directory lines.
        expect(infoSpy.mock.calls.length).toBeGreaterThan(0);
        expect(String(infoSpy.mock.calls[0][0])).toMatch(
            /^> Starting Simple Repo Manager v\d+\.\d+\.\d+/
        );
    }));

    test("Bootstrap banner includes INSTANCE_LABEL suffix when set", async () => {
        process.env.INSTANCE_LABEL = "Home repository";
        jest.resetModules();

        const { default: logger } = await import("../server/lib/logger.ts");
        const infoSpy = jest.spyOn(logger, "info");

        await import("../server/bootstrap.ts");

        expect(infoSpy).toHaveBeenCalledWith(
            expect.stringMatching(
                /^> Starting Simple Repo Manager \(Home repository\) v\d+\.\d+\.\d+/
            )
        );
    });

    test("Bootstrap banner trims whitespace around INSTANCE_LABEL", async () => {
        process.env.INSTANCE_LABEL = "  Home repository  ";
        jest.resetModules();

        const { default: logger } = await import("../server/lib/logger.ts");
        const infoSpy = jest.spyOn(logger, "info");

        await import("../server/bootstrap.ts");

        expect(infoSpy).toHaveBeenCalledWith(
            expect.stringMatching(
                /^> Starting Simple Repo Manager \(Home repository\) v\d+\.\d+\.\d+/
            )
        );
    });

    test("Bootstrap banner has no parenthetical when INSTANCE_LABEL is empty", async () => {
        process.env.INSTANCE_LABEL = "   ";
        jest.resetModules();

        const { default: logger } = await import("../server/lib/logger.ts");
        const infoSpy = jest.spyOn(logger, "info");

        await import("../server/bootstrap.ts");

        expect(infoSpy).toHaveBeenCalledWith(
            expect.stringMatching(/^> Starting Simple Repo Manager v\d+\.\d+\.\d+/)
        );
    });
});
