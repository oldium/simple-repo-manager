import { jest } from "@jest/globals";
import { Readable } from "node:stream";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import osPath from "node:path";
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

// ---------------------------------------------------------------------------
// Hot-swap spawn mock
// ---------------------------------------------------------------------------
//
// `mockExecution` re-registers a fresh `node:child_process` mock factory on
// every call. Combined with `jest.resetModules()` in afterEach, that forces
// the next test to re-walk the entire server module graph after each
// `await import("../testapp.ts")` — ~700–1000 ms per test on this codebase.
//
// The `installSpawnProxy` / `setMockSpawn` pair below registers the mock
// exactly once and then lets each test swap the active `spawn` implementation
// without touching the module registry.
//
// Usage at the top of a test file:
//     installSpawnProxy();                                    // once, before any import of testapp
//     const { default: createTestApp } = await import("../testapp.ts");
//
// Inside a test:
//     const spawn = setMockSpawn(0, "stdout", "");            // returns the jest.fn for assertions
//
// Inside afterEach (recommended; turns "forgot to set a mock" into a clear
// error rather than reusing whatever the previous test installed):
//     clearMockSpawn();
//

let currentSpawn: Spawn | null = null;

const spawnProxy: Spawn = (executable, args) => {
    if (!currentSpawn) {
        throw new Error(
            `spawn proxy called with no active mock implementation; ` +
            `call setMockSpawn(...) (or mockExecution(...)) before triggering subprocess code. ` +
            `executable=${executable}`);
    }
    return currentSpawn(executable, args);
};

export function installSpawnProxy() {
    jest.unstable_mockModule("node:child_process", () => ({ spawn: spawnProxy }));
}

export function setMockSpawn(exitCode: number | null, stdout?: string, stderr?: string, spawnError?: Error,
    testFunc?: TestFunc) {
    const spawn = jest.fn(spawnMock(exitCode, stdout, stderr, spawnError, testFunc));
    currentSpawn = spawn;
    return spawn;
}

export function setMockSpawnFn(spawn: Spawn) {
    const wrapped = jest.fn(spawn);
    currentSpawn = wrapped;
    return wrapped;
}

export function clearMockSpawn() {
    currentSpawn = null;
}

/**
 * Options for {@link simulateRepreproProcessIncoming}.
 */
export type SimulateRepreproProcessIncomingOptions = {
    /**
     * Basenames for which this returns `true` are *kept* in the IncomingDir
     * instead of being drained, simulating files that reprepro intentionally
     * leaves behind (e.g. stray files not referenced by any `.changes`,
     * duplicates, or rejected older versions). When omitted, all files are
     * drained.
     */
    keepPredicate?: (basename: string) => boolean;
};

/**
 * Simulate what reprepro does when invoked with `processincoming`: it drains
 * every file from the configured `IncomingDir` (the real binary moves .deb /
 * .dsc / etc. into the pool and deletes the .changes/.buildinfo on success).
 * For test mocks it is sufficient to just remove the files, so that the
 * post-scan in `processIncoming` sees an empty staging directory and reports
 * each pre-scan file with status "ok".
 *
 * Reads the IncomingDir path out of the confdir/incoming file that the
 * production code wrote right before invoking reprepro.
 */
export async function simulateRepreproProcessIncoming(
    executable: string,
    args: string[],
    options?: SimulateRepreproProcessIncomingOptions,
): Promise<void> {
    if (executable !== "reprepro") return;
    const processIncomingIndex = args.indexOf("processincoming");
    if (processIncomingIndex < 0) return;

    const incomingDir = readIncomingDirFromRepreproArgsSync(args);
    if (!incomingDir) return;

    let entries: string[];
    try {
        entries = await fs.readdir(incomingDir);
    } catch {
        return;
    }
    for (const entry of entries) {
        if (options?.keepPredicate?.(entry)) continue;
        try {
            await fs.rm(osPath.join(incomingDir, entry), { recursive: true, force: true });
        } catch {
            // ignore; the test assertion will surface any remaining files.
        }
    }
}

/**
 * Parse the `--confdir <path>` argument from a reprepro invocation and read
 * the `IncomingDir:` value from the resolved incoming config file. Returns
 * the path if parseable, or `undefined` if `--confdir` is missing, the file
 * can't be read, or there is no `IncomingDir:` line.
 *
 * Strips the `+b/` basedir prefix that reprepro emits for relative confdirs.
 *
 * Kept synchronous so spawn mocks returned from `jest.unstable_mockModule`
 * factories can look up the IncomingDir without awaiting — the returned
 * process-like object has to be produced from a synchronous entry point.
 */
export function readIncomingDirFromRepreproArgsSync(args: string[]): string | undefined {
    const confDirIndex = args.indexOf("--confdir");
    if (confDirIndex < 0 || confDirIndex >= args.length - 1) return undefined;
    let confDir = args[confDirIndex + 1];
    if (confDir.startsWith("+b/")) {
        confDir = confDir.slice(3);
    }

    let incomingContent: string;
    try {
        incomingContent = fsSync.readFileSync(osPath.join(confDir, "incoming"), "utf8");
    } catch {
        return undefined;
    }
    for (const line of incomingContent.split(/\r?\n/)) {
        if (!line.startsWith("IncomingDir:")) continue;
        return line.slice("IncomingDir:".length).trim();
    }
    return undefined;
}
