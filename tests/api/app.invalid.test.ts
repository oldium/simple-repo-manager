import { uploadFileByPost, uploadFileByPut, withLocalTmpDir } from "../utils.ts";
import request from "supertest";
import osPath from "path";
import fs from "fs";
import createTestApp from "../testapp.ts";

describe('Test invalid paths', () => {
    test('Check that POST request to invalid file type fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const invalidPaths = ['/api/v1/upload/invalid/test', '/api/v1/upload/deb/debian', '/api/v1/upload/deb/debian/bookworm',
            '/api/v1/upload/deb/debian/bookworm/component/subcomponent/invalid', '/api/v1/upload/rpm/fedora',
            '/api/v1/upload/rpm/fedora/41/invalid'
        ];

        for (const testPath of invalidPaths) {
            const contentFile = Buffer.from('Hello World');

            const res1 = await uploadFileByPost(app, testPath, [{ name: 'test.deb', content: contentFile }]);
            const res2 = await uploadFileByPost(app, `${ testPath }/`, [{ name: 'test.deb', content: contentFile }]);

            expect(res1.status).toEqual(404);
            expect(res2.status).toEqual(404);

            const expectedFilePath = osPath.join('incoming', 'staging', ...testPath.split('/').slice(4), 'test.deb');
            expect(expectedFilePath).not.toPathExist();
        }
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that PUT request to invalid file type fails', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const invalidPaths = ['/api/v1/upload/invalid/test', '/api/v1/upload/deb/debian', '/api/v1/upload/deb/debian/bookworm',
            '/api/v1/upload/deb/debian/bookworm/component/subcomponent/invalid', '/api/v1/upload/rpm/fedora',
            '/api/v1/upload/rpm/fedora/41/invalid'];

        for (const testPath of invalidPaths) {
            const contentFile = Buffer.from('Hello World');
            const res = await uploadFileByPut(app, `${ testPath }/test.deb`, contentFile);

            expect(res.status).toEqual(404);

            const expectedFilePath = osPath.join('incoming', 'staging', ...testPath.split('/').slice(4), 'test.deb');
            expect(expectedFilePath).not.toPathExist();
        }
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));

    test('Check that invalid API paths return 404', withLocalTmpDir(async () => {
        const app = await createTestApp({
            paths: {
                incomingDir: "incoming",
            }
        });

        const invalidApiPaths = [
            '/api', '/api', '/api/invalid', '/api/status/extra',
            '/api/v1', '/api/v1/invalid', '/api/v1/status/extra'
        ];

        for (const testPath of invalidApiPaths) {
            const res1 = await request(app).get(testPath);
            const res2 = await request(app).get(`${ testPath }/`);

            expect(res1.status).toEqual(404);
            expect(res2.status).toEqual(404);
        }
    }));
});
