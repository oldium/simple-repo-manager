import { uploadFileByPost, uploadFileByPut, withLocalTmpDir } from "../utils.ts";
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

        const invalidPaths = ['/upload/invalid/test', '/upload/deb/debian', '/upload/deb/debian/bookworm',
            '/upload/deb/debian/bookworm/component/subcomponent/invalid', '/upload/rpm/fedora',
            '/upload/rpm/fedora/41/invalid'
        ];

        for (const testPath of invalidPaths) {
            const contentFile = Buffer.from('Hello World');
            const res = await uploadFileByPost(app, testPath, [{ name: 'test.deb', content: contentFile }]);

            expect(res.status).toEqual(404);

            const expectedFilePath = osPath.join('incoming', 'staging', ...testPath.split('/').slice(2), 'test.deb');
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

        const invalidPaths = ['/upload/invalid/test', '/upload/deb/debian', '/upload/deb/debian/bookworm',
            '/upload/deb/debian/bookworm/component/subcomponent/invalid', '/upload/rpm/fedora',
            '/upload/rpm/fedora/41/invalid'];

        for (const testPath of invalidPaths) {
            const contentFile = Buffer.from('Hello World');
            const res = await uploadFileByPut(app, `${ testPath }/test.deb`, contentFile);

            expect(res.status).toEqual(404);

            const expectedFilePath = osPath.join('incoming', 'staging', ...testPath.split('/').slice(2), 'test.deb');
            expect(expectedFilePath).not.toPathExist();
        }
        expect(fs.readdirSync(osPath.join('incoming', 'tmp'))).toHaveLength(0);
    }));
});
