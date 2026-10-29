import assert from "node:assert";

export type RequestFn<T> = () => T | Promise<T>;

class NaiveLock {
    private moves: Set<Promise<void>> = new Set();
    private pendingExec: Promise<unknown> | null = null;
    private execPromise: Promise<unknown> | null = null;

    public async forMove<T>(fn: RequestFn<T>): Promise<T> {
        const { promise, resolve } = Promise.withResolvers<void>();

        const moves = this.moves;
        moves.add(promise);
        if (this.execPromise) {
            // The exec's failure is its callers' business; the move still runs, and its entry must be released
            await this.execPromise.catch(() => undefined);
        }

        try {
            return await fn();
        } finally {
            resolve();
            moves.delete(promise);
        }
    }

    public async forExecOnce<T>(fn: RequestFn<T>): Promise<T> {
        const { promise: execPromise, resolve: execResolve, reject: execReject } = Promise.withResolvers<T>();
        // The caller gets the error thrown below; nobody need observe it on the exec promise itself
        void execPromise.catch(() => undefined);

        const waitExecPromise = this.waitExec(execPromise);
        if (waitExecPromise) {
            // The previous exec's failure is its callers' business; this one still runs
            await waitExecPromise.catch(() => undefined);
            assert(this.execPromise === execPromise);
        }

        if (this.execPromise === execPromise) {
            const waitMovesPromise = this.waitMoves();
            if (waitMovesPromise) {
                await waitMovesPromise;
            }
            try {
                const result = await fn();
                execResolve(result);
                return result;
            } catch (err) {
                execReject(err);
                throw err;
            } finally {
                // Prepare next execution
                this.execPromise = this.pendingExec;
                this.pendingExec = null;
            }
        } else {
            assert(this.pendingExec);
            return await this.pendingExec as T;
        }
    }

    private waitMoves(): Promise<unknown> | void {
        if (this.moves.size > 0) {
            const moves = [...this.moves];
            this.moves = new Set();
            return Promise.all(moves);
        }
    }

    private waitExec(promise: Promise<unknown>): Promise<unknown> | void {
        if (!this.execPromise) {
            this.execPromise = promise;
        } else {
            if (!this.pendingExec) {
                this.pendingExec = promise;
                return this.execPromise;
            }
        }
    }
}

const naiveLock = new NaiveLock();

export default naiveLock;
