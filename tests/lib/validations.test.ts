import { describe, expect, test } from "@jest/globals";
import { validatePackageIdentifier } from "../../server/lib/validations.ts";

describe("validatePackageIdentifier", () => {
    test("accepts lowercase alphanumerics", () => {
        expect(validatePackageIdentifier("clevis")).toBe(true);
        expect(validatePackageIdentifier("22")).toBe(true);
    });

    test("accepts uppercase (for RPM names like Qt5, GConf2)", () => {
        expect(validatePackageIdentifier("Qt5")).toBe(true);
        expect(validatePackageIdentifier("GConf2")).toBe(true);
    });

    test("accepts Debian version specials", () => {
        expect(validatePackageIdentifier("21-1+tpm1u8+deb12")).toBe(true);
        expect(validatePackageIdentifier("1:2.3~rc1-1")).toBe(true);
        expect(validatePackageIdentifier("1.0.0")).toBe(true);
    });

    test("accepts the RPM release-prefix form", () => {
        expect(validatePackageIdentifier("22-1.tpm1")).toBe(true);
    });

    test("rejects empty string", () => {
        expect(validatePackageIdentifier("")).toBe(false);
    });

    test("rejects slashes, spaces, and shell metacharacters", () => {
        expect(validatePackageIdentifier("foo/bar")).toBe(false);
        expect(validatePackageIdentifier("foo bar")).toBe(false);
        expect(validatePackageIdentifier("foo;rm -rf")).toBe(false);
        expect(validatePackageIdentifier("foo$bar")).toBe(false);
        expect(validatePackageIdentifier("foo\"bar")).toBe(false);
        expect(validatePackageIdentifier("foo'bar")).toBe(false);
        expect(validatePackageIdentifier("foo(bar)")).toBe(false);
    });
});
