import { loadLibrary } from "./ffi.ts";
import type { Library } from "./ffi.ts";
import { maxComponentLength } from "./win-volume.ts";

// struct statfs and its f_namelen on 64-bit Linux, the same in glibc and musl
const STATFS_SIZE = 120;
const F_NAMELEN_OFFSET = 64;

// musl's pathconf answers a constant for any path, glibc's reads f_namelen too
const LIBC = {
    statfs: { arguments: ["buffer", "buffer"], return: "i32" },
} as const;

let libc: Promise<Library<typeof LIBC> | undefined> | undefined;

/** The longest entry name the file system of the directory takes, in UTF-16 units on Windows and bytes on Linux; undefined when it cannot be asked */
export async function directoryNameLimit(dir: string, platform: NodeJS.Platform = process.platform): Promise<number | undefined> {
    if (platform === "win32") {
        return maxComponentLength(dir);
    }
    if (platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64")) {
        return undefined;
    }
    libc ??= loadLibrary(null, LIBC);
    const lib = await libc;
    const stat = Buffer.alloc(STATFS_SIZE);
    if (lib === undefined || lib.statfs(Buffer.from(`${ dir }\0`), stat) !== 0) {
        return undefined;
    }
    const limit = stat.readBigUInt64LE(F_NAMELEN_OFFSET);
    return limit > 0n ? Number(limit) : undefined;
}
