// noinspection DuplicatedCode

import { uploadFileByPost, uploadFileByPut, uploadFileByPutRawIncomplete, withLocalTmpDir } from "../utils.ts";
import osPath from "path";
import fs from "fs";
import { jest } from "@jest/globals";
import createTestApp from "../testapp.ts";

describe('Test RedHat file upload', () => {
    test('Check that POST with single RedHat file succeeds', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const contentFile = Buffer.from('Hello World');
        const res = await uploadFileByPost(app, '/upload/rpm/fedora/41', [{ name: 'test.rpm', content: contentFile }]);

        expect(res.status).toBe(201);

        const expectedFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', '41', 'test.rpm');
        expect(expectedFilePath).toPathExist();
        expect(fs.readFileSync(expectedFilePath)).toEqual(contentFile);
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST with multiple RedHat files succeeds', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const files = [
            { name: 'test1.rpm', content: Buffer.from('Hello World 1') },
            { name: 'test2.rpm', content: Buffer.from('Hello World 2') },
            { name: 'test3.rpm', content: Buffer.from('Hello World 3') },
            { name: 'test4.rpm', content: Buffer.from('Hello World 4') },
        ];

        const response = await uploadFileByPost(app, '/upload/rpm/fedora/41', files);
        expect(response.status).toBe(201);

        files.forEach(file => {
            const expectedFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', '41', file.name);
            expect(expectedFilePath).toPathExist();
            expect(fs.readFileSync(expectedFilePath)).toEqual(file.content);
        });
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST with unavailable createrepo_c tool fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                createrepoScript: null,
            },
            upload: {
                enabledApi: {
                    rpm: false
                }
            }
        });

        const contentFile = Buffer.from('Hello World');
        const res = await uploadFileByPost(app, '/upload/rpm/fedora/41', [{ name: 'test.rpm', content: contentFile }]);

        expect(res.status).toBe(503);

        const expectedFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', '41', 'test.rpm');
        expect(expectedFilePath).not.toPathExist();
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST with invalid RedHat-related file extension fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const invalidExtensions = ['exe', 'txt', 'jpg', 'png', 'zip', 'mp4'];

        for (const ext of invalidExtensions) {
            const testContent = Buffer.from(`Invalid file content for ${ ext }`);
            const filename = `invalidfile.${ ext }`;

            const res = await uploadFileByPost(app, '/upload/rpm/fedora/41',
                [{ name: filename, content: testContent }]);
            expect(res.status).toBe(400);

            const expectedFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', '41', filename);
            expect(expectedFilePath).not.toPathExist();
        }
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST upload with invalid release fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const invalidReleases = ['invalid', '12invalid'];

        for (const release of invalidReleases) {
            const testContent = Buffer.from(`Invalid PUT content for release ${ release }`);

            const res = await uploadFileByPost(app, `/upload/rpm/fedora/${ release }`,
                [{ name: 'test.rpm', content: testContent }]);
            expect(res.status).toBe(400);

            const expectedFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', release, 'test.rpm');
            expect(expectedFilePath).not.toPathExist();
        }
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST with invalid file name fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const invalidFileNames = [
            'test<>.rpm',
            'test|name.rpm',
            'test:name?.rpm',
            '*.rpm',
            'com/debs//.rpm',
            '..hidden.rpm'
        ];

        for (const invalidFileName of invalidFileNames) {
            const testContent = Buffer.from(`Content of ${ invalidFileName }`);

            const res = await uploadFileByPost(app, '/upload/rpm/fedora/41',
                [{ name: invalidFileName, content: testContent }]);
            expect(res.status).toBe(400);

            const expectedFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', '41', invalidFileName);
            expect(expectedFilePath).not.toPathExist();
        }
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST with too big file fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            },
            upload: {
                sizeLimit: 100 * 1024
            }
        });

        const testContent = Buffer.alloc(200 * 1024, 'A'); // Create a 200kB buffer exceeding the limit
        const filename = 'largefile.rpm';

        const res = await uploadFileByPost(app, '/upload/rpm/fedora/41', [{ name: filename, content: testContent }]);
        expect(res.status).toBe(413);

        const expectedFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', '41', filename);
        expect(expectedFilePath).not.toPathExist();
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that PUT upload succeeds', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const testContent = Buffer.from('Test content for PUT method');
        const testFilePath = '/upload/rpm/fedora/41/test.put.rpm';

        const res = await uploadFileByPut(app, testFilePath, testContent);
        expect(res.status).toBe(201); // Assuming 201 Created for successful PUT

        const expectedFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', '41', 'test.put.rpm');
        expect(expectedFilePath).toPathExist();
        expect(fs.readFileSync(expectedFilePath)).toEqual(testContent);
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that PUT upload with unavailable createrepo_c tool fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                createrepoScript: null,
            },
            upload: {
                enabledApi: {
                    rpm: false
                }
            }
        });

        const testContent = Buffer.from('Test content for PUT method');
        const testFilePath = '/upload/rpm/fedora/41/test.put.rpm';

        const res = await uploadFileByPut(app, testFilePath, testContent);
        expect(res.status).toBe(503);

        const expectedFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', '41', 'test.put.rpm');
        expect(expectedFilePath).not.toPathExist();
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that PUT upload with invalid extension fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const invalidExtensions = ['exe', 'txt', 'jpg', 'png', 'zip', 'mp4'];

        for (const ext of invalidExtensions) {
            const testContent = Buffer.from(`Invalid PUT content for ${ ext }`);
            const invalidFilePath = `/upload/rpm/fedora/41/invalidfile.${ ext }`;

            const res = await uploadFileByPut(app, invalidFilePath, testContent);
            expect(res.status).toBe(400);

            const expectedFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', '41', `invalidfile.${ ext }`);
            expect(expectedFilePath).not.toPathExist();
        }
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that PUT upload with invalid release fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const invalidReleases = ['invalid', '12invalid'];

        for (const release of invalidReleases) {
            const testContent = Buffer.from(`Invalid PUT content for release ${ release }`);
            const invalidFilePath = `/upload/rpm/fedora/${ release }/test.put.rpm`;

            const res = await uploadFileByPut(app, invalidFilePath, testContent);
            expect(res.status).toBe(400);

            const expectedFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', release, 'test.put.rpm');
            expect(expectedFilePath).not.toPathExist();
        }
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that PUT upload with too big file fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            },
            upload: {
                sizeLimit: 100 * 1024
            }
        });

        const testContent = Buffer.alloc(200 * 1024, 'A'); // Create a 200kB buffer exceeding the limit
        const testFilePath = '/upload/rpm/fedora/41/test.put.rpm';

        const res = await uploadFileByPut(app, testFilePath, testContent);
        expect(res.status).toBe(413);

        const expectedFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', '41', 'largefile.rpm');
        expect(expectedFilePath).not.toPathExist();
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that PUT upload with file write error cleans-up correctly', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const originalJoin = osPath.join;
        jest.spyOn(osPath, 'join').mockImplementation((...args: string[]) => {
            if (args.includes("tmp") && args[0] === "incoming") {
                return originalJoin(...args.splice(0, args.length - 1), "non-existing-dir", args[args.length - 1]);
            } else {
                return originalJoin(...args);
            }
        });

        try {
            const testContent = Buffer.from('Test content to simulate file write failure');
            const testFilePath = '/upload/rpm/fedora/41/failingfile.rpm';

            const res = await uploadFileByPut(app, testFilePath, testContent);
            (osPath.join as jest.Mock).mockRestore();

            expect(res.status).toBe(500);

            const expectedTmpFilePath = osPath.join('incoming', 'tmp', 'failingfile.rpm');
            const expectedFinalFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', '41', 'failingfile.rpm');
            expect(expectedTmpFilePath).not.toPathExist();
            expect(expectedFinalFilePath).not.toPathExist();
        } finally {
            jest.restoreAllMocks();
        }

        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that aborted PUT upload of chunked file cleans-up correctly', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const bufferSize = 100 * 1024;
        const buffer = Buffer.alloc(bufferSize, 'A');

        const requestHeaders = [
            `PUT /upload/rpm/fedora/41/rawput.rpm HTTP/1.1`,
            `Host: localhost`,
            `Transfer-Encoding: chunked`,
            `Content-Type: application/octet-stream`,
            `Connection: close`,
            ``,
            `${ bufferSize.toString(16) }`,
            ``
        ].join('\r\n');
        await uploadFileByPutRawIncomplete(app, requestHeaders, buffer);

        const expectedFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', '41', 'rawput.rpm');
        expect(expectedFilePath).not.toPathExist();
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that aborted PUT upload cleans-up correctly', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const bufferSize = 100 * 1024;
        const buffer = Buffer.alloc(bufferSize, 'A');

        const requestHeaders = [
            `PUT /upload/rpm/fedora/41/rawput.rpm HTTP/1.1`,
            `Host: localhost`,
            `Content-Length: ${ 400 * 1024 }`,
            `Content-Type: application/octet-stream`,
            `Connection: close`,
            ``,
            ``
        ].join('\r\n');

        await uploadFileByPutRawIncomplete(app, requestHeaders, buffer);

        const expectedFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', '41', 'rawput.rpm');
        expect(expectedFilePath).not.toPathExist();
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that aborted PUT upload with too big file cleans-up correctly', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            },
            upload: {
                sizeLimit: 100 * 1024
            }
        });

        const bufferSize = 200 * 1024;
        const buffer = Buffer.alloc(bufferSize, 'A');

        const requestHeaders = [
            `PUT /upload/rpm/fedora/41/largefile.rpm HTTP/1.1`,
            `Host: localhost`,
            `Content-Length: ${ 400 * 1024 }`, // 2MB file size
            `Content-Type: application/octet-stream`,
            `Connection: keep-alive`,
            ``,
            ``
        ].join('\r\n');

        await uploadFileByPutRawIncomplete(app, requestHeaders, buffer);

        const expectedFilePath = osPath.join('incoming', 'staging', 'rpm', 'fedora', '41', 'largefile.rpm');
        expect(expectedFilePath).not.toPathExist();
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

});
