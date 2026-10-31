import type { Gpg, Paths, UploadOptions } from "./config.ts";
import type { Backend } from "../backend/index.ts";
import { openBackend } from "../backend/index.ts";
import type { Listing, Page } from "../backend/paging.ts";
import { isFormat } from "../backend/pool.ts";
import type { Format } from "../backend/pool.ts";
import { RepoInternalError, RepoNotFoundError, RepoServiceUnavailableError, RepoValidationError } from "./errors.ts";
import { repoDirectoryName } from "./file-naming.ts";
import { invalidDistroMessage, invalidFilenameMessage, validateDistro, validateFilename } from "./validations.ts";
import type { RemovalFile, RepoFile } from "./repo-types.ts";

export type { RemovalFile, RepoFile } from "./repo-types.ts";
export type { Format } from "../backend/pool.ts";
export type { Listing, Page } from "../backend/paging.ts";

export interface RepositoryRef {
    format: Format;
    distribution: string;
    release: string;
}

export interface RepositoryFilter {
    format?: Format;
    distribution?: string;
    release?: string;
}

export interface SourcePackageFilter extends RepositoryFilter {
    source?: string;
}

export interface SourcePackage extends RepositoryRef {
    source: string;
    version: string;
}

export interface UploadTarget extends RepositoryRef {
    component?: string;
    subcomponent?: string;
}

export interface UploadSlot {
    filename: string;
    relativePath: string;
    maxBytes?: number;
}

export interface RemovalFilter {
    format?: Format;
    distribution?: string;
    release?: string;
    source: string;
    version?: string;
}

export interface RemovalResult {
    files: RemovalFile[];
    touchedTargets: number;
}

export interface ListFilesFilter {
    format?: Format;
    distribution?: string;
    release?: string;
    source: string;
    version?: string;
}

export interface ListFilesResult {
    files: RepoFile[];
    touchedTargets: number;
    nextCursor?: string;
}

export type ImportFileStatus = "ok" | "skipped" | "failed";

export interface ImportFile {
    filename: string;
    /**
     * Import-style path mirroring the upload URL (forward slashes, no leading slash):
     *   deb: deb/<distro>/<release>/<component>[/<subcomponent>]/<filename>
     *   rpm: rpm/<distro>/<release>/<filename>
     */
    path: string;
    status: ImportFileStatus;
    /** Populated when status !== "ok". Human-readable; not intended for programmatic matching. */
    reason?: string;
}

export interface ImportResult {
    /** true iff no entry has status === "failed" */
    ok: boolean;
    files: ImportFile[];
}

export interface ServerStatus {
    message: string;
    api: {
        deb: { enabled: boolean };
        rpm: { enabled: boolean };
    };
}

/** The filter in the spelling the database holds */
function inRepoSpelling<F extends RepositoryFilter>(filter: F): F {
    return {
        ...filter,
        distribution: filter.distribution && repoDirectoryName(filter.distribution),
        release: filter.release && repoDirectoryName(filter.release),
    };
}

export class RepoService {
    private readonly paths: Paths;
    private readonly gpg: Gpg;
    private readonly upload: UploadOptions;

    constructor(paths: Paths, gpg: Gpg, upload: UploadOptions) {
        this.paths = paths;
        this.gpg = gpg;
        this.upload = upload;
    }

    public async listRepositories(filter: RepositoryFilter = {}): Promise<RepositoryRef[]> {
        const format = this.enabledFormat(filter.format);
        return (await this.backend()).listRepositories({ ...inRepoSpelling(filter), format });
    }

    public async listSourcePackages(filter: SourcePackageFilter, page: Page = {}): Promise<Listing<SourcePackage>> {
        const format = this.enabledFormat(filter.format);
        return (await this.backend()).listSourcePackages({ ...inRepoSpelling(filter), format }, page);
    }

    public prepareUpload(target: UploadTarget, filenames: string[]): UploadSlot[] {
        if (!isFormat(target.format)) {
            throw new RepoValidationError(`Unknown format '${ target.format }'`);
        }
        const enabled = target.format === "deb" ? this.upload.enabledApi.deb : this.upload.enabledApi.rpm;
        if (!enabled) {
            throw new RepoServiceUnavailableError(
                `The ${ target.format } repository API is not enabled`,
                { format: target.format }
            );
        }

        if (target.format === "rpm" && (target.component || target.subcomponent)) {
            throw new RepoValidationError("component/subcomponent are only valid for format=deb");
        }

        const requested: string[] = [target.distribution, target.release];
        if (target.format === "deb") {
            if (!target.component) {
                throw new RepoValidationError("component is required for format=deb");
            }
            requested.push(target.component);
            if (target.subcomponent) requested.push(target.subcomponent);
        }
        const distroParts = requested.map(name => repoDirectoryName(name));
        if (!validateDistro(target.format, distroParts)) {
            throw new RepoValidationError(invalidDistroMessage(target.format, requested));
        }

        if (filenames.length === 0) {
            throw new RepoValidationError("filenames must not be empty");
        }

        const slots: UploadSlot[] = [];
        for (const filename of filenames) {
            if (!validateFilename(target.format, filename)) {
                throw new RepoValidationError(invalidFilenameMessage(filename));
            }
            const segments = ["/api/v1/upload", target.format, ...distroParts, filename];
            const relativePath = segments.join("/");
            const slot: UploadSlot = { filename, relativePath };
            if (typeof this.upload.sizeLimit === "number") {
                slot.maxBytes = this.upload.sizeLimit;
            }
            slots.push(slot);
        }
        return slots;
    }

    public async importRepository(): Promise<ImportResult> {
        if (!this.upload.enabledApi.deb && !this.upload.enabledApi.rpm) {
            throw new RepoServiceUnavailableError("No repository API is enabled");
        }
        return (await this.backend()).importStaged();
    }

    public async listPackageFiles(filter: ListFilesFilter, page: Page = {}): Promise<ListFilesResult> {
        if (!filter.source) {
            throw new RepoValidationError("source is required");
        }
        const format = this.enabledFormat(filter.format);
        const backend = await this.backend();
        this.assertRepository(backend, format, filter);
        const listing = backend.listPackageFiles({ ...inRepoSpelling(filter), format }, page);
        const targets = new Set(listing.items.map(f => `${ f.format }/${ f.distribution }/${ f.release }`));
        const result: ListFilesResult = { files: listing.items.map(f => ({ filename: f.filename, path: f.path })), touchedTargets: targets.size };
        if (listing.nextCursor !== undefined) {
            result.nextCursor = listing.nextCursor;
        }
        return result;
    }

    public async removePackage(filter: RemovalFilter & { immediate?: boolean }): Promise<RemovalResult> {
        if (!filter.source) {
            throw new RepoValidationError("source is required");
        }
        const format = this.enabledFormat(filter.format);
        const backend = await this.backend();
        this.assertRepository(backend, format, filter);
        const result = await backend.remove({ ...inRepoSpelling(filter), format });
        const failed = result.files.filter(f => f.status === "failed").length;
        if (failed > 0) {
            throw new RepoInternalError(
                `Removed ${ result.files.length } entr${ result.files.length === 1 ? "y" : "ies" }; ${ failed } file(s) could not be deleted`,
                { files: result.files }
            );
        }
        return result;
    }

    public getStatus(): ServerStatus {
        return {
            message: "Package repository API is running",
            api: {
                deb: { enabled: this.upload.enabledApi.deb },
                rpm: { enabled: this.upload.enabledApi.rpm },
            },
        };
    }

    private backend(): Promise<Backend> {
        return openBackend(this.paths, this.gpg.gpgRepoPrivateKeyFile);
    }

    /** The format to ask the backend for: the wanted one, or both when none is named and both are enabled */
    private enabledFormat(format: Format | undefined): Format | undefined {
        if (format !== undefined && !isFormat(format)) {
            throw new RepoValidationError(`Unknown format '${ format }'`);
        }
        const wantDeb = (!format || format === "deb") && this.upload.enabledApi.deb;
        const wantRpm = (!format || format === "rpm") && this.upload.enabledApi.rpm;
        if (!wantDeb && !wantRpm) {
            if (format) {
                throw new RepoServiceUnavailableError(`The ${ format } repository API is not enabled`, { format });
            }
            throw new RepoServiceUnavailableError("No repository API is enabled");
        }
        return wantDeb && wantRpm ? undefined : wantDeb ? "deb" : "rpm";
    }

    /** A distribution or release named explicitly must exist, the backend answers empty for one that does not; the error shows it as sent */
    private assertRepository(backend: Backend, format: Format | undefined, filter: RepositoryFilter): void {
        if (filter.distribution === undefined && filter.release === undefined) {
            return;
        }
        const { distribution, release } = inRepoSpelling(filter);
        if (backend.listRepositories({ format, distribution, release }).length === 0) {
            throw new RepoNotFoundError(`No such repository ${ filter.format ?? "-" }/${ filter.distribution ?? "-" }/${ filter.release ?? "-" }`);
        }
    }
}
