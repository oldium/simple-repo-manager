import type { AppConfig, Environment } from "../server/lib/config.ts";
import createApp from "../server/api/app.ts";

export type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends (...args: unknown[]) => unknown ? T[P] : T[P] extends (infer U)[] ? DeepPartial<U>[] : T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export default async function createTestApp(partialConfig?: DeepPartial<AppConfig>, environment?: Environment) {
    const appConfig: AppConfig = {
        paths: {
            incomingDir: "incoming",
            repoStateDir: "repo-state",
            repoDir: "repo",
            ...partialConfig?.paths
        },
        gpg: {
            gpgRepoPrivateKeyFile: undefined,
            ...partialConfig?.gpg
        },
        upload: {
            allowedIps: undefined,
            basicAuth: undefined,
            bearerAuth: undefined,
            publicRead: false,
            sizeLimit: undefined,
            postField: "package",
            ...partialConfig?.upload,
            enabledApi: {
                deb: true,
                rpm: true,
                ...partialConfig?.upload?.enabledApi
            }
        },
        security: {
            trustProxy: undefined,
            ...partialConfig?.security
        },
        // The platform's own answer, whatever the volume under the tests does
        fileNaming: {
            caseSensitive: process.platform !== "win32",
            shortNames: process.platform === "win32",
            ...partialConfig?.fileNaming
        },
        instanceLabel: partialConfig?.instanceLabel,
    };
    return await createApp(appConfig, environment ?? "test");
}
