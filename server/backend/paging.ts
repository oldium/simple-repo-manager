import { RepoValidationError } from "../lib/errors.ts";

export type Page = { limit?: number; cursor?: string };

/** Larger page limits are clamped to this */
export const MAX_PAGE_SIZE = 1000;

export type Listing<T> = { items: T[]; nextCursor?: string };

export type SourceListing = Listing<{ distro: string; release: string; source: string; version: string }>;

export type FileListing = Listing<{ distro: string; release: string; path: string }>;

/** "installer" is a Debian udeb, the others mean the same in both formats */
export type PackageKind = "binary" | "debug" | "installer" | "source";

/** A source package's architecture is source for Debian, src for RPM, as their own tools name it */
export type FoundPackage = {
    distro: string; release: string; kind: PackageKind; package: string; version: string; architecture: string;
    source: string; sourceVersion: string; path: string;
};

/** A package once per release, its versions newest first */
export type FoundPackageVersions = {
    distro: string; release: string; kind: PackageKind; package: string; source: string;
    versions: { version: string; architectures: string[] }[];
};

/**
 * name and source match the package's own name and its source's, with the wildcards * and ?. version compares only
 * the parts it has; latest keeps the newest of what the other filters keep.
 */
export type PackageQuery = {
    distro?: string; release?: string; name?: string; source?: string; kinds?: PackageKind[]; architectures?: string[];
    version?: string; latest?: boolean;
};

/** A LIKE pattern, with ESCAPE '!', for a name with the wildcards * and ?; what LIKE takes as a wildcard counts as itself */
export function wildcardPattern(name: string): string {
    return name.replace(/[!%_]/g, "!$&").replaceAll("*", "%").replaceAll("?", "_");
}

export type PackageGroup<R> = { package: string; kind: PackageKind; rows: R[] };

/**
 * The rows of a search in package order, one group per package and kind, those after the cursor's. A package is read
 * whole before its groups count, and reading stops once there are `limit` of them.
 */
export function groupPackages<R>(rows: Iterable<R>, after: string[] | undefined, limit: number, packageOf: (row: R) => string,
    kindOf: (row: R) => PackageKind): PackageGroup<R>[] {

    const groups: PackageGroup<R>[] = [];
    let current: string | undefined;
    let kinds = new Map<PackageKind, R[]>();
    const flush = () => {
        for (const kind of [...kinds.keys()].sort()) {
            if (after === undefined || current !== after[0] || kind > after[1]) {
                groups.push({ package: current!, kind, rows: kinds.get(kind)! });
            }
        }
        kinds = new Map();
    };
    for (const row of rows) {
        if (packageOf(row) !== current) {
            if (current !== undefined) {
                flush();
                if (groups.length >= limit) {
                    return groups;
                }
            }
            current = packageOf(row);
        }
        const kind = kindOf(row);
        (kinds.get(kind) ?? kinds.set(kind, []).get(kind)!).push(row);
    }
    if (current !== undefined) {
        flush();
    }
    return groups;
}

/** The named parameters the search statements share */
export function searchParameters(q: PackageQuery, releaseId: number) {
    return {
        release: releaseId,
        name: q.name === undefined ? null : wildcardPattern(q.name),
        source: q.source === undefined ? null : wildcardPattern(q.source),
        kinds: q.kinds === undefined ? null : JSON.stringify(q.kinds),
        architectures: q.architectures === undefined ? null : JSON.stringify(q.architectures),
        version: q.version ?? null,
        latest: q.latest ? 1 : 0,
    };
}

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
