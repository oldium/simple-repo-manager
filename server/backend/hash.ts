import { createHash, type Hash } from "crypto";
import { createReadStream } from "fs";
import { Transform } from "stream";

export type HashName = "md5" | "sha1" | "sha256" | "sha512";

export type Digests = { size: number; md5: string; sha1: string; sha256: string; sha512: string };

const ALL_HASHES: HashName[] = ["md5", "sha1", "sha256", "sha512"];

export class MultiHash {
    private readonly hashes: [HashName, Hash][];
    private size = 0;

    constructor(names: HashName[]) {
        this.hashes = names.map(name => [name, createHash(name)]);
    }

    update(b: Uint8Array): void {
        this.size += b.byteLength;
        for (const [, hash] of this.hashes) {
            hash.update(b);
        }
    }

    digest(): { size: number } & Partial<Record<HashName, string>> {
        const result: { size: number } & Partial<Record<HashName, string>> = { size: this.size };
        for (const [name, hash] of this.hashes) {
            result[name] = hash.digest("hex");
        }
        return result;
    }
}

export async function hashFile(file: string): Promise<Digests> {
    const hash = new MultiHash(ALL_HASHES);
    for await (const chunk of createReadStream(file)) {
        hash.update(chunk as Buffer);
    }
    return hash.digest() as Digests;
}

export function hashingTransform(onEnd: (d: Digests) => void): Transform {
    const hash = new MultiHash(ALL_HASHES);
    return new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
        },
        flush(callback) {
            onEnd(hash.digest() as Digests);
            callback();
        },
    });
}
