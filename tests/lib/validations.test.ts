import { describe, expect, test } from "@jest/globals";
import {
    isAnyWildcard,
    validatePackageIdentifier,
    validateWildcardOrIdentifier
} from "../../server/lib/validations.ts";

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

    test("rejects the lone dash (reserved as wildcard marker)", () => {
        expect(validatePackageIdentifier("-")).toBe(false);
    });
});

describe("isAnyWildcard", () => {
    test("only the lone dash is the wildcard", () => {
        expect(isAnyWildcard("-")).toBe(true);
        expect(isAnyWildcard("--")).toBe(false);
        expect(isAnyWildcard("a")).toBe(false);
        expect(isAnyWildcard("-foo")).toBe(false);
        expect(isAnyWildcard("")).toBe(false);
    });
});

describe("validateWildcardOrIdentifier", () => {
    test("accepts the lone dash wildcard", () => {
        expect(validateWildcardOrIdentifier("-")).toBe(true);
    });

    test("accepts plain identifiers", () => {
        expect(validateWildcardOrIdentifier("bookworm")).toBe(true);
        expect(validateWildcardOrIdentifier("21-1+tpm1u8+deb12")).toBe(true);
        expect(validateWildcardOrIdentifier("Qt5")).toBe(true);
    });

    test("accepts dash-containing identifiers (not treated as wildcard)", () => {
        // Existing PACKAGE_IDENTIFIER_REGEX admits leading/trailing/internal
        // dashes. The new validator must not regress them. Only the lone
        // `-` is the wildcard; `-foo` / `bookworm-` / `-bookworm` remain
        // plain identifiers.
        expect(validateWildcardOrIdentifier("-foo")).toBe(true);
        expect(validateWildcardOrIdentifier("bookworm-")).toBe(true);
        expect(validateWildcardOrIdentifier("-bookworm")).toBe(true);
        expect(validateWildcardOrIdentifier("bookworm-security")).toBe(true);
    });

    test("double-dash is not the wildcard and not a plain identifier rule-breaker", () => {
        // `--` is allowed by PACKAGE_IDENTIFIER_REGEX (all chars are in
        // the class); it's not special and not the lone-dash wildcard.
        expect(validateWildcardOrIdentifier("--")).toBe(true);
    });

    test("rejects empty string", () => {
        expect(validateWildcardOrIdentifier("")).toBe(false);
    });

    test("rejects slashes, spaces, and shell metacharacters", () => {
        expect(validateWildcardOrIdentifier("a/b")).toBe(false);
        expect(validateWildcardOrIdentifier("a b")).toBe(false);
        expect(validateWildcardOrIdentifier("a;b")).toBe(false);
    });
});
