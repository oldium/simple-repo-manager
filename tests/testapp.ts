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
            signScript: undefined,
            createrepoScript: "scripts/createrepo.sh",
            repreproBin: "reprepro",
            ...partialConfig?.paths
        },
        gpg: {
            gpgRepoPrivateKeyFile: undefined,
            gpgPublicKeysFile: undefined,
            gpgPublicKeysDir: undefined,
            gpgBin: "gpg",
            ...partialConfig?.gpg
        },
        upload: {
            allowedIps: undefined,
            basicAuth: undefined,
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
    };
    return await createApp(appConfig, environment ?? "test");
}
