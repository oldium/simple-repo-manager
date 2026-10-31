import { directoryNameLimit } from "../backend/name-limit.ts";
import { directoryNaming } from "../backend/win-volume.ts";
import type { DirectoryAnswer, DirectoryNaming } from "../backend/win-volume.ts";
import logger from "./logger.ts";

export type NamingSetting = "auto" | boolean;

export type FileNamingSettings = {
    caseSensitive: NamingSetting;
    shortNames: NamingSetting;
};

type AskDirectory = (dir: string, platform: NodeJS.Platform) => Promise<DirectoryAnswer>;

type AskNameLimit = (dir: string, platform: NodeJS.Platform) => Promise<number | undefined>;

// Every file system in use stays within it, so the repository can move between them
const COMMON_NAME_LIMIT = 255;

// File placement adds ".tmp-" and a process id of up to 10 digits to any name
const TEMP_SUFFIX_LENGTH = 15;

// <sha256>-filelists.xml.zst; the publish cannot work below it
const LONGEST_OWN_NAME = 82;

const SETTING_NAMES: Record<keyof DirectoryNaming, string> = { caseSensitive: "REPO_CASE_SENSITIVE", shortNames: "REPO_SHORT_NAMES" };

let resolved: { platform: NodeJS.Platform; naming: DirectoryNaming } | undefined;

let nameLimit: { platform: NodeJS.Platform; limit: number } | undefined;

function platformDefault(platform: NodeJS.Platform): DirectoryNaming {
    return platform === "win32" ? { caseSensitive: false, shortNames: true } : { caseSensitive: true, shortNames: false };
}

/** What the app start resolved; before it, and for an injected other platform, that platform's own answer */
export function fileNaming(platform: NodeJS.Platform = process.platform): DirectoryNaming {
    return resolved?.platform === platform ? resolved.naming : platformDefault(platform);
}

export function setFileNaming(naming: DirectoryNaming, platform: NodeJS.Platform = process.platform): void {
    resolved = { platform, naming };
}

export function resetFileNaming(): void {
    resolved = undefined;
    nameLimit = undefined;
}

/** The longest segment; bytes never undercount the UTF-16 units Windows limits, so the bound holds there too */
export function maxSegmentBytes(platform: NodeJS.Platform = process.platform): number {
    return (nameLimit?.platform === platform ? nameLimit.limit : COMMON_NAME_LIMIT) - TEMP_SUFFIX_LENGTH;
}

/** A distribution, release or component, or a path of them, as the repository holds it: one spelling where case does not count */
export function repoDirectoryName(name: string): string {
    // Other letters stay: the Kelvin sign would lower-case to a plain k, past the shape rules, though NTFS keeps the two apart
    return fileNaming().caseSensitive || !isAscii(name) ? name : name.toLowerCase();
}

export const NOT_IN_LOWER_CASE = "a distribution, release or component directory has to be in lower-case ASCII where case does not count";

// NTFS and toLowerCase fold only these alike
function isAscii(name: string): boolean {
    return /^[ -~]*$/.test(name);
}

/** Whether a distribution, release or component, or a path of them, can be in the repository: where case does not count only one spelling can */
export function isRepoDirectoryName(name: string): boolean {
    return fileNaming().caseSensitive || (isAscii(name) && name === name.toLowerCase());
}

function origin(setting: NamingSetting): string {
    return setting === "auto" ? "auto" : "configured";
}

/** Called at app start, ahead of everything that checks a name. Files move between the directories, so the stricter one answers. */
export async function resolveFileNaming(settings: FileNamingSettings, dirs: string[], platform: NodeJS.Platform = process.platform, ask: AskDirectory = directoryNaming, askNameLimit: AskNameLimit = directoryNameLimit): Promise<void> {
    const answers = settings.caseSensitive === "auto" || settings.shortNames === "auto" ? await Promise.all(dirs.map(dir => ask(dir, platform))) : [];
    const naming: DirectoryNaming = {
        caseSensitive: settings.caseSensitive === "auto" ? answers.every(answer => answer.caseSensitive) : settings.caseSensitive,
        shortNames: settings.shortNames === "auto" ? answers.some(answer => answer.shortNames) : settings.shortNames,
    };
    setFileNaming(naming, platform);
    const limits = (await Promise.all(dirs.map(dir => askNameLimit(dir, platform)))).filter(limit => limit !== undefined);
    nameLimit = { platform, limit: Math.min(COMMON_NAME_LIMIT, ...limits) };
    const answered = { caseSensitive: naming.caseSensitive ? "case-sensitive" : "case-insensitive", shortNames: `8.3 short names ${ naming.shortNames ? "on" : "off" }` };
    logger.info(`File names: ${ answered.caseSensitive } (${ origin(settings.caseSensitive) }), ${ answered.shortNames } (${ origin(settings.shortNames) }), `
        + `up to ${ maxSegmentBytes(platform) } bytes (${ limits.length === dirs.length ? "auto" : "default" })`);
    if (maxSegmentBytes(platform) < LONGEST_OWN_NAME) {
        throw new Error(`The file system takes names of up to ${ nameLimit.limit } characters, too short for the files of a repository, which need ${ LONGEST_OWN_NAME + TEMP_SUFFIX_LENGTH }`);
    }
    const defaulted = (["caseSensitive", "shortNames"] as const).filter(key => settings[key] === "auto" && answers.some(answer => answer.defaulted?.includes(key)));
    if (defaulted.length > 0) {
        const several = defaulted.length > 1;
        logger.warn(`File names: the file system could not be asked, so ${ defaulted.map(key => answered[key]).join(" and ") } ${ several ? "are the defaults" : "is the default" }; `
            + `${ defaulted.map(key => SETTING_NAMES[key]).join(" and ") } ${ several ? "override them" : "overrides it" }`);
    }
}
