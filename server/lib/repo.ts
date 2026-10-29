export type RepoType = "deb" | "rpm";
export type Repository = {
    type: RepoType,
    path: string,
    distributions: DistributionMap,
};
export type DistributionMap = Record<string, Distribution>;
export type Distribution = {
    path: string,
    releases: ReleaseMap,
};
export type ReleaseMap = Record<string, Release>;
export type Release = {
    path: string,
};
