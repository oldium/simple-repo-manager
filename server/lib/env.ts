export function sanitize(str: string): string;
export function sanitize(str: undefined): undefined;
export function sanitize(str?: string): string | undefined;
export function sanitize(str?: string) {
    return str?.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
}

export function getEnv(prefix: string, distro?: string, release?: string): string | undefined {
    const distroEnv = sanitize(distro);
    const releaseEnv = sanitize(release);

    if (distroEnv && releaseEnv) {
        return (
            process.env[`${ prefix }_${ distroEnv }_${ releaseEnv }`] ??
            process.env[`${ prefix }_${ releaseEnv }`] ??
            process.env[`${ prefix }_${ distroEnv }`] ??
            process.env[`${ prefix }`]
        )
    } else if (distroEnv) {
        return (
            process.env[`${ prefix }_${ distroEnv }`] ??
            process.env[`${ prefix }`]
        )
    } else {
        return process.env[`${ prefix }`];
    }
}
