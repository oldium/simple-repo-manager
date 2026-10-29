import type { Database } from "node:sqlite";
import { KEYS_END_SQL } from "../chunked.ts";
import type { IndexSource } from "../chunked.ts";
import { renderContentsLine } from "./stanzas.ts";

/** Which binaries a Contents index lists; ddebs appear in none */
const BINARY_KINDS: Record<string, string | undefined> = { contents: "deb", "contents-udeb": "udeb" };

type IndexRow = { release_id: number; kind: string; component: string; architecture: string };

/**
 * The lines of one Contents index: every path of the release's binaries of the index's component, architecture
 * (plus arch all) and kind, each with the sorted distinct section/package list of the binaries that carry it.
 */
export function contentsRecords(db: Database, indexFileId: number): IndexSource {
    const index = db.prepare("SELECT release_id, kind, component, architecture FROM index_files WHERE id = ?").get(indexFileId) as
        IndexRow | undefined;
    if (index === undefined) {
        throw new Error(`Index file ${ indexFileId } does not exist`);
    }
    const kind = BINARY_KINDS[index.kind];
    if (kind === undefined) {
        throw new Error(`Index file ${ indexFileId } is a ${ index.kind } index, not Contents`);
    }
    // CROSS JOIN keeps paths first, where the planner would start from the binaries: a dirty chunk costs its key range, and a
    // full build streams in the index's order
    const select = db.prepare(`
        SELECT p.path AS path, group_concat(DISTINCT b.section || '/' || b.package ORDER BY b.section || '/' || b.package) AS qualified
            FROM deb_binary_paths p CROSS JOIN deb_binaries b ON b.id = p.binary_id
            WHERE p.release_id = ?1 AND p.component = ?2 AND b.kind = ?3 AND b.architecture IN (?4, 'all')
                AND p.path >= ?5 AND p.path < coalesce(?6, ${ KEYS_END_SQL })
            GROUP BY p.path ORDER BY p.path`);
    return function* (startKey, endKey) {
        for (const row of select.iterate(index.release_id, index.component, kind, index.architecture, startKey, endKey ?? null)) {
            const path = row.path as string;
            yield { key: path, text: renderContentsLine(path, (row.qualified as string).split(",")) };
        }
    };
}
