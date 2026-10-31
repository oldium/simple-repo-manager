import { describe, expect, test } from "@jest/globals";
import { execFileSync } from "child_process";
import fs from "fs/promises";
import osPath from "path";
import { withLocalTmpDir } from "../utils.ts";
import { loadLibrary } from "../../server/backend/ffi.ts";
import { answerOf, createsShortNames, directoryNaming } from "../../server/backend/win-volume.ts";

const windowsTest = process.platform === "win32" ? test : test.skip;

// fsutil refuses this without the WSL feature
const canSetCaseSensitive = process.platform === "win32" && await withLocalTmpDir(async () => {
    try {
        execFileSync("fsutil", ["file", "setCaseSensitiveInfo", process.cwd(), "enable"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
})();
const caseSensitiveTest = canSetCaseSensitive ? test : test.skip;

const ALL_ON = 0;
const ALL_OFF = 1;
const PER_VOLUME = 2;
const SYSTEM_ONLY = 3;

describe("Tests for createsShortNames", () => {
    test.each<[string, number | undefined, boolean | undefined, boolean | undefined, boolean]>([
        ["on for all volumes", ALL_ON, false, undefined, true],
        ["on for all volumes, the volume flag set", ALL_ON, true, undefined, true],
        ["off for all volumes", ALL_OFF, false, undefined, false],
        ["per volume, not disabled", PER_VOLUME, false, undefined, true],
        ["per volume, disabled", PER_VOLUME, true, undefined, false],
        ["the system volume only, on it", SYSTEM_ONLY, false, true, true],
        ["the system volume only, on another", SYSTEM_ONLY, false, false, false],
        ["the system volume only, not known which", SYSTEM_ONLY, false, undefined, true],
        ["an unknown mode", 4, true, undefined, true],
        ["no mode", undefined, true, undefined, true],
        ["off for all, but a volume that does not answer, as FAT", ALL_OFF, undefined, undefined, true],
        ["per volume, but a volume that does not answer", PER_VOLUME, undefined, undefined, true],
    ])("%s", (_, mode, volumeDisabled, onSystemVolume, expected) => {
        expect(createsShortNames(mode, volumeDisabled, onSystemVolume)).toBe(expected);
    });
});

describe("Tests for directoryNaming", () => {
    test.each(["linux", "darwin"] as const)("On %s nothing is asked and no Windows limit applies", async platform => {
        expect(await directoryNaming("does-not-exist", platform)).toEqual({ caseSensitive: true, shortNames: false });
    });

    windowsTest("A normal directory is case-insensitive, and short names match what the volume really does", withLocalTmpDir(async () => {
        await fs.writeFile("long-name-for-alias.txt", "x");
        const aliasWorks = await fs.access("LONG-N~1.TXT").then(() => true, () => false);

        expect(await directoryNaming(".")).toEqual({ caseSensitive: false, shortNames: aliasWorks });
    }));

    caseSensitiveTest("A case-sensitive directory answers so, also its new subdirectory and through a junction", withLocalTmpDir(async () => {
        await fs.mkdir("sensitive");
        execFileSync("fsutil", ["file", "setCaseSensitiveInfo", osPath.resolve("sensitive"), "enable"], { stdio: "ignore" });
        await fs.mkdir(osPath.join("sensitive", "child"));
        await fs.symlink(osPath.resolve("sensitive"), "junction", "junction");

        for (const dir of ["sensitive", osPath.join("sensitive", "child"), "junction"]) {
            expect((await directoryNaming(dir)).caseSensitive).toBe(true);
        }
    }));

    test("A directory that cannot be asked counts as the Windows default and says so, on Windows by a refused query, elsewhere without the libraries", withLocalTmpDir(async () => {
        expect(await directoryNaming("does-not-exist", "win32")).toEqual({ caseSensitive: false, shortNames: true, defaulted: ["caseSensitive", "shortNames"] });
    }));
});

describe("Tests for answerOf", () => {
    test.each<[string, boolean | undefined, number | undefined, boolean | undefined, boolean | undefined, object]>([
        ["everything answered", false, PER_VOLUME, true, undefined, { caseSensitive: false, shortNames: false }],
        ["a case-sensitive directory", true, ALL_ON, false, undefined, { caseSensitive: true, shortNames: true }],
        ["the system volume only, known which", false, SYSTEM_ONLY, false, false, { caseSensitive: false, shortNames: false }],
        ["no node:ffi, nothing answered", undefined, undefined, undefined, undefined, { caseSensitive: false, shortNames: true, defaulted: ["caseSensitive", "shortNames"] }],
        ["the case query refused", undefined, PER_VOLUME, true, undefined, { caseSensitive: false, shortNames: false, defaulted: ["caseSensitive"] }],
        ["no registry value", false, undefined, true, undefined, { caseSensitive: false, shortNames: true, defaulted: ["shortNames"] }],
        ["a volume that does not answer, as FAT", false, ALL_OFF, undefined, undefined, { caseSensitive: false, shortNames: true, defaulted: ["shortNames"] }],
        ["the system volume only, not known which", false, SYSTEM_ONLY, false, undefined, { caseSensitive: false, shortNames: true, defaulted: ["shortNames"] }],
    ])("%s", (_, caseSensitive, mode, volumeDisabled, onSystemVolume, expected) => {
        expect(answerOf(caseSensitive, mode, volumeDisabled, onSystemVolume)).toEqual(expected);
    });
});

describe("Tests for loadLibrary", () => {
    test("Overlapping loads put process.emitWarning back", async () => {
        const emitWarning = process.emitWarning;

        await Promise.all([loadLibrary("kernel32.dll", {}), loadLibrary("advapi32.dll", {}), loadLibrary("does-not-exist.dll", {})]);

        expect(process.emitWarning).toBe(emitWarning);
    });
});
