import type { Database, SQLOutputValue } from "node:sqlite";
import { RepoValidationError } from "../lib/errors.ts";
import { compareRpmVersions } from "./rpm/xml.ts";

/** The epoch, the version and the Debian revision or RPM release; in a version asked for, a part left out is undefined */
type VersionParts = { epoch?: number; version: string; release?: string };

function isDigit(c: string | undefined): boolean {
    return c !== undefined && c >= "0" && c <= "9";
}

function isDigits(s: string): boolean {
    return s.length > 0 && [...s].every(c => isDigit(c));
}

/** The epoch before the first colon, the revision or release after the last dash */
function splitVersion(text: string): { epoch?: string; version: string; release?: string } {
    const colon = text.indexOf(":");
    const rest = colon < 0 ? text : text.slice(colon + 1);
    const dash = rest.lastIndexOf("-");
    return {
        epoch: colon < 0 ? undefined : text.slice(0, colon),
        version: dash < 0 ? rest : rest.slice(0, dash),
        release: dash < 0 ? undefined : rest.slice(dash + 1),
    };
}

/** A version asked for, refused when dpkg and rpm could not read it */
export function askedVersion(text: string): VersionParts {
    const { epoch, version, release } = splitVersion(text);
    if (epoch !== undefined && !isDigits(epoch)) {
        throw new RepoValidationError(`Invalid version ${ text }: the epoch is not a number`);
    }
    if (version.length === 0 || release === "") {
        throw new RepoValidationError(`Invalid version ${ text }`);
    }
    return { epoch: epoch === undefined ? undefined : Number(epoch), version, release };
}

/** A stored Debian version, every part present; one that is not well formed still compares */
function storedDebianVersion(text: string): Required<VersionParts> {
    const { epoch, version, release } = splitVersion(text);
    if (epoch !== undefined && !isDigits(epoch)) {
        return { epoch: 0, version: text, release: "" };
    }
    return { epoch: epoch === undefined ? 0 : Number(epoch), version, release: release ?? "" };
}

function order(c: string | undefined): number {
    if (c === undefined || isDigit(c)) {
        return 0;
    }
    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z")) {
        return c.charCodeAt(0);
    }
    return c === "~" ? -1 : c.charCodeAt(0) + 256;
}

/** dpkg's verrevcmp, for an upstream version or a revision */
export function compareDebianVersions(a: string, b: string): number {
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
            const difference = order(a[i]) - order(b[j]);
            if (difference !== 0) {
                return Math.sign(difference);
            }
            i++;
            j++;
        }
        while (a[i] === "0") {
            i++;
        }
        while (b[j] === "0") {
            j++;
        }
        let firstDifference = 0;
        while (isDigit(a[i]) && isDigit(b[j])) {
            if (firstDifference === 0) {
                firstDifference = a.charCodeAt(i) - b.charCodeAt(j);
            }
            i++;
            j++;
        }
        if (isDigit(a[i])) {
            return 1;
        }
        if (isDigit(b[j])) {
            return -1;
        }
        if (firstDifference !== 0) {
            return Math.sign(firstDifference);
        }
    }
    return 0;
}

/** The parts the wanted version has decide, so "22" stands for every build of 22 */
function compareParts(have: Required<VersionParts>, wanted: VersionParts, compare: (a: string, b: string) => number): number {
    if (wanted.epoch !== undefined && have.epoch !== wanted.epoch) {
        return have.epoch < wanted.epoch ? -1 : 1;
    }
    const byVersion = Math.sign(compare(have.version, wanted.version));
    return byVersion !== 0 || wanted.release === undefined ? byVersion : Math.sign(compare(have.release, wanted.release));
}

export function compareStoredDebianVersions(a: string, b: string): number {
    return compareParts(storedDebianVersion(a), storedDebianVersion(b), compareDebianVersions);
}

export type RpmVersion = { epoch: number; version: string; release: string };

export function compareStoredRpmVersions(a: RpmVersion, b: RpmVersion): number {
    return compareParts(a, b, compareRpmVersions);
}

function rpmParts(epoch: SQLOutputValue, version: SQLOutputValue, release: SQLOutputValue): Required<VersionParts> {
    return { epoch: Number(epoch), version: String(version), release: String(release) };
}

/**
 * The comparisons the search statements call: *_version_cmp against a version asked for, *_version_order between
 * two stored versions. Each is negative, zero or positive as dpkg or rpm orders them.
 */
export function registerVersionFunctions(db: Database): void {
    const options = { deterministic: true };
    db.function("deb_version_cmp", options, (have, wanted) =>
        compareParts(storedDebianVersion(String(have)), askedVersion(String(wanted)), compareDebianVersions));
    db.function("deb_version_order", options, (a, b) =>
        compareParts(storedDebianVersion(String(a)), storedDebianVersion(String(b)), compareDebianVersions));
    db.function("rpm_version_cmp", options, (epoch, version, release, wanted) =>
        compareParts(rpmParts(epoch, version, release), askedVersion(String(wanted)), compareRpmVersions));
    db.function("rpm_version_order", options, (epochA, versionA, releaseA, epochB, versionB, releaseB) =>
        compareParts(rpmParts(epochA, versionA, releaseA), rpmParts(epochB, versionB, releaseB), compareRpmVersions));
}
