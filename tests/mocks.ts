import { jest } from "@jest/globals";
import { Readable } from "node:stream";
import logger from "../server/lib/logger.ts";

export type TestFunc = (executable: string, args: string[]) => Promise<void> | void;

type Spawn = (executable: string, args: string[]) => {
    exitCode: number | null,
    stdout: Readable,
    stderr: Readable,
    on: (event: string, callback: unknown) => void
};

export function spawnMock(exitCode: number | null, stdout?: string, stderr?: string, spawnError?: Error,
    testFunc?: TestFunc): Spawn {
    return (executable: string, args: string[]) => {
        let testFuncPromise: Promise<void>;
        if (testFunc) {
            try {
                const result = testFunc(executable, args);
                testFuncPromise = result instanceof Promise ? result : Promise.resolve();
            } catch (err) {
                testFuncPromise = Promise.reject(err);
            }
        } else {
            testFuncPromise = Promise.resolve();
        }
        testFuncPromise.catch((err) => {
            logger.error("Test function failed: ", { err });
        });

        return {
            exitCode,
            stdout: new Readable({
                read() {
                    if (stdout?.length) {
                        this.push(stdout);
                    }
                    this.push(null);
                },
            }),
            stderr: new Readable({
                read() {
                    if (stderr?.length) {
                        this.push(stderr);
                    }
                    this.push(null);
                },
            }),
            on: jest.fn((event, callback: unknown) => {
                if (event === "error" && spawnError) {
                    testFuncPromise.finally(() => setImmediate(() => (callback as (err: Error) => void)(spawnError)));
                } else if (event === "close") {
                    testFuncPromise.finally(() => setImmediate(
                        () => setImmediate(() => (callback as (code: number | null) => void)(exitCode))));
                }
            }),
        };
    };
}

export function mockExecution(exitCode: number | null, stdout?: string, stderr?: string, spawnError?: Error,
    testFunc?: TestFunc) {
    const spawn = jest.fn(spawnMock(exitCode, stdout, stderr, spawnError, testFunc));
    jest.unstable_mockModule("node:child_process", () => ({
        spawn,
    }));
    return spawn;
}
