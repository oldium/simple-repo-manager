import filenameReservedRegex, { windowsReservedNameRegex } from "filename-reserved-regex";
import osPath from "node:path";
import { RepoValidationError } from "./errors.ts";
import { fileNaming, maxSegmentBytes } from "./file-naming.ts";

const CONTROL_CHARACTER = /\p{Cc}/u;

export const ONLY_DOTS = /^\.+$/;

const SHOWN_CHARACTERS = 64;

// On a volume with 8.3 names such an alias reaches or overwrites another file and slips past name-based filters.
// Exactly what NTFS can generate: a base of up to 8 ASCII characters ending in ~ and a number from 1, and up to 3 for the extension
const SHORT_NAME = /^(?=[^.]{1,8}(?:\.|$))[\w!#$%&'()\-@^`{}~]*~[1-9]\d*(?:\.[\w!#$%&'()\-@^`{}~]{1,3})?$/;

// Follows the injected platform too, so the Windows rules can be tested on any OS
function pathsOf(platform: NodeJS.Platform) {
    return platform === "win32" ? osPath.win32 : osPath.posix;
}

function segmentFault(segment: string, platform: NodeJS.Platform): string | undefined {
    if (segment.length === 0) {
        return "is an empty path segment";
    }
    if (Buffer.byteLength(segment) > maxSegmentBytes(platform)) {
        return `is longer than ${ maxSegmentBytes(platform) } bytes`;
    }
    if (ONLY_DOTS.test(segment)) {
        return "is made only of dots";
    }
    if (segment.includes("/") || segment.includes("\\")) {
        return "holds a path separator";
    }
    if (CONTROL_CHARACTER.test(segment)) {
        return "holds a control character";
    }
    if (platform === "win32") {
        // The regex also takes extensions, but with one the name is an ordinary file on Windows 11
        if (!segment.includes(".") && windowsReservedNameRegex().test(segment)) {
            return "is a reserved name on Windows";
        }
        if (filenameReservedRegex().test(segment)) {
            return "holds a character or an ending that Windows refuses in a file name";
        }
    }
    if (fileNaming(platform).shortNames && SHORT_NAME.test(segment)) {
        return "has the shape of a Windows 8.3 short name";
    }
    return undefined;
}

/** Why the name cannot be one segment of a URL or repo-relative path on the platform; undefined when it can */
export function segmentProblem(segment: string, platform: NodeJS.Platform = process.platform): string | undefined {
    const fault = segmentFault(segment, platform);
    // JSON keeps a hostile value's control characters out of logs and responses
    return fault === undefined ? undefined : `${ JSON.stringify(segment.length > SHOWN_CHARACTERS ? `${ segment.slice(0, SHOWN_CHARACTERS) }…` : segment) } ${ fault }`;
}

/** The first problem among the segments */
export function segmentsProblem(segments: string[], platform: NodeJS.Platform = process.platform): string | undefined {
    for (const segment of segments) {
        const problem = segmentProblem(segment, platform);
        if (problem !== undefined) {
            return problem;
        }
    }
    return undefined;
}

/** Why a decoded URL path cannot name anything below the served root */
export function urlPathProblem(urlPath: string, platform: NodeJS.Platform = process.platform): string | undefined {
    // An empty segment names nothing, so a client whose base URL ends in a slash still reaches the file
    return segmentsProblem(urlPath.split("/").filter(segment => segment.length > 0), platform);
}

/** Refuses a repo-relative path toOsPath would refuse, for a check ahead of any file operation */
export function checkPosixPath(posixPath: string, platform: NodeJS.Platform = process.platform): void {
    const problem = segmentsProblem(posixPath.split("/"), platform);
    if (problem !== undefined) {
        throw new RepoValidationError(`Malformed path ${ JSON.stringify(posixPath) }: ${ problem }`);
    }
}

function relativeBelow(root: string, osFile: string, platform: NodeJS.Platform): string {
    const paths = pathsOf(platform);
    const relative = paths.relative(root, osFile);
    if (relative === "" || relative === ".." || relative.startsWith(`..${ paths.sep }`) || paths.isAbsolute(relative)) {
        throw new RepoValidationError(`${ JSON.stringify(osFile) } is not below ${ JSON.stringify(root) }`);
    }
    return relative;
}

/**
 * The only way from a URL or repo-relative path to an OS path: every segment is checked first, so a double backslash, a
 * drive or a device name can never come out of one
 */
export function toOsPath(root: string, posixPath: string, platform: NodeJS.Platform = process.platform): string {
    checkPosixPath(posixPath, platform);
    const osFile = pathsOf(platform).join(root, ...posixPath.split("/"));
    relativeBelow(root, osFile, platform);
    return osFile;
}

/** The reverse of toOsPath, under the same checks */
export function toPosixPath(root: string, osFile: string, platform: NodeJS.Platform = process.platform): string {
    const posixPath = relativeBelow(root, osFile, platform).split(pathsOf(platform).sep).join("/");
    checkPosixPath(posixPath, platform);
    return posixPath;
}
