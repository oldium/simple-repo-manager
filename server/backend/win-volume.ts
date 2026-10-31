import fs from "fs/promises";
import osPath from "path";
import { isInvalidHandle, loadLibrary, wide } from "./ffi.ts";
import type { Library } from "./ffi.ts";

const FILE_READ_ATTRIBUTES = 0x80;
const FILE_SHARE_ALL = 7;
const OPEN_EXISTING = 3;
// CreateFileW opens a directory only with this flag
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;

const FILE_CASE_SENSITIVE_INFO = 23;
const FILE_CS_FLAG_CASE_SENSITIVE_DIR = 1;
const CASE_SENSITIVE_INFO_SIZE = 4;

const FSCTL_QUERY_PERSISTENT_VOLUME_STATE = 0x0009023c;
const PERSISTENT_VOLUME_STATE_SHORT_NAME_CREATION_DISABLED = 1;
// FILE_FS_PERSISTENT_VOLUME_INFORMATION: VolumeFlags at 0, FlagMask at 4, Version at 8, Reserved at 12
const VOLUME_INFORMATION_SIZE = 16;
const FLAG_MASK_OFFSET = 4;
const VERSION_OFFSET = 8;
const VOLUME_INFORMATION_VERSION = 1;
const BYTES_RETURNED_SIZE = 4;

const HKEY_LOCAL_MACHINE = 0xffffffff80000002n;
const FILE_SYSTEM_KEY = "SYSTEM\\CurrentControlSet\\Control\\FileSystem";
const DISABLE_SHORT_NAMES_VALUE = "NtfsDisable8dot3NameCreation";
const RRF_RT_REG_DWORD = 0x10;
const DWORD_SIZE = 4;
const ERROR_SUCCESS = 0;

// The values of NtfsDisable8dot3NameCreation
const SHORT_NAMES_OFF_ON_ALL_VOLUMES = 1;
const SHORT_NAMES_PER_VOLUME = 2;
const SHORT_NAMES_ON_SYSTEM_VOLUME_ONLY = 3;

const KERNEL32 = {
    CreateFileW: { arguments: ["buffer", "u32", "u32", "pointer", "u32", "u32", "pointer"], return: "pointer" },
    GetFileInformationByHandleEx: { arguments: ["pointer", "i32", "buffer", "u32"], return: "i32" },
    DeviceIoControl: { arguments: ["pointer", "u32", "buffer", "u32", "buffer", "u32", "buffer", "pointer"], return: "i32" },
    GetVolumeInformationByHandleW: { arguments: ["pointer", "pointer", "u32", "pointer", "buffer", "pointer", "pointer", "u32"], return: "i32" },
    CloseHandle: { arguments: ["pointer"], return: "i32" },
} as const;

const ADVAPI32 = {
    RegGetValueW: { arguments: ["pointer", "buffer", "buffer", "u32", "pointer", "buffer", "buffer"], return: "i32" },
} as const;

export type DirectoryNaming = {
    caseSensitive: boolean;
    /** Whether new files get an 8.3 short name; one given before the volume stopped creating them stays until fsutil 8dot3name strip */
    shortNames: boolean;
};

/** What a directory answers; defaulted names what could not be asked, so it holds the Windows default */
export type DirectoryAnswer = DirectoryNaming & { defaulted?: (keyof DirectoryNaming)[] };

const OTHER_SYSTEMS: DirectoryNaming = { caseSensitive: true, shortNames: false };

let kernel32: Promise<Library<typeof KERNEL32> | undefined> | undefined;
let advapi32: Promise<Library<typeof ADVAPI32> | undefined> | undefined;

/** What the open directory answers, undefined when it cannot be opened */
function queryDirectory<T>(api: Library<typeof KERNEL32>, dir: string, query: (handle: bigint) => T): T | undefined {
    const handle = api.CreateFileW(wide(osPath.toNamespacedPath(osPath.resolve(dir))), FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, null);
    if (isInvalidHandle(handle)) {
        return undefined;
    }
    try {
        return query(handle);
    } finally {
        api.CloseHandle(handle);
    }
}

function isCaseSensitive(api: Library<typeof KERNEL32>, handle: bigint): boolean | undefined {
    const info = Buffer.alloc(CASE_SENSITIVE_INFO_SIZE);
    if (api.GetFileInformationByHandleEx(handle, FILE_CASE_SENSITIVE_INFO, info, info.length) === 0) {
        return undefined;
    }
    return (info.readUInt32LE(0) & FILE_CS_FLAG_CASE_SENSITIVE_DIR) !== 0;
}

/** A raw volume handle answers ERROR_INVALID_FUNCTION here; one of a directory reaches the file system, also through a junction */
function isShortNameCreationDisabled(api: Library<typeof KERNEL32>, handle: bigint): boolean | undefined {
    const input = Buffer.alloc(VOLUME_INFORMATION_SIZE);
    input.writeUInt32LE(PERSISTENT_VOLUME_STATE_SHORT_NAME_CREATION_DISABLED, FLAG_MASK_OFFSET);
    input.writeUInt32LE(VOLUME_INFORMATION_VERSION, VERSION_OFFSET);
    const output = Buffer.alloc(VOLUME_INFORMATION_SIZE);
    const returned = Buffer.alloc(BYTES_RETURNED_SIZE);
    if (api.DeviceIoControl(handle, FSCTL_QUERY_PERSISTENT_VOLUME_STATE, input, input.length, output, output.length, returned, null) === 0) {
        return undefined;
    }
    return (output.readUInt32LE(0) & PERSISTENT_VOLUME_STATE_SHORT_NAME_CREATION_DISABLED) !== 0;
}

function shortNamesMode(api: Library<typeof ADVAPI32>): number | undefined {
    const data = Buffer.alloc(DWORD_SIZE);
    const size = Buffer.alloc(DWORD_SIZE);
    size.writeUInt32LE(DWORD_SIZE);
    const status = api.RegGetValueW(HKEY_LOCAL_MACHINE, wide(FILE_SYSTEM_KEY), wide(DISABLE_SHORT_NAMES_VALUE), RRF_RT_REG_DWORD, null, data, size);
    return status === ERROR_SUCCESS ? data.readUInt32LE(0) : undefined;
}

async function isOnSystemVolume(dir: string): Promise<boolean | undefined> {
    const systemDrive = process.env.SystemDrive;
    if (systemDrive === undefined) {
        return undefined;
    }
    return osPath.win32.parse(await fs.realpath(dir)).root.toLowerCase() === `${ systemDrive }\\`.toLowerCase();
}

/**
 * Whether new files get short names. Only NTFS answers for the volume, and FAT always creates them whatever the registry
 * says, so anything unknown counts as creating them.
 */
export function createsShortNames(mode: number | undefined, volumeDisabled: boolean | undefined, onSystemVolume: boolean | undefined): boolean {
    if (volumeDisabled === undefined) {
        return true;
    }
    switch (mode) {
        case SHORT_NAMES_OFF_ON_ALL_VOLUMES:
            return false;
        case SHORT_NAMES_PER_VOLUME:
            return !volumeDisabled;
        case SHORT_NAMES_ON_SYSTEM_VOLUME_ONLY:
            return onSystemVolume !== false;
        default:
            return true;
    }
}

/** The answer from what the queries said, undefined for one that could not be asked */
export function answerOf(caseSensitive: boolean | undefined, mode: number | undefined, volumeDisabled: boolean | undefined, onSystemVolume: boolean | undefined): DirectoryAnswer {
    const defaulted: (keyof DirectoryNaming)[] = [];
    if (caseSensitive === undefined) {
        defaulted.push("caseSensitive");
    }
    if (mode === undefined || volumeDisabled === undefined || (mode === SHORT_NAMES_ON_SYSTEM_VOLUME_ONLY && onSystemVolume === undefined)) {
        defaulted.push("shortNames");
    }
    return {
        caseSensitive: caseSensitive ?? false,
        shortNames: createsShortNames(mode, volumeDisabled, onSystemVolume),
        ...(defaulted.length > 0 ? { defaulted } : {}),
    };
}

/** The longest entry name the volume holding the directory takes, in UTF-16 units; the handle answers for what is behind a junction too */
export async function maxComponentLength(dir: string): Promise<number | undefined> {
    kernel32 ??= loadLibrary("kernel32.dll", KERNEL32);
    const files = await kernel32;
    return files === undefined ? undefined : queryDirectory(files, dir, handle => {
        const length = Buffer.alloc(DWORD_SIZE);
        return files.GetVolumeInformationByHandleW(handle, null, 0, null, length, null, null, 0) === 0 ? undefined : length.readUInt32LE(0);
    });
}

/** How names work in the directory. On Windows it is asked, and what cannot be asked counts as the Windows default, the stricter answer */
export async function directoryNaming(dir: string, platform: NodeJS.Platform = process.platform): Promise<DirectoryAnswer> {
    if (platform !== "win32") {
        return OTHER_SYSTEMS;
    }
    kernel32 ??= loadLibrary("kernel32.dll", KERNEL32);
    advapi32 ??= loadLibrary("advapi32.dll", ADVAPI32);
    const [files, registry] = [await kernel32, await advapi32];
    const answers = files === undefined ? undefined : queryDirectory(files, dir, handle => ({
        caseSensitive: isCaseSensitive(files, handle),
        volumeDisabled: isShortNameCreationDisabled(files, handle),
    }));
    const mode = registry === undefined ? undefined : shortNamesMode(registry);
    return answerOf(answers?.caseSensitive, mode, answers?.volumeDisabled, mode === SHORT_NAMES_ON_SYSTEM_VOLUME_ONLY ? await isOnSystemVolume(dir) : undefined);
}
