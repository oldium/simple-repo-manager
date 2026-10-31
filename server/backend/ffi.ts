import type { dlopen } from "node:ffi";

type Definitions = NonNullable<Parameters<typeof dlopen>[1]>;

export type Library<T extends Definitions> = ReturnType<typeof dlopen<T>>["functions"];

const INVALID_HANDLE = 0xffffffffffffffffn;

export function isInvalidHandle(handle: bigint): boolean {
    return BigInt.asUintN(64, handle) === INVALID_HANDLE;
}

export function wide(text: string): Buffer {
    return Buffer.from(`${ text }\0`, "utf16le");
}

// Overlapping loads would each save the other's wrapper of process.emitWarning and put it back
let lastLoad: Promise<unknown> = Promise.resolve();

/** The functions of a system library, or of the process itself with null, undefined when node:ffi is not available. Only the import warns; other warnings raised meanwhile still go out */
export function loadLibrary<T extends Definitions>(library: string | null, definitions: T): Promise<Library<T> | undefined> {
    const load = lastLoad.then(() => loadQuietly(library, definitions));
    lastLoad = load;
    return load;
}

async function loadQuietly<T extends Definitions>(library: string | null, definitions: T): Promise<Library<T> | undefined> {
    const emitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
        const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
        if (type !== "ExperimentalWarning") {
            (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
        }
    }) as typeof process.emitWarning;
    try {
        const ffi = await import("node:ffi");
        return ffi.dlopen(library, definitions).functions as Library<T>;
    } catch {
        return undefined;
    } finally {
        process.emitWarning = emitWarning;
    }
}
