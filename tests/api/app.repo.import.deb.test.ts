// noinspection DuplicatedCode

import { describe, expect, test, jest } from "@jest/globals";
import request from "supertest";
import fs from "node:fs/promises";
import osPath from "node:path";
import dedent from "dedent";

import { createFiles, withLocalTmpDir } from "../utils.ts";
import {
    readIncomingDirFromRepreproArgsSync,
    simulateRepreproProcessIncoming,
    spawnMock,
} from "../mocks.ts";

/**
 * Dispatch-style spawn mock: for each `processincoming` invocation, look at
 * the `IncomingDir` written in the current confdir's `incoming` file and
 * decide whether to return success (and drain the dir) or to return a
 * non-zero exit code so that the importer classifies that directory as
 * failed. All other reprepro subcommands (export, clearvanished, ...) are
 * always successful.
 */
function dispatchingRepreproSpawn() {
    return (executable: string, args: string[]) => {
        if (executable !== "reprepro") {
            return spawnMock(0, "", "")(executable, args);
        }

        const isProcessIncoming = args.includes("processincoming");
        if (!isProcessIncoming) {
            return spawnMock(0, "", "")(executable, args);
        }

        const incomingDir = readIncomingDirFromRepreproArgsSync(args) ?? "";

        // forky/main => return non-zero so processDistribution records an error.
        if (incomingDir.includes("/forky/")) {
            return spawnMock(1, "", "reprepro failure for forky")(executable, args);
        }

        // bullseye/main => succeed on the .changes-referenced files but leave a
        // stray file that isn't mentioned in any .changes. reprepro never touches
        // files it doesn't know about, so they sit in staging — our classifier
        // reports them as "skipped".
        if (incomingDir.includes("/bullseye/")) {
            return spawnMock(0, "", "", undefined,
                async (exe, a) => {
                    await simulateRepreproProcessIncoming(exe, a, {
                        keepPredicate: (name) => name === "README.txt",
                    });
                })(executable, args);
        }

        // Success path: drain the IncomingDir like real reprepro would.
        return spawnMock(0, "", "", undefined, simulateRepreproProcessIncoming)(executable, args);
    };
}

describe("import_repository — per-file status (ok/skipped/failed)", () => {
    test("reports imported, skipped, and failed entries together in one call",
        withLocalTmpDir(async () => {
            const spawn = jest.fn(dispatchingRepreproSpawn());
            jest.unstable_mockModule("node:child_process", () => ({ spawn }));

            const createTestApp = (await import("../testapp.ts")).default;
            const app = await createTestApp({
                paths: {
                    incomingDir: "incoming",
                    repoStateDir: "repo-state",
                    repoDir: "repo",
                    signScript: "sign.sh",
                },
            });

            // OK dir: debian/trixie/main — full bundle with .changes; mock drains it.
            // Skipped dir: debian/bookworm/main — no .changes present.
            // Failed dir: debian/forky/main — has .changes; mock returns non-zero.
            // Skipped-by-reprepro dir: debian/bullseye/main — has .changes;
            //   mock succeeds but a stray file unrelated to any .changes remains.
            await createFiles({
                "incoming/staging/deb/debian/trixie/main/pkg-ok_1.0-1_amd64.changes": dedent`
                    Distribution: trixie
                    Source: pkg-ok
                    Version: 1.0-1
                    Architecture: source amd64
                    Files:
                     pkg-ok_1.0-1.dsc
                     pkg-ok_1.0-1_amd64.deb\n
                `,
                "incoming/staging/deb/debian/trixie/main/pkg-ok_1.0-1.dsc": "dsc-body\n",
                "incoming/staging/deb/debian/trixie/main/pkg-ok_1.0-1_amd64.deb": "deb-body\n",

                "incoming/staging/deb/debian/bookworm/main/pkg-skip_2.0-1.dsc": "dsc-body\n",
                "incoming/staging/deb/debian/bookworm/main/pkg-skip_2.0-1_amd64.deb": "deb-body\n",

                "incoming/staging/deb/debian/forky/main/pkg-fail_3.0-1_amd64.changes": dedent`
                    Distribution: forky
                    Source: pkg-fail
                    Version: 3.0-1
                    Architecture: source amd64
                    Files:
                     pkg-fail_3.0-1.dsc
                     pkg-fail_3.0-1_amd64.deb\n
                `,
                "incoming/staging/deb/debian/forky/main/pkg-fail_3.0-1.dsc": "dsc-body\n",
                "incoming/staging/deb/debian/forky/main/pkg-fail_3.0-1_amd64.deb": "deb-body\n",

                "incoming/staging/deb/debian/bullseye/main/pkg-left_4.0-1_amd64.changes": dedent`
                    Distribution: bullseye
                    Source: pkg-left
                    Version: 4.0-1
                    Architecture: source amd64
                    Files:
                     pkg-left_4.0-1.dsc
                     pkg-left_4.0-1_amd64.deb\n
                `,
                "incoming/staging/deb/debian/bullseye/main/pkg-left_4.0-1.dsc": "dsc-body\n",
                "incoming/staging/deb/debian/bullseye/main/pkg-left_4.0-1_amd64.deb": "deb-body\n",
                "incoming/staging/deb/debian/bullseye/main/README.txt": "stray file\n",
            });

            const response = await request(app)
                .post("/api/v1/mcp")
                .set("Content-Type", "application/json")
                .set("Accept", "application/json, text/event-stream")
                .send({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: { name: "import_repository", arguments: {} },
                });

            expect(response.status).toBe(200);
            expect(response.body.result.isError).toBeFalsy();

            const { ok, files } = response.body.result.structuredContent as {
                ok: boolean,
                files: Array<{ filename: string, path: string, status: string, reason?: string }>
            };

            // At least one failed entry means the batch was not fully ok.
            expect(ok).toBe(false);

            const byStatus = {
                ok: files.filter((f) => f.status === "ok"),
                skipped: files.filter((f) => f.status === "skipped"),
                failed: files.filter((f) => f.status === "failed"),
            };
            // Exact counts per fixture:
            //   trixie/main    : 3 ok (changes, dsc, deb — all drained)
            //   bullseye/main  : 3 ok (changes, dsc, deb drained) + 1 skipped (stray README.txt)
            //   bookworm/main  : 2 skipped (dsc, deb — no .changes present)
            //   forky/main     : 3 failed (changes, dsc, deb — reprepro errored)
            expect(byStatus.ok).toHaveLength(6);
            expect(byStatus.skipped).toHaveLength(3);
            expect(byStatus.failed).toHaveLength(3);

            for (const f of byStatus.ok) {
                expect(f.path).toMatch(/^deb\/debian\/(trixie|bullseye)\/main\//);
            }
            for (const f of byStatus.skipped) {
                expect(f.path).toMatch(/^deb\/debian\/(bookworm|bullseye)\/main\//);
                expect(f.reason).toMatch(/reprepro did not process/i);
            }
            for (const f of byStatus.failed) {
                expect(f.reason).toMatch(/correlation id=/);
                expect(f.path).toMatch(/^deb\/debian\/forky\/main\//);
            }

            // Sanity: dirs that should have been drained are empty; dirs that
            // should have stayed still contain their pre-import files.
            expect(await fs.readdir(osPath.join(
                "incoming", "process", "deb", "debian", "trixie", "main"))).toHaveLength(0);
            expect((await fs.readdir(osPath.join(
                "incoming", "process", "deb", "debian", "bookworm", "main"))).length)
                .toBeGreaterThan(0);
            expect((await fs.readdir(osPath.join(
                "incoming", "process", "deb", "debian", "forky", "main"))).length)
                .toBeGreaterThan(0);
            // bullseye retains exactly the stray README.txt reprepro didn't touch.
            const bullseyeRemaining = await fs.readdir(osPath.join(
                "incoming", "process", "deb", "debian", "bullseye", "main"));
            expect(bullseyeRemaining).toEqual(["README.txt"]);
        }),
        15000
    );
});
