import { describe, expect, test } from "@jest/globals";
import fs from "fs/promises";
import { directoryNameLimit } from "../../server/backend/name-limit.ts";
import { withLocalTmpDir } from "../utils.ts";

const askedHere = process.platform === "win32" || process.platform === "linux" ? test : test.skip;

describe("Tests for directoryNameLimit", () => {
    askedHere("The answer is what the file system really takes", withLocalTmpDir(async () => {
        const limit = await directoryNameLimit(".");

        expect(limit).toBeGreaterThan(0);
        await fs.writeFile("a".repeat(limit as number), "");
        await expect(fs.writeFile("a".repeat(limit as number + 1), "")).rejects.toThrow();
    }));

    test("A directory that is not there cannot answer", withLocalTmpDir(async () => {
        expect(await directoryNameLimit("does-not-exist")).toBeUndefined();
    }));

    test("Only Windows and Linux are asked", withLocalTmpDir(async () => {
        expect(await directoryNameLimit(".", "darwin")).toBeUndefined();
    }));

    test("Another platform's library is not there to ask", withLocalTmpDir(async () => {
        expect(await directoryNameLimit(".", process.platform === "win32" ? "linux" : "win32")).toBeUndefined();
    }));
});
