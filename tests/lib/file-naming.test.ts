import { afterEach, describe, expect, jest, test } from "@jest/globals";
import fs from "fs/promises";
import type { DirectoryAnswer, DirectoryNaming } from "../../server/backend/win-volume.ts";
import { fileNaming, isRepoDirectoryName, maxSegmentBytes, repoDirectoryName, resetFileNaming, resolveFileNaming, setFileNaming } from "../../server/lib/file-naming.ts";
import type { FileNamingSettings } from "../../server/lib/file-naming.ts";
import logger from "../../server/lib/logger.ts";
import { segmentProblem } from "../../server/lib/safe-path.ts";
import { withLocalTmpDir } from "../utils.ts";

const windowsTest = process.platform === "win32" ? test : test.skip;

const WINDOWS_DEFAULT = { caseSensitive: false, shortNames: true };
const OTHER_SYSTEMS = { caseSensitive: true, shortNames: false };
const THIS_SYSTEM = process.platform === "win32" ? WINDOWS_DEFAULT : OTHER_SYSTEMS;
const NOT_THIS_PLATFORM = process.platform === "win32" ? "linux" : "win32";
const AUTO: FileNamingSettings = { caseSensitive: "auto", shortNames: "auto" };

afterEach(() => {
    resetFileNaming();
    jest.restoreAllMocks();
});

describe("Tests for fileNaming", () => {
    test("Before the app start each platform has its own answer", () => {
        expect(fileNaming("win32")).toEqual(WINDOWS_DEFAULT);
        expect(fileNaming("linux")).toEqual(OTHER_SYSTEMS);
        expect(fileNaming("darwin")).toEqual(OTHER_SYSTEMS);
        expect(fileNaming()).toEqual(THIS_SYSTEM);
    });

    test("What is set holds for this system, an injected other platform keeps its own answer", () => {
        const naming = { caseSensitive: !THIS_SYSTEM.caseSensitive, shortNames: !THIS_SYSTEM.shortNames };
        setFileNaming(naming);

        expect(fileNaming()).toEqual(naming);
        expect(fileNaming(process.platform)).toEqual(naming);
        expect(fileNaming(NOT_THIS_PLATFORM)).toEqual(NOT_THIS_PLATFORM === "win32" ? WINDOWS_DEFAULT : OTHER_SYSTEMS);
    });

    test("A repository directory name goes to lower case only where case does not count", () => {
        setFileNaming({ caseSensitive: false, shortNames: false });
        expect(repoDirectoryName("Fedora")).toBe("fedora");
        setFileNaming({ caseSensitive: true, shortNames: false });
        expect(repoDirectoryName("Fedora")).toBe("Fedora");
    });

    test("A name with a Kelvin sign keeps its spelling, it is not a plain k", () => {
        setFileNaming({ caseSensitive: false, shortNames: false });
        const kali = `${ String.fromCodePoint(0x212A) }ali`;
        expect(repoDirectoryName(kali)).toBe(kali);
    });

    test("A name with any letter other than ASCII keeps its spelling", () => {
        setFileNaming({ caseSensitive: false, shortNames: false });
        const fedora = `F${ String.fromCodePoint(0xC9) }DORA`;
        expect(repoDirectoryName(fedora)).toBe(fedora);
    });

    test("A reset brings the platform's answer back", () => {
        setFileNaming({ caseSensitive: !THIS_SYSTEM.caseSensitive, shortNames: !THIS_SYSTEM.shortNames });
        resetFileNaming();
        expect(fileNaming()).toEqual(THIS_SYSTEM);
    });
});

describe("Tests for resolveFileNaming", () => {
    test.each(["linux", "darwin"] as const)("With auto on %s nothing limits names, whatever the directories", async platform => {
        await resolveFileNaming(AUTO, ["does-not-exist"], platform);
        expect(fileNaming(platform)).toEqual(OTHER_SYSTEMS);
    });

    windowsTest("With auto on Windows it is what the real directories do", withLocalTmpDir(async () => {
        await fs.mkdir("repo");
        await fs.mkdir("incoming");
        await fs.writeFile("repo/srm-hello_1.0-1_amd64.deb", "x");
        const aliasWorks = await fs.access("repo/SRM-HE~1.DEB").then(() => true, () => false);

        await resolveFileNaming(AUTO, ["repo", "incoming"]);

        expect(fileNaming()).toEqual({ caseSensitive: false, shortNames: aliasWorks });
    }));

    test.each([
        ["both case-sensitive, no short names", [OTHER_SYSTEMS, OTHER_SYSTEMS], OTHER_SYSTEMS],
        ["both case-insensitive, short names", [WINDOWS_DEFAULT, WINDOWS_DEFAULT], WINDOWS_DEFAULT],
        ["only the first case-sensitive", [{ caseSensitive: true, shortNames: false }, { caseSensitive: false, shortNames: false }], { caseSensitive: false, shortNames: false }],
        ["only the second case-sensitive", [{ caseSensitive: false, shortNames: false }, { caseSensitive: true, shortNames: false }], { caseSensitive: false, shortNames: false }],
        ["only the first with short names", [{ caseSensitive: true, shortNames: true }, { caseSensitive: true, shortNames: false }], { caseSensitive: true, shortNames: true }],
        ["only the second with short names", [{ caseSensitive: true, shortNames: false }, { caseSensitive: true, shortNames: true }], { caseSensitive: true, shortNames: true }],
    ])("With auto, %s", async (_, [repo, incoming], expected) => {
        const answers = new Map([["repo", repo], ["incoming", incoming]]);

        await resolveFileNaming(AUTO, ["repo", "incoming"], "win32", dir => Promise.resolve(answers.get(dir)!));

        expect(fileNaming("win32")).toEqual(expected);
    });

    const ASKED = { caseSensitive: false, shortNames: true };
    const NOT_ASKED: DirectoryAnswer = { caseSensitive: false, shortNames: true, defaulted: ["caseSensitive", "shortNames"] };

    test.each<[string, FileNamingSettings, DirectoryAnswer[], string]>([
        ["neither directory could be asked", AUTO, [NOT_ASKED, NOT_ASKED],
            "File names: the file system could not be asked, so case-insensitive and 8.3 short names on are the defaults; REPO_CASE_SENSITIVE and REPO_SHORT_NAMES override them"],
        ["one directory could not tell its case", AUTO, [ASKED, { ...ASKED, defaulted: ["caseSensitive"] }],
            "File names: the file system could not be asked, so case-insensitive is the default; REPO_CASE_SENSITIVE overrides it"],
        ["case is configured", { caseSensitive: false, shortNames: "auto" }, [NOT_ASKED, NOT_ASKED],
            "File names: the file system could not be asked, so 8.3 short names on is the default; REPO_SHORT_NAMES overrides it"],
    ])("When %s, a warning follows the line, naming the default and its setting", async (_, settings, [repo, incoming], line) => {
        const answers = new Map([["repo", repo], ["incoming", incoming]]);
        const info = jest.spyOn(logger, "info").mockReturnValue(logger);
        const warn = jest.spyOn(logger, "warn").mockReturnValue(logger);

        await resolveFileNaming(settings, ["repo", "incoming"], "win32", dir => Promise.resolve(answers.get(dir)!));

        expect(warn.mock.calls).toEqual([[line]]);
        expect(info.mock.invocationCallOrder[0]).toBeLessThan(warn.mock.invocationCallOrder[0]);
    });

    test.each<[string, FileNamingSettings, DirectoryAnswer]>([
        ["both directories answered", AUTO, ASKED],
        ["both settings are configured", { caseSensitive: false, shortNames: true }, NOT_ASKED],
    ])("When %s, nothing is warned", async (_, settings, answer) => {
        const warn = jest.spyOn(logger, "warn").mockReturnValue(logger);

        await resolveFileNaming(settings, ["repo", "incoming"], "win32", () => Promise.resolve(answer));

        expect(warn).not.toHaveBeenCalled();
    });

    describe.each(["win32", "linux"] as const)("On %s", platform => {
        test.each([true, false].flatMap(caseSensitive => [true, false].map(shortNames => ({ caseSensitive, shortNames }))))("%j as configured, nothing is asked", async settings => {
            const ask = jest.fn<() => Promise<DirectoryNaming>>();

            await resolveFileNaming(settings, ["repo", "incoming"], platform, ask);

            expect(fileNaming(platform)).toEqual(settings);
            expect(ask).not.toHaveBeenCalled();
        });

        test("Each override stands on its own, the other setting still asks", async () => {
            const ask = (): Promise<DirectoryNaming> => Promise.resolve({ caseSensitive: true, shortNames: true });

            await resolveFileNaming({ caseSensitive: false, shortNames: "auto" }, ["repo"], platform, ask);
            expect(fileNaming(platform)).toEqual({ caseSensitive: false, shortNames: true });

            await resolveFileNaming({ caseSensitive: "auto", shortNames: false }, ["repo"], platform, ask);
            expect(fileNaming(platform)).toEqual({ caseSensitive: true, shortNames: false });
        });
    });

    test.each<[FileNamingSettings, string]>([
        [AUTO, "File names: case-sensitive (auto), 8.3 short names off (auto), up to 240 bytes (default)"],
        [{ caseSensitive: false, shortNames: true }, "File names: case-insensitive (configured), 8.3 short names on (configured), up to 240 bytes (default)"],
        [{ caseSensitive: true, shortNames: false }, "File names: case-sensitive (configured), 8.3 short names off (configured), up to 240 bytes (default)"],
        [{ caseSensitive: false, shortNames: "auto" }, "File names: case-insensitive (configured), 8.3 short names off (auto), up to 240 bytes (default)"],
        [{ caseSensitive: "auto", shortNames: true }, "File names: case-sensitive (auto), 8.3 short names on (configured), up to 240 bytes (default)"],
    ])("%j logs both answers and where each comes from", async (settings, line) => {
        const info = jest.spyOn(logger, "info").mockReturnValue(logger);

        await resolveFileNaming(settings, ["does-not-exist"], "linux");

        expect(info).toHaveBeenCalledWith(line);
    });
});

describe("Tests for the longest name", () => {
    const CONFIGURED: FileNamingSettings = { caseSensitive: true, shortNames: false };
    const noAsk = (): Promise<DirectoryNaming> => Promise.reject(new Error("not to be asked"));
    const resolveWith = (limits: Record<string, number | undefined>): Promise<void> =>
        resolveFileNaming(CONFIGURED, Object.keys(limits), process.platform, noAsk, dir => Promise.resolve(limits[dir]));

    test("Before the app start it is what the usual file systems take, less the temp suffix", () => {
        expect(maxSegmentBytes()).toBe(240);
        expect(maxSegmentBytes(NOT_THIS_PLATFORM)).toBe(240);
    });

    test("A file system taking less lowers it, for segments as well", async () => {
        await resolveWith({ repo: 143, incoming: 143 });

        expect(maxSegmentBytes()).toBe(128);
        expect(segmentProblem("a".repeat(128))).toBeUndefined();
        expect(segmentProblem("a".repeat(129))).toBe(`"${ "a".repeat(64) }…" is longer than 128 bytes`);
    });

    test.each([[143, 255], [255, 143]])("Files move between the directories, so the smaller of %i and %i counts", async (repo, incoming) => {
        await resolveWith({ repo, incoming });

        expect(maxSegmentBytes()).toBe(128);
    });

    test("A file system taking more changes nothing, the repository stays movable", async () => {
        await resolveWith({ repo: 4096, incoming: 1024 });

        expect(maxSegmentBytes()).toBe(240);
    });

    test("An injected other platform keeps its own limit", async () => {
        await resolveWith({ repo: 143 });

        expect(maxSegmentBytes(NOT_THIS_PLATFORM)).toBe(240);
    });

    test("A reset brings the usual limit back", async () => {
        await resolveWith({ repo: 143 });

        resetFileNaming();

        expect(maxSegmentBytes()).toBe(240);
    });

    test.each<[Record<string, number | undefined>, string]>([
        [{ repo: 255, incoming: 255 }, "up to 240 bytes (auto)"],
        [{ repo: 143, incoming: 255 }, "up to 128 bytes (auto)"],
        [{ repo: undefined, incoming: undefined }, "up to 240 bytes (default)"],
        [{ repo: 143, incoming: undefined }, "up to 128 bytes (default)"],
    ])("%j is logged as %s", async (limits, part) => {
        const info = jest.spyOn(logger, "info").mockReturnValue(logger);

        await resolveWith(limits);

        expect(info).toHaveBeenCalledWith(`File names: case-sensitive (configured), 8.3 short names off (configured), ${ part }`);
    });

    test("A file system too short for the published files refuses the start, one just long enough does not", async () => {
        await resolveWith({ repo: 97 });
        expect(maxSegmentBytes()).toBe(82);

        await expect(resolveWith({ repo: 96 })).rejects.toThrow("The file system takes names of up to 96 characters, too short for the files of a repository, which need 97");
    });
});

describe("Tests for the names the repository can hold", () => {
    const INSENSITIVE = { caseSensitive: false, shortNames: false };
    const SENSITIVE = { caseSensitive: true, shortNames: false };
    const OTHER_THAN_ASCII = [`${ String.fromCodePoint(0x212A) }ali`, `f${ String.fromCodePoint(0xE9) }dora`, `updates/m${ String.fromCodePoint(0xE1) }in`, `${ String.fromCodePoint(0x130) }stanbul`];

    test.each(["debian", "bookworm-security", "42", "updates/main"])("%s can be there, wherever", name => {
        setFileNaming(INSENSITIVE);
        expect(isRepoDirectoryName(name)).toBe(true);
        setFileNaming(SENSITIVE);
        expect(isRepoDirectoryName(name)).toBe(true);
    });

    test.each(["Debian", "updates/Main", ...OTHER_THAN_ASCII])("%s can be there only where case counts", name => {
        setFileNaming(INSENSITIVE);
        expect(isRepoDirectoryName(name)).toBe(false);
        setFileNaming(SENSITIVE);
        expect(isRepoDirectoryName(name)).toBe(true);
    });
});
