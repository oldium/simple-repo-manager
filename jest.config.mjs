/**
 * For a detailed explanation regarding each configuration property, visit:
 * https://jestjs.io/docs/configuration
 */

/** @type {import("jest").Config} */
const config = {
    // Automatically clear mock calls, instances, contexts and results before every test
    clearMocks: true,

    verbose: false,

    // Indicates whether the coverage information should be collected while executing the test
    collectCoverage: false,

    // The directory where Jest should output its coverage files
    coverageDirectory: "coverage",

    // Indicates which provider should be used to instrument code for coverage
    coverageProvider: "v8",

    coveragePathIgnorePatterns: [
        "<rootDir>/node_modules/",
        "<rootDir>/tests/",
    ],

    setupFilesAfterEnv: [
        "<rootDir>/test-matchers.ts",
    ],

    testEnvironment: "./test-environment.mjs",

    testSequencer: "./test-sequencer.cjs",

    // An array of regexp pattern strings that are matched against all test paths, matched tests are skipped
    testPathIgnorePatterns: [
        "<rootDir>/node_modules/",
        "<rootDir>/build/",
        "<rootDir>/dist/",
        "<rootDir>/tests/lib/test.ts"
    ],

    // A map from regular expressions to paths to transformers
    transform: {
        "\\.[jt]sx?$": [
            "@swc-node/jest",
            {
                sourcemap: "inline",
                dynamicImport: true,
            }
        ],
    },

    extensionsToTreatAsEsm: [".ts", ".tsx"],
};

export default config;
