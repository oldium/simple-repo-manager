import { withLocalTmpDir } from "./utils.ts";
import fs from "fs";
import osPath from "path";

describe('Test preconditions', () => {
    test("Exception class matches", withLocalTmpDir(async () => {
        try {
            fs.readFileSync(osPath.join("non-existing-dir", "test.deb"));
        } catch (err) {
            expect(err).toBeInstanceOf(Error);
        }
    }));
});
