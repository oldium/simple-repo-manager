import { expect } from '@jest/globals';
import type { MatcherFunction } from 'expect';
import path from 'node:path';
import fsExtra from "fs-extra";
import { default as jestExtendedMatchers } from 'jest-extended';
import * as openpgp from 'openpgp';
import _ from "lodash";
import fs from "fs/promises";

const toMatchGlob: MatcherFunction<[pattern: string]> = function (actual: unknown, pattern: string) {
    if (typeof actual !== 'string') {
        throw new TypeError('The parameter must be a string!');
    }

    const pass = path.matchesGlob(actual, pattern);
    if (pass) {
        return {
            message: () =>
                `expected ${ this.utils.printReceived(
                    actual
                ) } not to match glob pattern ${ this.utils.printExpected(
                    pattern,
                ) }`,
            pass: true,
        };
    } else {
        return {
            message: () =>
                `expected ${ this.utils.printReceived(
                    actual
                ) } to match glob pattern ${ this.utils.printExpected(
                    pattern,
                ) }`,
            pass: false,
        };
    }
}

const toPathExist: MatcherFunction = function (actual: unknown) {
    if (typeof actual !== 'string') {
        throw new TypeError('The parameter must be a string!');
    }

    const pass = fsExtra.pathExistsSync(actual);
    if (pass) {
        return {
            message: () =>
                `expected ${ this.utils.printReceived(actual) } path not to exist`,
            pass: true,
        };
    } else {
        return {
            message: () =>
                `expected ${ this.utils.printReceived(actual) } path to exist`,
            pass: false,
        };
    }
}

function isKeyFile(key: string | Buffer): boolean {
    return _.isString(key) && !key.includes("-----BEGIN PGP");
}

async function readKey(content: string | Buffer): Promise<openpgp.Key> {
    try {
        return await openpgp.readKey({ armoredKey: _.isString(content) ? content : content.toString('utf8') });
    } catch {
        return await openpgp.readKey({ binaryKey: _.isString(content) ? Buffer.from(content, 'utf8') : content });
    }
}

async function readKeys(keys: string | Buffer): Promise<openpgp.Key[]> {
    let keysContent: string | Buffer;
    if (isKeyFile(keys)) {
        keysContent = await fs.readFile(keys);
    } else {
        keysContent = keys;
    }

    let content: (string | Buffer)[];
    const keyString = _.isString(keysContent) ? keysContent : keysContent.toString('utf8');
    if (keyString.includes("-----BEGIN PGP")) {
        const keysMatch = keyString.split(
            /(-----BEGIN (PGP (?:PUBLIC|PRIVATE) KEY BLOCK)-----[\s\S]+?-----END \2-----)/g);
        content = keysMatch.filter((_, index) => index % 3 === 1);
    } else {
        content = [keysContent];
    }
    return await Promise.all(content.map(c => readKey(c)));
}

function writeKeys(keys: openpgp.Key[]): Buffer {
    const buffers = keys.map(key => key.write());
    return Buffer.concat(buffers);
}

const toBeGpgKeyMatching: MatcherFunction<[contentToMatch: string]> = async function (actual: unknown, contentToMatch: string) {
    if (typeof actual !== 'string' && !Buffer.isBuffer(actual)) {
        throw new TypeError('The file path must be a string!');
    }

    if (typeof contentToMatch !== 'string' && !Buffer.isBuffer(contentToMatch)) {
        throw new TypeError('The content to match must be a string or a Buffer!');
    }

    let actualKeys: openpgp.Key[];
    try {
        actualKeys = await readKeys(actual);
    } catch (err) {
        return {
            message: () => `failed to parse GPG key file ${ this.utils.printReceived(actual) }: ${err}`,
            pass: false,
        };
    }

    let expectedKeys: openpgp.Key[];
    try {
        expectedKeys = await readKeys(contentToMatch);
    } catch (err) {
        return {
            message: () => `failed to parse provided GPG key content: ${err}`,
            pass: false,
        };
    }

    const actualBytes = writeKeys(actualKeys);
    const contentBytes = writeKeys(expectedKeys);

    const formattedActual = isKeyFile(actual) ? ` file ${ this.utils.printReceived(actual) }` : '';
    const formattedContent = isKeyFile(contentToMatch) ? ` file ${ this.utils.printReceived(contentToMatch) }` : '';
    if (_.isEqual(actualBytes, contentBytes)) {
        return {
            message: () => `expected GPG key${ formattedActual } not to match the provided key ${ formattedContent }`,
            pass: true,
        };
    } else {
        return {
            message: () => `expected GPG key${ formattedActual } to match the provided key ${ formattedContent }`,
            pass: false,
        };
    }
}

expect.extend({
    toMatchGlob,
    toPathExist,
    toBeGpgKeyMatching,
    ...jestExtendedMatchers,
});

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace jest {
        // noinspection JSUnusedGlobalSymbols
        interface AsymmetricMatchers {
            toMatchGlob(pattern: string): void;
            toPathExist(): void;
            toBeGpgKeyMatching(contentToMatch: string | Buffer): Promise<void>;
        }

        // noinspection JSUnusedGlobalSymbols
        interface Matchers<R> {
            toMatchGlob(pattern: string): R;
            toPathExist(): R;
            toBeGpgKeyMatching(contentToMatch: string | Buffer): Promise<R>;
        }
    }
}
