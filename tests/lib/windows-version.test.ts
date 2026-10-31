import { describe, expect, test } from "@jest/globals";
import { checkWindowsVersion } from "../../server/lib/windows-version.ts";

describe("Tests for checkWindowsVersion", () => {
    test.each(["10.0.22000", "10.0.22631", "10.0.26100", "10.0.26300", "11.0.30000"])("Windows starts on release %s", release => {
        expect(() => checkWindowsVersion(release, "win32")).not.toThrow();
    });

    test.each([["10.0.21999", "21999"], ["10.0.19045", "19045"], ["10.0.17763", "17763"], ["6.3.9600", "9600"], ["10.0.0", "0"]])("Windows refuses release %s and names build %s", (release, build) => {
        expect(() => checkWindowsVersion(release, "win32")).toThrow(new Error(`Windows 11 is required, build 22000 or newer; this system is build ${ build }`));
    });

    test.each(["", "unknown", "10", "10.0", "10.0.", "10.0.x", "x.y.26300", "10.0.26300.1", "10.0.26300-rc", " 10.0.26300", "10.0.0x7000"])("Windows refuses the unparsable release %j", release => {
        expect(() => checkWindowsVersion(release, "win32")).toThrow(new Error(`Windows 11 is required, build 22000 or newer; the build of release ${ JSON.stringify(release) } cannot be determined`));
    });

    test.each([["linux", "6.8.0-45-generic"], ["linux", "10.0.19045"], ["linux", "unknown"], ["darwin", "24.1.0"]] as const)("%s starts on release %s", (platform, release) => {
        expect(() => checkWindowsVersion(release, platform)).not.toThrow();
    });
});
