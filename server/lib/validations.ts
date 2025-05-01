export function validateType(type: string): boolean {
    return !!type && ['deb', 'rpm'].includes(type);
}

export function validateDistro(type: string, distroComponents: string[]): boolean {
    const [distro, release, ...components] = distroComponents;
    switch (type) {
        case 'deb':
            return !!distro?.match(/^[a-z]+$/)
                && !!release?.match(/^[a-z][a-z-]*$/)
                && components.every((item) => !!item.match(/^[a-z0-9][a-z0-9-]*$/))
                && components.length >= 1
                && components.length <= 2;
        case 'rpm':
            return !!distro?.match(/^[a-z]+$/) && !!release?.match(/^[0-9]+$/) && components.length == 0;
        default:
            return false;
    }
}

export function validateFilename(type: string, filename: string): boolean {
    switch (type) {
        case 'deb':
            return !!filename.match(/^[a-z0-9][a-z0-9.+~_-]*(\.(deb|tar\.[^.]+|buildinfo|changes|dsc|ddeb|udeb))$/);
        case 'rpm':
            return !!filename.match(/^[a-zA-Z0-9][a-zA-Z0-9.+_-]*(\.rpm)$/);
        default:
            return false;
    }
}
