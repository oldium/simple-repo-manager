import { RepoValidationError } from "../lib/errors.ts";

export type Page = { limit?: number; cursor?: string };

/** Larger page limits are clamped to this */
export const MAX_PAGE_SIZE = 1000;

export type Listing<T> = { items: T[]; nextCursor?: string };

export type SourceListing = Listing<{ distro: string; release: string; source: string; version: string }>;

export type FileListing = Listing<{ distro: string; release: string; path: string }>;

function encodeCursor(tuple: string[]): string {
    return Buffer.from(JSON.stringify(tuple)).toString("base64url");
}

function decodeCursor(cursor: string | undefined, length: number): string[] | undefined {
    if (cursor === undefined) {
        return undefined;
    }
    let tuple: unknown;
    try {
        tuple = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
        throw new RepoValidationError("Invalid cursor");
    }
    if (!Array.isArray(tuple) || tuple.length !== length || tuple.some(v => typeof v !== "string")) {
        throw new RepoValidationError("Invalid cursor");
    }
    return tuple as string[];
}

function pageLimit(page: Page): number {
    const limit = page.limit ?? MAX_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1) {
        throw new RepoValidationError(`Invalid page limit ${ limit }`);
    }
    return Math.min(limit, MAX_PAGE_SIZE);
}

/** Keeps `limit` items; a cursor built from the last kept item tells that more follow */
function paginate<T>(items: T[], limit: number, tuple: (item: T) => string[]): Listing<T> {
    if (items.length <= limit) {
        return { items };
    }
    const kept = items.slice(0, limit);
    return { items: kept, nextCursor: encodeCursor(tuple(kept[kept.length - 1])) };
}

/**
 * One page of items ordered by (distro, release, ...key). The cursor is that tuple of the last item served: `releases`
 * gets it to start at its release, `fetch` gets the key part as `after` for that release only, and one item more than
 * the limit tells whether a next cursor is due.
 */
export function collectPage<R extends { distro: string; name: string }, T extends { distro: string; release: string }>(
    page: Page, keyLength: number, releases: (from?: string[]) => R[],
    fetch: (release: R, after: string[] | undefined, limit: number) => T[], key: (item: T) => string[]): Listing<T> {

    const limit = pageLimit(page);
    const cursor = decodeCursor(page.cursor, 2 + keyLength);
    const items: T[] = [];
    for (const r of releases(cursor)) {
        const after = cursor !== undefined && r.distro === cursor[0] && r.name === cursor[1] ? cursor.slice(2) : undefined;
        items.push(...fetch(r, after, limit + 1 - items.length));
        if (items.length > limit) {
            break;
        }
    }
    return paginate(items, limit, i => [i.distro, i.release, ...key(i)]);
}
