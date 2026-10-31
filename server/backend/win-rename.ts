import osPath from "path";
import { isInvalidHandle, loadLibrary, wide } from "./ffi.ts";
import type { Library } from "./ffi.ts";

const DELETE_ACCESS = 0x10000;
const SYNCHRONIZE = 0x100000;
const SHARE_ALL = 7;
const OPEN_EXISTING = 3;
const FILE_RENAME_INFO_EX = 22;
const POSIX_SEMANTICS_REPLACE_IF_EXISTS = 3;
// FILE_RENAME_INFO on 64-bit Windows: Flags at 0, RootDirectory at 8, FileNameLength at 16, FileName at 20
const NAME_LENGTH_OFFSET = 16;
const NAME_OFFSET = 20;

const DEFINITIONS = {
    CreateFileW: { arguments: ["buffer", "u32", "u32", "pointer", "u32", "u32", "pointer"], return: "pointer" },
    SetFileInformationByHandle: { arguments: ["pointer", "i32", "buffer", "u32"], return: "i32" },
    CloseHandle: { arguments: ["pointer"], return: "i32" },
} as const;

let kernel32: Promise<Library<typeof DEFINITIONS> | undefined> | undefined;

/**
 * Atomically renames over a target others hold open, which fs.rename refuses on Windows; readers keep the old content.
 * False when it did nothing: node:ffi or POSIX renames are unavailable, or a handle does not share delete.
 */
export async function renameOverOpenFile(from: string, to: string): Promise<boolean> {
    kernel32 ??= loadLibrary("kernel32.dll", DEFINITIONS);
    const api = await kernel32;
    if (api === undefined) {
        return false;
    }
    const handle = api.CreateFileW(wide(osPath.toNamespacedPath(osPath.resolve(from))), DELETE_ACCESS | SYNCHRONIZE, SHARE_ALL, null, OPEN_EXISTING, 0, null);
    if (isInvalidHandle(handle)) {
        return false;
    }
    try {
        const name = Buffer.from(osPath.toNamespacedPath(osPath.resolve(to)), "utf16le");
        const info = Buffer.alloc(NAME_OFFSET + name.length + 2);
        info.writeUInt32LE(POSIX_SEMANTICS_REPLACE_IF_EXISTS, 0);
        info.writeUInt32LE(name.length, NAME_LENGTH_OFFSET);
        name.copy(info, NAME_OFFSET);
        return api.SetFileInformationByHandle(handle, FILE_RENAME_INFO_EX, info, info.length) !== 0;
    } finally {
        api.CloseHandle(handle);
    }
}
