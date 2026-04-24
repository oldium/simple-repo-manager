import type { Gpg, Paths, UploadOptions } from "./config.ts";
import {
    default as processIncomingDeb,
    enumerateRemovalTargets as enumerateDebTargets,
    listPackageFiles as listDebFiles,
    listSourcePackages as listDebSources,
    removePackage as removeDebPackage,
    type DebVersionFilter,
} from "./deb.ts";
import {
    default as processIncomingRpm,
    enumerateRemovalTargets as enumerateRpmTargets,
    listPackageFiles as listRpmFiles,
    listSourcePackages as listRpmSources,
    removePackage as removeRpmPackage,
    type RpmVersionFilter,
} from "./rpm.ts";
import { moveAll } from "./fs.ts";
import lock from "./lock.ts";
import { RepoInternalError, RepoNotFoundError, RepoServiceUnavailableError, RepoValidationError } from "./errors.ts";
import { validateDistro, validateFilename } from "./validations.ts";
import osPath from "path";
import type { RemovalFile, RepoFile } from "./repo-types.ts";
import type { ActionResult } from "./exec.ts";

export type { RemovalFile, RepoFile } from "./repo-types.ts";

export type Format = "deb" | "rpm";

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

function isFormat(value: unknown): value is Format {
    return value === "deb" || value === "rpm";
}

export class RepoService {
    constructor(
        private readonly paths: Paths,
        private readonly gpg: Gpg,
        private readonly upload: UploadOptions
    ) { }

    public async listRepositories(filter?: RepositoryFilter): Promise<RepositoryRef[]> {
        if (filter?.format !== undefined && !isFormat(filter.format)) {
            throw new RepoValidationError(`Unknown format '${ filter.format }'`);
        }
        const wantDeb = (!filter?.format || filter.format === "deb") && this.upload.enabledApi.deb;
        const wantRpm = (!filter?.format || filter.format === "rpm") && this.upload.enabledApi.rpm;
        if (!wantDeb && !wantRpm) {
            if (filter?.format) {
                throw new RepoServiceUnavailableError(
                    `Repository tool for ${ filter.format } is not available`,
                    { format: filter.format }
                );
            }
            throw new RepoServiceUnavailableError("No repository tool available");
        }
        return await lock.forExecOnce(async () => {
            const results: RepositoryRef[] = [];
            if (wantDeb) {
                const targets = await enumerateDebTargets(this.paths, filter?.distribution, filter?.release);
                for (const t of targets) {
                    results.push({ format: "deb", distribution: t.distribution, release: t.release });
                }
            }
            if (wantRpm) {
                const targets = await enumerateRpmTargets(this.paths, filter?.distribution, filter?.release);
                for (const t of targets) {
                    results.push({ format: "rpm", distribution: t.distribution, release: t.release });
                }
            }
            return results;
        });
    }

    public async listSourcePackages(filter: SourcePackageFilter): Promise<SourcePackage[]> {
        if (filter.format !== undefined && !isFormat(filter.format)) {
            throw new RepoValidationError(`Unknown format '${ filter.format }'`);
        }
        const wantDeb = (!filter.format || filter.format === "deb") && this.upload.enabledApi.deb;
        const wantRpm = (!filter.format || filter.format === "rpm") && this.upload.enabledApi.rpm;
        if (!wantDeb && !wantRpm) {
            if (filter.format) {
                throw new RepoServiceUnavailableError(
                    `Repository tool for ${ filter.format } is not available`,
                    { format: filter.format }
                );
            }
            throw new RepoServiceUnavailableError("No repository tool available");
        }
        return await lock.forExecOnce(async () => {
            const results: SourcePackage[] = [];
            if (wantDeb) {
                const targets = await enumerateDebTargets(this.paths, filter.distribution, filter.release);
                for (const t of targets) {
                    const pkgs = await listDebSources(this.paths, t.distribution, t.release, filter.source);
                    for (const pkg of pkgs) {
                        results.push({ format: "deb", distribution: t.distribution, release: t.release, source: pkg.source, version: pkg.version });
                    }
                }
            }
            if (wantRpm) {
                const targets = await enumerateRpmTargets(this.paths, filter.distribution, filter.release);
                for (const t of targets) {
                    const pkgs = await listRpmSources(this.paths, t.distribution, t.release, filter.source);
                    for (const pkg of pkgs) {
                        results.push({ format: "rpm", distribution: t.distribution, release: t.release, source: pkg.source, version: pkg.version });
                    }
                }
            }
            return results;
        });
    }

    public prepareUpload(target: UploadTarget, filenames: string[]): UploadSlot[] {
        if (!isFormat(target.format)) {
            throw new RepoValidationError(`Unknown format '${ target.format }'`);
        }
        const enabled = target.format === "deb" ? this.upload.enabledApi.deb : this.upload.enabledApi.rpm;
        if (!enabled) {
            throw new RepoServiceUnavailableError(
                `Repository tool for ${ target.format } is not available`,
                { format: target.format }
            );
        }

        if (target.format === "rpm" && (target.component || target.subcomponent)) {
            throw new RepoValidationError("component/subcomponent are only valid for format=deb");
        }

        const distroParts: string[] = [target.distribution, target.release];
        if (target.format === "deb") {
            if (!target.component) {
                throw new RepoValidationError("component is required for format=deb");
            }
            distroParts.push(target.component);
            if (target.subcomponent) distroParts.push(target.subcomponent);
        }
        if (!validateDistro(target.format, distroParts)) {
            throw new RepoValidationError("Invalid distribution/release/component path");
        }

        if (filenames.length === 0) {
            throw new RepoValidationError("filenames must not be empty");
        }

        const slots: UploadSlot[] = [];
        for (const filename of filenames) {
            if (!validateFilename(target.format, filename)) {
                throw new RepoValidationError(`Invalid filename '${ filename }'`);
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
            throw new RepoServiceUnavailableError("No repository tool available");
        }
        return await lock.forExecOnce(async () => {
            await moveAll(
                osPath.join(this.paths.incomingDir, "staging"),
                osPath.join(this.paths.incomingDir, "process")
            );

            const files: ImportFile[] = [];

            if (this.upload.enabledApi.deb) {
                files.push(...(await processIncomingDeb(this.paths, this.gpg)));
            }
            if (this.upload.enabledApi.rpm) {
                files.push(...(await processIncomingRpm(this.paths, this.gpg)));
            }

            const ok = !files.some((f) => f.status === "failed");
            return { ok, files };
        });
    }

    public async listPackageFiles(filter: ListFilesFilter): Promise<ListFilesResult> {
        if (filter.format !== undefined && !isFormat(filter.format)) {
            throw new RepoValidationError(`Unknown format '${ filter.format }'`);
        }
        if (!filter.source) {
            throw new RepoValidationError("source is required");
        }
        const wantDeb = (!filter.format || filter.format === "deb") && this.upload.enabledApi.deb;
        const wantRpm = (!filter.format || filter.format === "rpm") && this.upload.enabledApi.rpm;
        if (!wantDeb && !wantRpm) {
            if (filter.format) {
                throw new RepoServiceUnavailableError(
                    `Repository tool for ${ filter.format } is not available`,
                    { format: filter.format }
                );
            }
            throw new RepoServiceUnavailableError("No repository tool available");
        }

        type LockOutcome =
            | { kind: "ok"; files: RepoFile[]; touchedTargets: number }
            | { kind: "notFound"; key: string }
            | { kind: "failed"; target: string };

        const outcome = await lock.forExecOnce<LockOutcome>(async () => {
            const versionFilter: DebVersionFilter | RpmVersionFilter =
                filter.version === undefined ? { any: true } : filter.version;

            type EnumeratedTarget = { format: Format; distribution: string; release: string };
            const targets: EnumeratedTarget[] = [];
            if (wantDeb) {
                const debTargets = await enumerateDebTargets(this.paths, filter.distribution, filter.release);
                for (const t of debTargets) targets.push({ format: "deb", ...t });
            }
            if (wantRpm) {
                const rpmTargets = await enumerateRpmTargets(this.paths, filter.distribution, filter.release);
                for (const t of rpmTargets) targets.push({ format: "rpm", ...t });
            }

            if (targets.length === 0 && (filter.distribution !== undefined || filter.release !== undefined)) {
                return {
                    kind: "notFound",
                    key: `${ filter.format ?? "-" }/${ filter.distribution ?? "-" }/${ filter.release ?? "-" }`,
                };
            }

            const files: RepoFile[] = [];
            let touchedTargets = 0;

            for (const t of targets) {
                const result = t.format === "rpm"
                    ? await listRpmFiles(this.paths, t.distribution, t.release, filter.source, versionFilter)
                    : await listDebFiles(this.paths, t.distribution, t.release, filter.source, versionFilter);
                if (result.notFound === true) continue;
                // deb lists carry `action` only when the listfilter exec itself failed.
                // `in`-narrowing widens the property type to {}, so we reach for the
                // known shape directly.
                const listAction = (result as { action?: ActionResult }).action;
                if (listAction && listAction.result !== "success") {
                    return { kind: "failed", target: `${ t.format }/${ t.distribution }/${ t.release }` };
                }
                if (result.files.length > 0) touchedTargets++;
                for (const f of result.files) files.push({ filename: f.filename, path: f.path });
            }

            return { kind: "ok", files, touchedTargets };
        });

        if (outcome.kind === "notFound") {
            throw new RepoNotFoundError(`No such repository ${ outcome.key }`);
        }
        if (outcome.kind === "failed") {
            throw new RepoInternalError(`Listing failed for ${ outcome.target }`);
        }
        return { files: outcome.files, touchedTargets: outcome.touchedTargets };
    }

    public async removePackage(filter: RemovalFilter): Promise<RemovalResult> {
        if (filter.format !== undefined && !isFormat(filter.format)) {
            throw new RepoValidationError(`Unknown format '${ filter.format }'`);
        }
        if (!filter.source) {
            throw new RepoValidationError("source is required");
        }
        const wantDeb = (!filter.format || filter.format === "deb") && this.upload.enabledApi.deb;
        const wantRpm = (!filter.format || filter.format === "rpm") && this.upload.enabledApi.rpm;
        if (!wantDeb && !wantRpm) {
            if (filter.format) {
                throw new RepoServiceUnavailableError(
                    `Repository tool for ${ filter.format } is not available`,
                    { format: filter.format }
                );
            }
            throw new RepoServiceUnavailableError("No repository tool available");
        }

        type LockOutcome =
            | { kind: "ok"; files: RemovalFile[]; touchedTargets: number }
            | { kind: "notFound"; key: string }
            | { kind: "partial"; files: RemovalFile[] };

        const outcome = await lock.forExecOnce<LockOutcome>(async () => {
            const versionFilter: DebVersionFilter | RpmVersionFilter =
                filter.version === undefined ? { any: true } : filter.version;

            type EnumeratedTarget = { format: Format; distribution: string; release: string };
            const targets: EnumeratedTarget[] = [];
            if (wantDeb) {
                const debTargets = await enumerateDebTargets(this.paths, filter.distribution, filter.release);
                for (const t of debTargets) targets.push({ format: "deb", ...t });
            }
            if (wantRpm) {
                const rpmTargets = await enumerateRpmTargets(this.paths, filter.distribution, filter.release);
                for (const t of rpmTargets) targets.push({ format: "rpm", ...t });
            }

            if (targets.length === 0 && (filter.distribution !== undefined || filter.release !== undefined)) {
                return {
                    kind: "notFound",
                    key: `${ filter.format ?? "-" }/${ filter.distribution ?? "-" }/${ filter.release ?? "-" }`,
                };
            }

            const files: RemovalFile[] = [];
            let touchedTargets = 0;
            const failed: EnumeratedTarget[] = [];

            for (const t of targets) {
                const result = t.format === "rpm"
                    ? await removeRpmPackage(this.paths, t.distribution, t.release, filter.source, versionFilter)
                    : await removeDebPackage(this.paths, t.distribution, t.release, filter.source, versionFilter);
                if (result.notFound === true) continue;
                if (result.files.length > 0) touchedTargets++;
                files.push(...result.files);
                if (result.action && result.action.result !== "success") {
                    failed.push(t);
                }
            }

            if (failed.length > 0) {
                return { kind: "partial", files };
            }
            return { kind: "ok", files, touchedTargets };
        });

        if (outcome.kind === "notFound") {
            throw new RepoNotFoundError(`No such repository ${ outcome.key }`);
        }
        if (outcome.kind === "partial") {
            throw new RepoInternalError(
                `Removed ${ outcome.files.length } entr${ outcome.files.length === 1 ? "y" : "ies" }; one or more targets failed`,
                { files: outcome.files }
            );
        }
        return { files: outcome.files, touchedTargets: outcome.touchedTargets };
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
}
