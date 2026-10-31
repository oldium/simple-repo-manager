const REQUIRED_BUILD = 22000;

/** Below Windows 11 a device name with an extension still opens the device, and the name rules let those through */
export function checkWindowsVersion(release: string, platform: NodeJS.Platform): void {
    if (platform !== "win32") {
        return;
    }
    const build = /^\d+\.\d+\.(\d+)$/.exec(release)?.[1];
    if (build === undefined) {
        throw new Error(`Windows 11 is required, build ${ REQUIRED_BUILD } or newer; the build of release ${ JSON.stringify(release) } cannot be determined`);
    }
    if (Number(build) < REQUIRED_BUILD) {
        throw new Error(`Windows 11 is required, build ${ REQUIRED_BUILD } or newer; this system is build ${ build }`);
    }
}
