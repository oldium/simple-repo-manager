import request from 'supertest';

import createTestApp from "../testapp.ts";
import { withLocalTmpDir } from "../utils.ts";

describe('Test basic authentication', () => {
    test('Check that request with correct credentials succeeds', withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { basicAuth: ['upload:password'] } });

        const response = await request(app)
            .get('/api/v1/status')
            .auth('upload', 'password', { type: 'basic' });

        expect(response.status).toBe(200);
    }));

    test('Check that request with second set of credentials succeeds', withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { basicAuth: ['upload:password', 'admin:secret'] } });

        const response = await request(app)
            .get('/api/v1/status')
            .auth('admin', 'secret', { type: 'basic' });

        expect(response.status).toBe(200);
    }));

    test('Check that request with wrong credentials fails', withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { basicAuth: ['upload:password'] } });

        const response = await request(app)
            .get('/api/v1/status')
            .auth('upload', 'wrong-password', { type: 'basic' });

        expect(response.status).toBe(401);
    }));

    test('Check that status endpoint does not need credentials', withLocalTmpDir(async () => {
        const app = await createTestApp({ upload: { basicAuth: ['upload:password'] } });

        const response = await request(app)
            .get('/status');

        expect(response.status).toBe(200);
    }));
});
