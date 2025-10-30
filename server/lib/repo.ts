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

export type DebRepository = Repository & { type: "deb", distributions: DebDistributionMap };
export type DebDistributionMap = Record<string, DebDistribution>;
export type DebDistribution = Distribution & {
    path: string,
    releases: DebReleaseMap,
};
export type DebReleaseMap = Record<string, DebRelease>;
export type DebRelease = {
    path: string,
    components: string[],
    ddebComponents: string[],
    architectures: string[],
};
