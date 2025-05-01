export type CachedValue<T> = () => T;

export function cached<T>(make: () => T): CachedValue<T> {
    let value: T | undefined;
    return () => (value ??= make());
}
