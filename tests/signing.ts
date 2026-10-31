import crypto from "crypto";
import fs from "fs/promises";
import osPath from "path";
import * as openpgp from "openpgp";
import { stripClearsign } from "../server/backend/control.ts";
import { clearsign } from "../server/backend/pgp.ts";

const LEAD_SIZE = 96;
const HEADER_INTRO_SIZE = 16;
const ENTRY_SIZE = 16;
const REGION_TAG = 62;
const SIG_DSAHEADER = 267;
const SIG_RSAHEADER = 268;
const SIG_OPENPGP = 278;
const TYPE_INT32 = 4;
const TYPE_INT64 = 5;
const TYPE_STRING = 6;
const TYPE_BIN = 7;
const TYPE_STRING_ARRAY = 8;
const RSA_ALGORITHMS: readonly string[] = ["rsaEncryptSign", "rsaSign"];

type Entry = { tag: number; type: number; offset: number; count: number };

function headerEnd(bytes: Buffer, start: number): number {
    return start + HEADER_INTRO_SIZE + bytes.readUInt32BE(start + 8) * ENTRY_SIZE + bytes.readUInt32BE(start + 12);
}

function aligned(position: number): number {
    return position + (8 - position % 8) % 8;
}

function alignment(type: number): number {
    return type === TYPE_INT32 ? 4 : type === TYPE_INT64 ? 8 : 1;
}

function storedData(store: Buffer, { type, offset, count }: Entry): Buffer {
    if (type === TYPE_INT32 || type === TYPE_INT64) {
        return store.subarray(offset, offset + count * alignment(type));
    }
    if (type === TYPE_STRING || type === TYPE_STRING_ARRAY) {
        let end = offset;
        for (let i = 0; i < (type === TYPE_STRING ? 1 : count); i++) {
            end = store.indexOf(0, end) + 1;
        }
        return store.subarray(offset, end);
    }
    return store.subarray(offset, offset + count);
}

/** Where the main header of an rpm starts and ends */
export function rpmHeaderBounds(bytes: Buffer): { start: number; end: number } {
    const start = aligned(headerEnd(bytes, LEAD_SIZE));
    return { start, end: headerEnd(bytes, start) };
}

/** The rpm with its signature header holding one signature of the main header, as rpmsign leaves it; an earlier signature goes */
export async function signRpm(bytes: Buffer, key: openpgp.PrivateKey, format: 4 | 6 = 4, mangle: (signature: Buffer) => Buffer = signature => signature): Promise<Buffer> {
    const { start, end } = rpmHeaderBounds(bytes);
    const message = await openpgp.createMessage({ binary: bytes.subarray(start, end) });
    const binary = mangle(Buffer.from(await openpgp.sign({ message, signingKeys: key, detached: true, format: "binary" })));
    const signature = format === 6 ? Buffer.from(`${ binary.toString("base64") }\0`) : binary;
    const signing = await key.getSigningKey();
    const tag = format === 6 ? SIG_OPENPGP : RSA_ALGORITHMS.includes(signing.getAlgorithmInfo().algorithm) ? SIG_RSAHEADER : SIG_DSAHEADER;

    const count = bytes.readUInt32BE(LEAD_SIZE + 8);
    const size = bytes.readUInt32BE(LEAD_SIZE + 12);
    const entriesAt = LEAD_SIZE + HEADER_INTRO_SIZE;
    const entries: Entry[] = [];
    for (let i = 0; i < count; i++) {
        const at = entriesAt + i * ENTRY_SIZE;
        entries.push({ tag: bytes.readUInt32BE(at), type: bytes.readUInt32BE(at + 4), offset: bytes.readUInt32BE(at + 8), count: bytes.readUInt32BE(at + 12) });
    }
    const kept = entries.filter(entry => entry.tag !== SIG_RSAHEADER && entry.tag !== SIG_DSAHEADER && entry.tag !== SIG_OPENPGP);
    const store = bytes.subarray(entriesAt + count * ENTRY_SIZE, entriesAt + count * ENTRY_SIZE + size);
    const added = { tag, type: format === 6 ? TYPE_STRING_ARRAY : TYPE_BIN, offset: 0, count: format === 6 ? 1 : signature.length };
    const all = [...kept, added].sort((a, b) => a.tag - b.tag);
    // rpm wants the data in the order of the tags, with the region's trailer last
    const chunks: Buffer[] = [];
    let length = 0;
    for (const entry of all.filter(e => e.tag !== REGION_TAG)) {
        const data = entry === added ? signature : storedData(store, entry);
        const padding = Buffer.alloc((alignment(entry.type) - length % alignment(entry.type)) % alignment(entry.type));
        entry.offset = length + padding.length;
        chunks.push(padding, data);
        length += padding.length + data.length;
    }
    const region = all.find(entry => entry.tag === REGION_TAG) as Entry;
    region.offset = length;
    const trailer = Buffer.alloc(ENTRY_SIZE);
    trailer.writeUInt32BE(REGION_TAG, 0);
    trailer.writeUInt32BE(TYPE_BIN, 4);
    trailer.writeInt32BE(-all.length * ENTRY_SIZE, 8);
    trailer.writeUInt32BE(ENTRY_SIZE, 12);
    const newStore = Buffer.concat([...chunks, trailer]);

    const intro = Buffer.from(bytes.subarray(LEAD_SIZE, LEAD_SIZE + HEADER_INTRO_SIZE));
    intro.writeUInt32BE(all.length, 8);
    intro.writeUInt32BE(newStore.length, 12);
    const index = Buffer.alloc(all.length * ENTRY_SIZE);
    all.forEach((entry, i) => {
        index.writeUInt32BE(entry.tag, i * ENTRY_SIZE);
        index.writeUInt32BE(entry.type, i * ENTRY_SIZE + 4);
        index.writeUInt32BE(entry.offset, i * ENTRY_SIZE + 8);
        index.writeUInt32BE(entry.count, i * ENTRY_SIZE + 12);
    });
    const signatureEnd = LEAD_SIZE + HEADER_INTRO_SIZE + index.length + newStore.length;
    return Buffer.concat([bytes.subarray(0, LEAD_SIZE), intro, index, newStore, Buffer.alloc(aligned(signatureEnd) - signatureEnd), bytes.subarray(start)]);
}

function digestLine(data: Buffer | string, algorithm: string): string {
    return crypto.createHash(algorithm).update(data).digest("hex");
}

/** The name's text with the checksums of one listed file replaced, as they have to follow a file that changes */
export function withListedFile(changes: string, before: Buffer | string, after: Buffer | string): string {
    let text = changes;
    for (const algorithm of ["md5", "sha1", "sha256"]) {
        text = text.replaceAll(`${ digestLine(before, algorithm) } ${ Buffer.byteLength(before) } `, `${ digestLine(after, algorithm) } ${ Buffer.byteLength(after) } `);
    }
    return text;
}

/** Signs the .dsc and the .changes of the bundles in a directory in place, with what debsign leaves: the .changes lists the signed .dsc */
export async function signBundle(dir: string, key: openpgp.PrivateKey): Promise<void> {
    const names = await fs.readdir(dir);
    let dscChanges: [Buffer, string][] = [];
    for (const name of names.filter(n => n.endsWith(".dsc"))) {
        const file = osPath.join(dir, name);
        const before = await fs.readFile(file);
        const signed = await clearsign(stripClearsign(before.toString("utf8")), key);
        await fs.writeFile(file, signed);
        dscChanges = [...dscChanges, [before, signed]];
    }
    for (const name of names.filter(n => n.endsWith(".changes"))) {
        const file = osPath.join(dir, name);
        let text = stripClearsign(await fs.readFile(file, "utf8"));
        for (const [before, after] of dscChanges) {
            text = withListedFile(text, before, after);
        }
        await fs.writeFile(file, await clearsign(text, key));
    }
}
