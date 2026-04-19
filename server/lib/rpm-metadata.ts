import fs from "node:fs/promises";
import fs_ from "node:fs";
import osPath from "path";
import sax from "sax";
import zlib from "node:zlib";
import type { Readable } from "node:stream";

export type Compression = "gz" | "zst";

export type PrimaryLocation = {
    path: string;
    compression: Compression;
};

function detectCompression(href: string): Compression {
    if (href.endsWith(".zst")) return "zst";
    if (href.endsWith(".gz")) return "gz";
    throw new Error(`Unsupported primary.xml compression for ${ href }`);
}

export async function resolvePrimaryLocation(releaseDir: string): Promise<PrimaryLocation | null> {
    const repomdPath = osPath.join(releaseDir, "repodata", "repomd.xml");
    let content: string;
    try {
        content = await fs.readFile(repomdPath, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw err;
    }

    const parser = sax.parser(true, { trim: false });
    let insideData: string | null = null;
    let href: string | null = null;

    parser.onopentag = (node: sax.Tag | sax.QualifiedTag) => {
        if (node.name === "data") {
            insideData = (node.attributes["type"] as string) ?? null;
        } else if (node.name === "location" && insideData === "primary") {
            href = (node.attributes["href"] as string) ?? null;
        }
    };
    parser.onclosetag = (name: string) => {
        if (name === "data") {
            insideData = null;
        }
    };

    parser.write(content).close();

    if (!href) {
        throw new Error(`No <data type="primary"> entry in ${ repomdPath }`);
    }
    return {
        path: osPath.join(releaseDir, href),
        compression: detectCompression(href)
    };
}

export type PackageInfo = {
    name: string;
    arch: string;
    ver: string;
    rel: string;
    href: string;
    sourcerpm: string;
};

function createDecompressor(compression: Compression): NodeJS.ReadWriteStream {
    switch (compression) {
        case "zst":
            return zlib.createZstdDecompress();
        case "gz":
            return zlib.createGunzip();
    }
}

export async function* streamPackages(releaseDir: string): AsyncGenerator<PackageInfo> {
    const primary = await resolvePrimaryLocation(releaseDir);
    if (!primary) {
        return;
    }

    const fileStream = fs_.createReadStream(primary.path);
    const decompressed = fileStream.pipe(createDecompressor(primary.compression));
    const parser = sax.createStream(true, { trim: false });

    const queue: PackageInfo[] = [];
    let finished = false;
    let pending: { resolve: () => void } | null = null;
    let error: Error | null = null;

    const wake = () => {
        if (pending) {
            const p = pending;
            pending = null;
            p.resolve();
        }
    };

    let current: Partial<PackageInfo> | null = null;
    let textTarget: ((text: string) => void) | null = null;

    parser.on("opentag", (node: sax.Tag | sax.QualifiedTag) => {
        if (node.name === "package") {
            current = { sourcerpm: "" };
        } else if (current) {
            if (node.name === "name") {
                textTarget = (t) => { current!.name = (current!.name ?? "") + t; };
            } else if (node.name === "arch") {
                textTarget = (t) => { current!.arch = (current!.arch ?? "") + t; };
            } else if (node.name === "version") {
                current.ver = (node.attributes as Record<string, string>)["ver"] ?? "";
                current.rel = (node.attributes as Record<string, string>)["rel"] ?? "";
            } else if (node.name === "location") {
                current.href = (node.attributes as Record<string, string>)["href"] ?? "";
            } else if (node.name === "rpm:sourcerpm") {
                textTarget = (t) => { current!.sourcerpm += t; };
            }
        }
    });

    parser.on("text", (text: string) => {
        if (textTarget) textTarget(text);
    });
    parser.on("cdata", (text: string) => {
        if (textTarget) textTarget(text);
    });

    parser.on("closetag", (name: string) => {
        if (textTarget) textTarget = null;
        if (name === "package" && current) {
            const pkg = current as PackageInfo;
            if (pkg.name && pkg.arch && pkg.href && pkg.ver !== undefined && pkg.rel !== undefined) {
                queue.push(pkg);
                wake();
            }
            current = null;
        }
    });

    parser.on("error", (err: Error) => { error = err; wake(); });
    parser.on("end", () => { finished = true; wake(); });
    decompressed.on("error", (err: Error) => { error = err; wake(); });
    fileStream.on("error", (err: Error) => { error = err; wake(); });

    (decompressed as unknown as Readable).pipe(parser as unknown as NodeJS.WritableStream);

    while (true) {
        if (error) throw error;
        if (queue.length > 0) {
            yield queue.shift()!;
            continue;
        }
        if (finished) return;
        await new Promise<void>((resolve) => { pending = { resolve }; });
    }
}

export function sourceIdentityOf(pkg: PackageInfo): string | null {
    if (pkg.arch === "src") {
        return `${ pkg.name }-${ pkg.ver }-${ pkg.rel }.src.rpm`;
    }
    return pkg.sourcerpm !== "" ? pkg.sourcerpm : null;
}

export function matchesSourceIdentity(input: string, identity: string): boolean {
    if (input.length === 0) return false;
    const re = new RegExp(`^${ RegExp.escape(input) }(\\.[^.\\s]+)?\\.src\\.rpm$`);
    return re.test(identity);
}
