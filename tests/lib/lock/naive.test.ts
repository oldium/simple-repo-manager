// noinspection DuplicatedCode

import lock from "../../../server/lib/lock/naive.ts";

describe('Test naive locking strategy', () => {
    test('Check that move executes when on its own', async () => {
        let counter = 0;

        const { promise: move1Promise, resolve: move1Resolve } = Promise.withResolvers<void>();

        const move1Seq = lock.forMove(async () => {
            await move1Promise;
            return ++counter;
        });

        move1Resolve();

        expect(await move1Seq).toBe(1);
    });

    test('Check that exec executes when on its own', async () => {
        let counter = 0;

        const { promise: exec1Promise, resolve: exec1Resolve } = Promise.withResolvers<void>();

        const exec1Seq = lock.forExecOnce(async () => {
            await exec1Promise;
            return ++counter;
        });

        exec1Resolve();

        expect(await exec1Seq).toBe(1);
    });

    test('Check that exec is not executed while move runs', async () => {
        let counter = 0;

        const { promise: move1Promise, resolve: move1Resolve } = Promise.withResolvers<void>();
        const { promise: exec1Promise, resolve: exec1Resolve } = Promise.withResolvers<void>();

        const move1Seq = lock.forMove(async () => { await move1Promise; return ++counter; });
        const exec1Seq = lock.forExecOnce(async () => { await exec1Promise; return ++counter; });

        exec1Resolve();
        move1Resolve();

        expect(await move1Seq).toBe(1);
        expect(await exec1Seq).toBe(2);
    });

    test('Check that exec is not executed while multiple move runs', async () => {
        let counter = 0;

        const { promise: move1Promise, resolve: move1Resolve } = Promise.withResolvers<void>();
        const { promise: move2Promise, resolve: move2Resolve } = Promise.withResolvers<void>();
        const { promise: exec1Promise, resolve: exec1Resolve } = Promise.withResolvers<void>();

        const move1Seq = lock.forMove(async () => {
            await move1Promise;
            return ++counter;
        });
        const move2Seq = lock.forMove(async () => {
            await move2Promise;
            return ++counter;
        });
        const exec1Seq = lock.forExecOnce(async () => {
            await exec1Promise;
            return ++counter;
        });

        exec1Resolve();
        move2Resolve();
        move1Resolve();

        expect(await move1Seq).toBeLessThan(3);
        expect(await move2Seq).toBeLessThan(3);
        expect(await exec1Seq).toBe(3);
    });

    test('Check that move is not executed while exec runs', async () => {
        let counter = 0;

        const { promise: move1Promise, resolve: move1Resolve } = Promise.withResolvers<void>();
        const { promise: exec1Promise, resolve: exec1Resolve } = Promise.withResolvers<void>();

        const exec1Seq = lock.forExecOnce(async () => { await exec1Promise; return ++counter; });
        const move1Seq = lock.forMove(async () => { await move1Promise; return ++counter; });

        move1Resolve();
        exec1Resolve();

        expect(await move1Seq).toBe(2);
        expect(await exec1Seq).toBe(1);
    });

    test('Check that multiple moves are not executed while exec runs', async () => {
        let counter = 0;

        const { promise: move1Promise, resolve: move1Resolve } = Promise.withResolvers<void>();
        const { promise: move2Promise, resolve: move2Resolve } = Promise.withResolvers<void>();
        const { promise: exec1Promise, resolve: exec1Resolve } = Promise.withResolvers<void>();

        const exec1Seq = lock.forExecOnce(async () => {
            await exec1Promise;
            return ++counter;
        });
        const move1Seq = lock.forMove(async () => {
            await move1Promise;
            return ++counter;
        });
        const move2Seq = lock.forMove(async () => {
            await move2Promise;
            return ++counter;
        });

        move2Resolve();
        move1Resolve();
        exec1Resolve();

        expect(await exec1Seq).toBe(1);
        expect(await move1Seq).toBeGreaterThan(1);
        expect(await move2Seq).toBeGreaterThan(1);
    });

    test('Check that multiple execs after one exec are merged into one', async () => {
        let counter = 0;

        const { promise: exec1Promise, resolve: exec1Resolve } = Promise.withResolvers<void>();
        const { promise: exec2Promise, resolve: exec2Resolve } = Promise.withResolvers<void>();
        const { promise: exec3Promise, resolve: exec3Resolve } = Promise.withResolvers<void>();

        const exec1Seq = lock.forExecOnce(async () => {
            await exec1Promise;
            return [++counter, 1];
        });
        const exec2Seq = lock.forExecOnce(async () => {
            await exec2Promise;
            return [++counter, 2];
        });
        const exec3Seq = lock.forExecOnce(async () => {
            await exec3Promise;
            return [++counter, 3];
        });

        exec3Resolve();
        exec2Resolve();
        exec1Resolve();

        expect(await exec1Seq).toEqual([1, 1]);
        expect(await exec2Seq).toEqual([2, 2]);
        expect(await exec3Seq).toEqual([2, 2]);
    });

    test('Check that multiple execs after one exec and move are merged and run after move', async () => {
        let counter = 0;

        const { promise: movePromise, resolve: moveResolve } = Promise.withResolvers<void>();
        const { promise: exec1Promise, resolve: exec1Resolve } = Promise.withResolvers<void>();
        const { promise: exec2Promise, resolve: exec2Resolve } = Promise.withResolvers<void>();
        const { promise: exec3Promise, resolve: exec3Resolve } = Promise.withResolvers<void>();

        const exec1Seq = lock.forExecOnce(async () => {
            await exec1Promise;
            return ++counter;
        });
        const moveSeq = lock.forMove(async () => {
            await movePromise;
            return ++counter;
        });
        const exec2Seq = lock.forExecOnce(async () => {
            await exec2Promise;
            return [++counter, 2];
        });
        const exec3Seq = lock.forExecOnce(async () => {
            await exec3Promise;
            return [++counter, 3];
        });

        exec3Resolve();
        exec2Resolve();
        moveResolve();
        exec1Resolve();

        expect(await exec1Seq).toBe(1);
        expect(await moveSeq).toBe(2);
        expect(await exec2Seq).toEqual([3, 2]);
        expect(await exec3Seq).toEqual([3, 2]);
    });

    test('Check that multiple execs after one exec and multiple moves are merged and run after moves', async () => {
        let counter = 0;

        const { promise: move1Promise, resolve: move1Resolve } = Promise.withResolvers<void>();
        const { promise: move2Promise, resolve: move2Resolve } = Promise.withResolvers<void>();
        const { promise: exec1Promise, resolve: exec1Resolve } = Promise.withResolvers<void>();
        const { promise: exec2Promise, resolve: exec2Resolve } = Promise.withResolvers<void>();
        const { promise: exec3Promise, resolve: exec3Resolve } = Promise.withResolvers<void>();

        const exec1Seq = lock.forExecOnce(async () => {
            await exec1Promise;
            return ++counter;
        });
        const move1Seq = lock.forMove(async () => {
            await move1Promise;
            return ++counter;
        });
        const move2Seq = lock.forMove(async () => {
            await move2Promise;
            return ++counter;
        });
        const exec2Seq = lock.forExecOnce(async () => {
            await exec2Promise;
            return [++counter, 2];
        });
        const exec3Seq = lock.forExecOnce(async () => {
            await exec3Promise;
            return [++counter, 3];
        });

        exec3Resolve();
        exec2Resolve();
        move2Resolve();
        move1Resolve();
        exec1Resolve();

        expect(await exec1Seq).toBe(1);
        expect(await move1Seq).toBeGreaterThanOrEqual(2);
        expect(await move1Seq).toBeLessThanOrEqual(3);
        expect(await move2Seq).toBeGreaterThanOrEqual(2);
        expect(await move2Seq).toBeLessThanOrEqual(3);
        expect(await exec2Seq).toEqual([4, 2]);
        expect(await exec3Seq).toEqual([4, 2]);
    });

    test('Check that sequence of multiple moves, execs, moves and execs is correct', async () => {
        let counter = 0;

        const { promise: move1Promise, resolve: move1Resolve } = Promise.withResolvers<void>();
        const { promise: move2Promise, resolve: move2Resolve } = Promise.withResolvers<void>();
        const { promise: exec1Promise, resolve: exec1Resolve } = Promise.withResolvers<void>();
        const { promise: exec2Promise, resolve: exec2Resolve } = Promise.withResolvers<void>();
        const { promise: move3Promise, resolve: move3Resolve } = Promise.withResolvers<void>();
        const { promise: move4Promise, resolve: move4Resolve } = Promise.withResolvers<void>();
        const { promise: exec3Promise, resolve: exec3Resolve } = Promise.withResolvers<void>();
        const { promise: exec4Promise, resolve: exec4Resolve } = Promise.withResolvers<void>();

        const move1Seq = lock.forMove(async () => {
            await move1Promise;
            return ++counter;
        });
        const move2Seq = lock.forMove(async () => {
            await move2Promise;
            return ++counter;
        });
        const exec1Seq = lock.forExecOnce(async () => {
            await exec1Promise;
            return [++counter, 1];
        });
        const exec2Seq = lock.forExecOnce(async () => {
            await exec2Promise;
            return [++counter, 2];
        });
        const move3Seq = lock.forMove(async () => {
            await move3Promise;
            return ++counter;
        });
        const move4Seq = lock.forMove(async () => {
            await move4Promise;
            return ++counter;
        });
        const exec3Seq = lock.forExecOnce(async () => {
            await exec3Promise;
            return [++counter, 3];
        });
        const exec4Seq = lock.forExecOnce(async () => {
            await exec4Promise;
            return [++counter, 4];
        });

        exec4Resolve();
        exec3Resolve();
        move4Resolve();
        move3Resolve();
        exec2Resolve();
        exec1Resolve();
        move2Resolve();
        move1Resolve();

        expect(await move1Seq).toBeGreaterThanOrEqual(1);
        expect(await move1Seq).toBeLessThanOrEqual(2);
        expect(await move2Seq).toBeGreaterThanOrEqual(1);
        expect(await move2Seq).toBeLessThanOrEqual(2);

        expect(await exec1Seq).toEqual([3, 1]);

        expect(await move3Seq).toBeGreaterThanOrEqual(4);
        expect(await move3Seq).toBeLessThanOrEqual(5);
        expect(await move4Seq).toBeGreaterThanOrEqual(4);
        expect(await move4Seq).toBeLessThanOrEqual(5);

        expect(await exec2Seq).toEqual([6, 2]);
        expect(await exec3Seq).toEqual([6, 2]);
        expect(await exec4Seq).toEqual([6, 2]);
    });

    test('A failed exec rejects its caller only, with no unhandled rejection, and the next exec runs', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
        process.on("unhandledRejection", onUnhandled);
        try {
            await expect(lock.forExecOnce(async () => { throw new Error("exec failed"); })).rejects.toThrow("exec failed");
            // Node reports unhandled rejections once the microtasks have drained
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(unhandled).toEqual([]);

            expect(await lock.forExecOnce(async () => "next")).toBe("next");
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    test('A waiter queued behind a failed exec runs its own fn, a coalesced caller shares it, a later call runs again', async () => {
        const { promise: exec1Promise, resolve: exec1Resolve } = Promise.withResolvers<void>();
        const { promise: exec2Promise, resolve: exec2Resolve } = Promise.withResolvers<void>();

        const exec1Seq = lock.forExecOnce(async () => {
            await exec1Promise;
            throw new Error("exec1 failed");
        });
        const exec2Seq = lock.forExecOnce(async () => {
            await exec2Promise;
            return "exec2";
        });
        const exec3Seq = lock.forExecOnce(async () => "exec3");

        exec1Resolve();
        await expect(exec1Seq).rejects.toThrow("exec1 failed");
        exec2Resolve();

        expect(await exec2Seq).toBe("exec2");
        expect(await exec3Seq).toBe("exec2");
        expect(await lock.forExecOnce(async () => "exec4")).toBe("exec4");
    });

    test('A move arriving during an exec that fails still runs, and the next exec waits for it', async () => {
        let counter = 0;
        const { promise: exec1Promise, resolve: exec1Resolve } = Promise.withResolvers<void>();
        const { promise: movePromise, resolve: moveResolve } = Promise.withResolvers<void>();

        const exec1Seq = lock.forExecOnce(async () => {
            await exec1Promise;
            throw new Error("exec1 failed");
        });
        const moveSeq = lock.forMove(async () => {
            await movePromise;
            return ++counter;
        });
        exec1Resolve();
        await expect(exec1Seq).rejects.toThrow("exec1 failed");
        const exec2Seq = lock.forExecOnce(async () => ++counter);
        moveResolve();

        expect(await moveSeq).toBe(1);
        expect(await exec2Seq).toBe(2);
    });
});
