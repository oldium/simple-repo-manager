import osPath from "path";
import type { Backend } from "./index.ts";

/** Backends by resolved repoStateDir: the open promise from the first openBackend on, the instance once ready, a close in progress */
export const opening = new Map<string, Promise<Backend>>();
export const opened = new Map<string, Backend>();
export const closing = new Map<string, Promise<void>>();

function under(root: string | undefined, key: string): boolean {
    return root === undefined || key === root || key.startsWith(root + osPath.sep);
}

/** Closes the backends whose repoStateDir is below underDir, all of them without one; opens in progress are awaited first, closes last */
export async function closeBackends(underDir?: string): Promise<void> {
    const root = underDir === undefined ? undefined : osPath.resolve(underDir);
    for (const [key, pending] of [...opening]) {
        if (under(root, key)) {
            const backend = await pending.catch(() => undefined);
            await backend?.close();
        }
    }
    await Promise.allSettled([...closing].filter(([key]) => under(root, key)).map(([, done]) => done));
}
