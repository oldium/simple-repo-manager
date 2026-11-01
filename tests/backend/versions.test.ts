import { DatabaseSync } from "node:sqlite";
import { askedVersion, compareDebianVersions, registerVersionFunctions } from "../../server/backend/versions.ts";
import { RepoValidationError } from "../../server/lib/errors.ts";

const db = new DatabaseSync(":memory:");
registerVersionFunctions(db);

function sql(expression: string, ...args: (string | number)[]): number {
    return (db.prepare(`SELECT ${ expression } AS c`).get(...args) as { c: number }).c;
}

/** Every pair of the list, which is in ascending order */
function pairs(ascending: string[]): [string, string][] {
    return ascending.flatMap((a, i) => ascending.slice(i + 1).map(b => [a, b] as [string, string]));
}

describe("Version comparison", () => {
    const UPSTREAM = ["1.0~~", "1.0~~a", "1.0~", "1.0", "1.0a", "1.0+", "1.0.1", "1.1", "1.10", "1.010a"];
    test.each(pairs(UPSTREAM))("dpkg orders %s before %s", (a, b) => {
        expect(compareDebianVersions(a, b)).toBe(-1);
        expect(compareDebianVersions(b, a)).toBe(1);
        expect(compareDebianVersions(a, a)).toBe(0);
    });

    const FULL = ["0.9", "1:0.1", "1:0.1-1", "1:0.1-1.1", "1:0.1-2", "2:0"];
    test.each(pairs(FULL))("dpkg orders the full version %s before %s", (a, b) => {
        expect(sql("deb_version_order(?, ?)", a, b)).toBe(-1);
        expect(sql("deb_version_order(?, ?)", b, a)).toBe(1);
    });

    test.each<[string, string, number]>([
        ["22-1+tpm1u1+deb13", "22", 0],
        ["22-1+tpm1u1+deb13", "23", -1],
        ["24-1+tpm1u0+deb13", "23", 1],
        ["22-1+tpm1u1+deb13", "22-1+tpm1u0+deb13", 1],
        ["2:3.0-1", "3.0", 0],
        ["2:3.0-1", "1:3.0", 1],
        ["3.0", "3.0-1", -1],
    ])("A Debian %s against %s asked for compares only the parts asked for", (have, wanted, expected) => {
        expect(sql("deb_version_cmp(?, ?)", have, wanted)).toBe(expected);
    });

    test.each<[number, string, string, string, number]>([
        [0, "22", "1.tpm1u1.fc43", "22", 0],
        [0, "22", "1.tpm1u1.fc43", "22-1.tpm1u0.fc43", 1],
        [1, "1.0", "1", "2.0", -1],
        [1, "1.0", "1", "0:2.0", 1],
        [0, "1.0~rc1", "1", "1.0", -1],
        [0, "1.0^git1", "1", "1.0", 1],
    ])("An RPM %i:%s-%s against %s asked for compares only the parts asked for", (epoch, version, release, wanted, expected) => {
        expect(sql("rpm_version_cmp(?, ?, ?, ?)", epoch, version, release, wanted)).toBe(expected);
    });

    test("The epoch counts first between stored RPM versions", () => {
        expect(sql("rpm_version_order(1, '1.0', '1', 0, '2.0', '1')")).toBe(1);
        expect(sql("rpm_version_order(0, '2.0', '1', 0, '2.0', '1')")).toBe(0);
    });

    test("A stored version that is not well formed still compares", () => {
        expect(() => sql("deb_version_order(?, ?)", "a:1", "1")).not.toThrow();
    });

    test.each([
        ["a:1", "Invalid version a:1: the epoch is not a number"],
        [":1", "Invalid version :1: the epoch is not a number"],
        ["1:", "Invalid version 1:"],
        ["-1", "Invalid version -1"],
        ["1.0-", "Invalid version 1.0-"],
    ])("A version asked for that dpkg and rpm could not read is refused: %s", (text, message) => {
        expect(() => askedVersion(text)).toThrow(new RepoValidationError(message));
    });
});
