import { fileNaming } from "./file-naming.ts";
import { segmentProblem, segmentsProblem } from "./safe-path.ts";

/** What the publish writes next to the components in dists/<release> */
export const RELEASE_FILES = ["Release", "InRelease", "Release.gpg"];

/** What the start writes next to the distributions of a format */
export const KEYRING_FILES = { deb: "archive-keyring.asc", rpm: "RPM-GPG-KEY.asc" } as const;

const COMPONENT_DIRECTORIES = ["source", "by-hash", "debug", "debian-installer"];

/** A directory the publish writes below a component */
export function isComponentDirectory(name: string): boolean {
    return COMPONENT_DIRECTORIES.includes(name) || name.startsWith("binary-");
}

export function validateType(type: string): boolean {
    return !!type && ['deb', 'rpm'].includes(type);
}

function hasDistroShape(type: string, distroComponents: string[]): boolean {
    const [distro, release, ...components] = distroComponents;
    switch (type) {
        case 'deb':
            return !!distro?.match(/^[a-z]+$/)
                && !!release?.match(/^[a-z][a-z-]*$/)
                && components.every((item) => !!item.match(/^[a-z0-9][a-z0-9-]*$/))
                && components.length >= 1
                && components.length <= 2;
        case 'rpm':
            return !!distro?.match(/^[a-z]+$/) && !!release?.match(/^[0-9]+$/) && components.length == 0;
        default:
            return false;
    }
}

/**
 * Why a directory would take a name the server itself writes there. A component named like an index directory mixes its
 * indexes with those of its parent, and a rebuild reads them back as one. The names as sent name the problem.
 */
export function reservedNameProblem(type: string, distroComponents: string[], platform: NodeJS.Platform = process.platform): string | undefined {
    if (type !== "deb" && type !== "rpm") {
        return undefined;
    }
    const fold = (name: string): string => fileNaming(platform).caseSensitive ? name : name.toLowerCase();
    const [distro, , ...components] = distroComponents;
    if (distro !== undefined && fold(distro) === fold(KEYRING_FILES[type])) {
        return `${ JSON.stringify(distro) } cannot be a distribution, the format has a keyring of that name`;
    }
    if (type === "rpm") {
        return undefined;
    }
    const [first] = components;
    if (first !== undefined && RELEASE_FILES.some(name => fold(name) === fold(first))) {
        return `${ JSON.stringify(first) } cannot be a component, the release has a file of that name`;
    }
    const written = components.find(name => isComponentDirectory(fold(name)) || (fold(name).startsWith(fold("Contents-")) && fold(name).endsWith(".gz")));
    return written === undefined ? undefined : `${ JSON.stringify(written) } cannot be a component, the publish writes that name below a component`;
}

export function distroProblem(type: string, distroComponents: string[], platform: NodeJS.Platform = process.platform): string | undefined {
    return segmentsProblem(distroComponents, platform) ?? reservedNameProblem(type, distroComponents, platform);
}

export function validateDistro(type: string, distroComponents: string[], platform: NodeJS.Platform = process.platform): boolean {
    return hasDistroShape(type, distroComponents) && distroProblem(type, distroComponents, platform) === undefined;
}

function hasFilenameShape(type: string, filename: string): boolean {
    switch (type) {
        case 'deb':
            return !!filename.match(/^[a-zA-Z0-9][a-zA-Z0-9.+~_-]*(\.(deb|tar\.[^.]+|buildinfo|changes|dsc|ddeb|udeb))$/);
        case 'rpm':
            return !!filename.match(/^[a-zA-Z0-9][a-zA-Z0-9.+~^_-]*(\.rpm)$/);
        default:
            return false;
    }
}

export function validateFilename(type: string, filename: string, platform: NodeJS.Platform = process.platform): boolean {
    return hasFilenameShape(type, filename) && segmentProblem(filename, platform) === undefined;
}

function withProblem(message: string, problem: string | undefined): string {
    return problem === undefined ? message : `${ message }: ${ problem }`;
}

export function invalidDistroMessage(type: string, distroComponents: string[], platform: NodeJS.Platform = process.platform): string {
    return withProblem(`Unknown or invalid distro: ${ type }/${ distroComponents.join('/') }`, distroProblem(type, distroComponents, platform));
}

export function invalidFilenameMessage(filename: string, platform: NodeJS.Platform = process.platform): string {
    return withProblem(`Invalid filename: ${ filename }`, segmentProblem(filename, platform));
}

export const PACKAGE_IDENTIFIER_REGEX = /^[A-Za-z0-9.+:~^_-]+$/;

export function validatePackageIdentifier(value: string): boolean {
    return value !== "-" && PACKAGE_IDENTIFIER_REGEX.test(value);
}

export function isAnyWildcard(value: string): boolean {
    return value === "-";
}

export function validateWildcardOrIdentifier(value: string): boolean {
    return isAnyWildcard(value) || validatePackageIdentifier(value);
}
