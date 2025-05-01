import { PassThrough } from "stream";
import Stream, { Transform, type TransformCallback } from "node:stream";
import { TypedEmitter } from "tiny-typed-emitter";

type SizeLimitStreamEvents = {
    exceeded: () => void | Promise<void>;
}

// @ts-expect-error EventEmitter is already part of Transform
export class SizeLimitStream extends Transform implements TypedEmitter<SizeLimitStreamEvents> {
    private written = 0;
    private exceeded = false;

    constructor(private limits: number) {
        super();
    }

    public _transform(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback) {
        if (!this.exceeded && chunk != null && Buffer.isBuffer(chunk)) {
            this.written += chunk.length;
            if (this.written > this.limits) {
                process.nextTick(() => this.emit('exceeded'));
                process.nextTick(callback);
            } else {
                callback(null, chunk);
            }
        } else {
            callback();
        }
    }
}

export function debugStreamEvents(stream: Stream, label = 'Stream') {
    const events = ['close', 'data', 'end', 'error', 'pause', 'resume', 'finish', 'pipe', 'unpipe'];
    events.forEach(event => {
        stream.on(event, (...args) => {
            if (["pipe", "unpipe"].includes(event)) {
                console.log(`[${ label }] Event: "${ event }"`);
            } else {
                console.log(`[${ label }] Event: "${ event }"`, ...args);
            }
        });
    });
}

export function debugPassThrough(label: string) {
    const pt = new PassThrough();
    debugStreamEvents(pt, label);
    return pt;
}
