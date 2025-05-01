// noinspection DuplicatedCode,SpellCheckingInspection

import { jest } from '@jest/globals';
import path from 'path';
import fs from 'fs';
import { uploadFileByPost, uploadFileByPut, uploadFileByPutRawIncomplete, withLocalTmpDir } from "../utils.ts";
import createTestApp from "../testapp.ts";

describe('Test Debian file upload', () => {
    test('Check that POST with single Debian file succeeds', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const contentFile = Buffer.from('Hello World');
        const res = await uploadFileByPost(app, '/upload/deb/debian/bookworm/main',
            [{ name: 'test.deb', content: contentFile }]);

        expect(res.status).toBe(201);

        const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main', 'test.deb');
        expect(expectedFilePath).toPathExist();
        expect(fs.readFileSync(expectedFilePath)).toEqual(contentFile);
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST with custom field name succeeds', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            },
            upload: {
                postField: "file"
            }
        });

        const contentFile = Buffer.from('Hello World');
        const res = await uploadFileByPost(app, '/upload/deb/debian/bookworm/main',
            [{ name: 'test.deb', content: contentFile }], "file");

        expect(res.status).toBe(201);

        const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main', 'test.deb');
        expect(expectedFilePath).toPathExist();
        expect(fs.readFileSync(expectedFilePath)).toEqual(contentFile);
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST with unavailable reprepro tool fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repreproBin: null,
            },
            upload: {
                enabledApi: {
                    deb: false
                }
            }
        });

        const contentFile = Buffer.from('Hello World');
        const res = await uploadFileByPost(app, '/upload/deb/debian/bookworm/main',
            [{ name: 'test.deb', content: contentFile }]);

        expect(res.status).toBe(503);

        const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main', 'test.deb');
        expect(expectedFilePath).not.toPathExist();
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST with wrong field name fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const contentFile = Buffer.from('Hello World');
        const res = await uploadFileByPost(app, '/upload/deb/debian/bookworm/main',
            [{ name: 'test.deb', content: contentFile }], "file");

        expect(res.status).toBe(400);

        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST to subcomponent succeeds', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const contentFile = Buffer.from('Hello World');
        const res = await uploadFileByPost(app, '/upload/deb/debian/bookworm/update/main',
            [{ name: 'test.deb', content: contentFile }]);

        expect(res.status).toBe(201);

        const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'update', 'main',
            'test.deb');
        expect(expectedFilePath).toPathExist();
        expect(fs.readFileSync(expectedFilePath)).toEqual(contentFile);
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST with multiple Debian files succeeds', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const files = [
            { name: 'test1.deb', content: Buffer.from('Hello World 1') },
            { name: 'test2.deb', content: Buffer.from('Hello World 2') },
            { name: 'test3.deb', content: Buffer.from('Hello World 3') },
            { name: 'test4.deb', content: Buffer.from('Hello World 4') },
        ];

        const response = await uploadFileByPost(app, '/upload/deb/debian/bookworm/main', files);
        expect(response.status).toBe(201);

        files.forEach(file => {
            const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main', file.name);
            expect(expectedFilePath).toPathExist();
            expect(fs.readFileSync(expectedFilePath)).toEqual(file.content);
        });
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST with valid Debian-related file extensions succeeds', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const validExtensions = ['deb', 'tar.gz', 'tar.xz', 'tar.bz2', 'buildinfo', 'changes', 'dsc', 'ddeb', 'udeb'];

        for (const ext of validExtensions) {
            const testContent = Buffer.from(`Test file content for ${ ext }`);
            const filename = `testfile.${ ext }`;

            const res = await uploadFileByPost(app, '/upload/deb/debian/bookworm/main',
                [{ name: filename, content: testContent }]);
            expect(res.status).toBe(201);

            const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main', filename);
            expect(expectedFilePath).toPathExist();
            expect(fs.readFileSync(expectedFilePath)).toEqual(testContent);
        }
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST with invalid Debian-related file extension fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const invalidExtensions = ['exe', 'txt', 'jpg', 'png', 'zip', 'mp4'];

        for (const ext of invalidExtensions) {
            const testContent = Buffer.from(`Invalid file content for ${ ext }`);
            const filename = `invalidfile.${ ext }`;

            const res = await uploadFileByPost(app, '/upload/deb/debian/bookworm/main',
                [{ name: filename, content: testContent }]);
            expect(res.status).toBe(400);

            const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main', filename);
            expect(expectedFilePath).not.toPathExist();
        }
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST with invalid file name fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const invalidFileNames = [
            'test<>.deb',
            'test|name.deb',
            'test:name?.deb',
            'test%2fmain.deb',
            '*.deb',
            'com/debs//.deb',
            '..hidden.deb'
        ];

        for (const invalidFileName of invalidFileNames) {
            const testContent = Buffer.from(`Content of ${ invalidFileName }`);

            const res = await uploadFileByPost(app, '/upload/deb/debian/bookworm/main',
                [{ name: invalidFileName, content: testContent }]);
            expect(res.status).toBe(400);

            const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main',
                invalidFileName);
            expect(expectedFilePath).not.toPathExist();
        }
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST with invalid component or subcomponent name fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const invalidComponents = [
            '/upload/deb/debian/bookworm/inv@lid',
            '/upload/deb/debian/bookworm/test.main'
        ];

        for (const invalidPath of invalidComponents) {
            const testContent = Buffer.from('Test content');
            const res = await uploadFileByPost(app, invalidPath, [{ name: 'test.deb', content: testContent }]);
            expect(res.status).toBe(400);

            const expectedFilePath = path.join('incoming', 'staging', ...invalidPath.split('/').slice(2), 'test.deb');
            expect(expectedFilePath).not.toPathExist();
        }
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that POST with too big file fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            },
            upload: {
                sizeLimit: 100 * 1024 // 100kB limit
            }
        });

        const testContent = Buffer.alloc(200 * 1024, 'A'); // 200kB buffer
        const filename = 'largefile.deb';

        const res = await uploadFileByPost(app, '/upload/deb/debian/bookworm/main',
            [{ name: filename, content: testContent }]);
        expect(res.status).toBe(413);

        const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main', filename);
        expect(expectedFilePath).not.toPathExist();
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that PUT upload succeeds', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const testContent = Buffer.from('Test content for PUT method');
        const testFilePath = '/upload/deb/debian/bookworm/main/clevis_21-1+tpm1u8+deb12.dsc';

        const res = await uploadFileByPut(app, testFilePath, testContent);
        expect(res.status).toBe(201);

        const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main',
            'clevis_21-1+tpm1u8+deb12.dsc');
        expect(expectedFilePath).toPathExist();
        expect(fs.readFileSync(expectedFilePath)).toEqual(testContent);
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that PUT upload to subcomponent succeeds', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const testContent = Buffer.from('Test content for PUT method');
        const testFilePath = '/upload/deb/debian/bookworm/update/main/test.put.deb';

        const res = await uploadFileByPut(app, testFilePath, testContent);
        expect(res.status).toBe(201);

        const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'update', 'main',
            'test.put.deb');
        expect(expectedFilePath).toPathExist();
        expect(fs.readFileSync(expectedFilePath)).toEqual(testContent);
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that PUT upload with unavailable reprepro tool fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
                repreproBin: null,
            },
            upload: {
                enabledApi: {
                    deb: false
                }
            }
        });

        const testContent = Buffer.from('Test content for PUT method');
        const testFilePath = '/upload/deb/debian/bookworm/main/clevis_21-1+tpm1u8+deb12.dsc';

        const res = await uploadFileByPut(app, testFilePath, testContent);
        expect(res.status).toBe(503);

        const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main',
            'clevis_21-1+tpm1u8+deb12.dsc');
        expect(expectedFilePath).not.toPathExist();
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
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
            const invalidFilePath = `/upload/deb/debian/bookworm/main/invalidfile.${ ext }`;

            const res = await uploadFileByPut(app, invalidFilePath, testContent);
            expect(res.status).toBe(400);

            const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main',
                `invalidfile.${ ext }`);
            expect(expectedFilePath).not.toPathExist();
        }
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that PUT with invalid file name fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const invalidFileNames = [
            'test<>.deb',
            'test|name.deb',
            'test:name?.deb',
            'test%2fmain.deb',
            '*.deb',
            '..hidden.deb'
        ];

        for (const invalidFileName of invalidFileNames) {
            const testContent = Buffer.from(`Content of ${ invalidFileName }`);
            const invalidFilePath = `/upload/deb/debian/bookworm/main/${ invalidFileName }`;

            const res = await uploadFileByPut(app, invalidFilePath, testContent);
            expect(res.status).toBe(400);

            const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main',
                invalidFileName);
            expect(expectedFilePath).not.toPathExist();
        }
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that PUT with invalid component or subcomponent name fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const invalidComponents = [
            '/upload/deb/debian/bookworm/inv@lid/test.deb',
            '/upload/deb/debian/bookworm/main/test%2ftest.deb',
            '/upload/deb/debian/bookworm/test.main/test.deb'
        ];

        for (const invalidPath of invalidComponents) {
            const testContent = Buffer.from('Test content');
            const res = await uploadFileByPut(app, invalidPath, testContent);
            expect(res.status).toBe(400);

            const expectedFilePath = path.join('incoming', 'staging', ...invalidPath.split('/').slice(2));
            expect(expectedFilePath).not.toPathExist();
        }
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that PUT upload with too big file fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            },
            upload: {
                sizeLimit: 100 * 1024 // 100kB size limit
            }
        });

        const testContent = Buffer.alloc(200 * 1024, 'A'); // 200kB buffer
        const testFilePath = '/upload/deb/debian/bookworm/main/test.put.deb';

        const res = await uploadFileByPut(app, testFilePath, testContent);
        expect(res.status).toBe(413);

        const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main', 'largefile.deb');
        expect(expectedFilePath).not.toPathExist();
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that PUT upload with file write error cleans-up correctly', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        // Mocking the tempName function to simulate an invalid filename error
        const originalJoin = path.join;
        jest.spyOn(path, 'join').mockImplementation((...args: string[]) => {
            if (args[0] === "incoming" && args[1] === "tmp") {
                return originalJoin(...args.splice(0, args.length - 1), "non-existing-dir", args[args.length - 1]);
            } else {
                return originalJoin(...args);
            }
        });

        try {
            const testContent = Buffer.from('Test content to simulate file write failure');
            const testFilePath = '/upload/deb/debian/bookworm/main/failingfile.deb';

            const res = await uploadFileByPut(app, testFilePath, testContent);
            expect(res.status).toBe(500);

            jest.restoreAllMocks();

            const expectedTmpFilePath = path.join('incoming', 'tmp', 'failingfile.deb');
            const expectedFinalFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main',
                'failingfile.deb');
            expect(expectedTmpFilePath).not.toPathExist();
            expect(expectedFinalFilePath).not.toPathExist();
        } finally {
            // Restore the original path.join behavior
            jest.restoreAllMocks();
        }

        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that aborted PUT upload of chunked file cleans-up correctly', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const bufferSize = 100 * 1024; // 100kB
        const buffer = Buffer.alloc(bufferSize, 'A');

        const requestHeaders = [
            `PUT /upload/deb/debian/bookworm/main/rawput.deb HTTP/1.1`,
            `Host: localhost`,
            `Transfer-Encoding: chunked`,
            `Content-Type: application/octet-stream`,
            `Connection: close`,
            ``,
            `${ bufferSize.toString(16) }`,
            ``
        ].join('\r\n');
        await uploadFileByPutRawIncomplete(app, requestHeaders, buffer);

        const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main', 'rawput.deb');
        expect(expectedFilePath).not.toPathExist();
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that aborted PUT upload cleans-up correctly', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const bufferSize = 100 * 1024; // 100kB
        const buffer = Buffer.alloc(bufferSize, 'A');

        const requestHeaders = [
            `PUT /upload/deb/debian/bookworm/main/rawput.deb HTTP/1.1`,
            `Host: localhost`,
            `Content-Length: ${ 400 * 1024 }`, // 400kB file size
            `Content-Type: application/octet-stream`,
            `Connection: close`,
            ``,
            ``
        ].join('\r\n');

        await uploadFileByPutRawIncomplete(app, requestHeaders, buffer);

        const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main', 'rawput.deb');
        expect(expectedFilePath).not.toPathExist();
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that aborted PUT upload with too big file cleans-up correctly', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            },
            upload: {
                sizeLimit: 100 * 1024   // 100kB limit
            }
        });

        const bufferSize = 200 * 1024; // 200kB to be sent
        const buffer = Buffer.alloc(bufferSize, 'A');

        const requestHeaders = [
            `PUT /upload/deb/debian/bookworm/main/largefile.deb HTTP/1.1`,
            `Host: localhost`,
            `Content-Length: ${ 400 * 1024 }`, // 400kB file size
            `Content-Type: application/octet-stream`,
            `Connection: keep-alive`,
            ``,
            ``
        ].join('\r\n');

        await uploadFileByPutRawIncomplete(app, requestHeaders, buffer);

        const expectedFilePath = path.join('incoming', 'staging', 'deb', 'debian', 'bookworm', 'main', 'largefile.deb');
        expect(expectedFilePath).not.toPathExist();
        expect(fs.readdirSync(path.join('incoming', 'tmp'))).toHaveLength(0);
    }));

});
