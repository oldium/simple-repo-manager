// eslint-disable-next-line no-undef,@typescript-eslint/no-require-imports
const Sequencer = require('@jest/test-sequencer').default;

class CustomSequencer extends Sequencer {
    sort(tests) {
        const copyTests = [...super.sort(tests)];
        return copyTests.sort((a, b) => {
            const hasPrecondition = (test) => test.path.includes("precondition");
            return hasPrecondition(a) === hasPrecondition(b)
                ? 0
                : hasPrecondition(a)
                    ? -1
                    : 1;
        });
    }
}

// eslint-disable-next-line no-undef
module.exports = CustomSequencer;
