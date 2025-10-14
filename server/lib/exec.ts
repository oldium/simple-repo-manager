import logger, { colorize } from "./logger.ts";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { quote } from "shell-quote";

export interface ActionResult {
    result: "success" | "error" | "script";
    error?: Error | number | undefined;
    message: string;
}

export type LevelFn = (stdio: "stdout" | "stderr", message: string) => string;

export interface ExecOptions {
    cwd?: string;
    stdinText?: string;
    stderrAsInfo?: boolean;
    errorAsWarn?: boolean;
    levelFn?: LevelFn;
}

/**
 * Instruments a stream with data and end event handlers for line-by-line processing
 * @param stream The stream to instrument (stdout or stderr)
 * @param logFn The logging function to use for each line
 * @param dataCallback Optional callback for additional processing of data
 */
function instrumentStream(
    stream: NodeJS.ReadableStream | null,
    logFn: (line: string) => void,
    dataCallback?: (data: Buffer) => void
): void {
    if (!stream) return;

    // Buffer for incomplete lines - scoped to this function
    let buffer = '';

    /**
     * Process stream data line by line
     * @param data The data buffer from the stream
     * @param buffer The current buffer for incomplete lines
     * @returns The updated buffer with any incomplete line
     */
    const processStreamData = (data: Buffer, buffer: string): string => {
        const dataStr = data.toString();

        // Process complete lines for logging
        const lines = (buffer + dataStr).split(/\r?\n/);
        const newBuffer = lines.pop() || ''; // Store the last incomplete line

        for (const line of lines) {
            if (line) {
                logFn(line);
            }
        }

        return newBuffer;
    };

    /**
     * Handle remaining data in the buffer when stream ends
     * @param buffer The current buffer for incomplete lines
     */
    const handleStreamEnd = (buffer: string): void => {
        if (buffer) {
            logFn(buffer);
        }
    };

    // Set up data event handler
    stream.on('data', (data: Buffer) => {
        // Call the optional callback if provided
        if (dataCallback) {
            dataCallback(data);
        }

        // Process the data and update the buffer
        buffer = processStreamData(data, buffer);
    });

    // Set up end event handler
    stream.on('end', () => {
        handleStreamEnd(buffer);
    });
}

export async function exec(executable: string, ...args: string[]): Promise<ActionResult> {
    return await execOpt({}, executable, ...args);
}

function defaultStderrWarnLevelFn(stdio: "stdout" | "stderr") {
    switch (stdio) {
        case "stderr":
            return "warn";
        default:
            return "info";
    }
}

function defaultAllInfoLevelFn() {
    return "info";
}

export async function execOpt(opts: ExecOptions, executable: string, ...args: string[]): Promise<ActionResult> {
    logger.info(`[${ executable }] Executing: ${ quote([executable, ...args]) }`);

    let child: ChildProcessByStdio<Writable | null, Readable, Readable> | null = null;
    let spawnError: Error | null = null;
    let scriptStderr = '';
    const loggerError = opts.errorAsWarn ? logger.warn.bind(null) : logger.error.bind(null);

    try {
        child = spawn(executable, args, {
            cwd: opts.cwd,
            stdio: [opts.stdinText ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            detached: false
        }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    } catch (err) {
        loggerError(`[${ executable }] Failed to run executable:`, { err });
        spawnError = err instanceof Error ? err : new Error(String(err));
    }

    if (child) {
        const levelFn = opts.levelFn ?? (opts.stderrAsInfo ? defaultAllInfoLevelFn : defaultStderrWarnLevelFn );

        instrumentStream(
            child.stdout,
            (line) => {
                const level = levelFn("stdout", line);
                logger.log(level, `[${ executable } ${ colorize.colorize(level, "stdout") }]: ${ line }`)
            }
        );

        instrumentStream(
            child.stderr,
            (line) => {
                const level = levelFn("stderr", line);
                logger.log(level, `[${ executable } ${ colorize.colorize(level, "stderr") }]: ${ line }`)
            },
            (data) => scriptStderr += data.toString()
        );

        if (opts.stdinText) {
            child.stdin?.write(opts.stdinText);
            child.stdin?.end();
        }

        // Handle script spawn errors
        child.on('error', (err) => {
            loggerError(`[${ executable }] Failed to run executable:`, { err });
            spawnError = err;
        });

        // Handle script completion
        const { promise: scriptFinished, resolve: scriptResolve } = Promise.withResolvers<void>();

        child.on('close', (code) => {
            if (code !== null && ((!spawnError && code !== 0) || logger.isDebugEnabled())) {
                logger.log(code ? "warn" : "debug", `[${ executable }] Execution finished with exit code: ${ code }`);
            }
            scriptResolve();
        });

        await scriptFinished;
    }

    return {
        result: spawnError ? "error" : child!.exitCode === 0 ? "success" : "script",
        error: spawnError ?? (child!.exitCode !== 0 ? child!.exitCode! : undefined),
        message: scriptStderr
    };
}
