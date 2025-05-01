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
            await this.execPromise;
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

        const waitExecPromise = this.waitExec(execPromise);
        if (waitExecPromise) {
            await waitExecPromise;
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
