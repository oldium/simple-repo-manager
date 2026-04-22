export interface RepoFile {
    filename: string;
    path: string;
}

export interface RemovalFile extends RepoFile {
    status: "ok" | "failed";
}
