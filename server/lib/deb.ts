import { glob } from "glob";
import path from "node:path/posix";
import fs from "node:fs/promises";
import logger, { getCorrelationId } from "./logger.ts";
import type { Gpg, Paths } from "./config.ts";
import type { ImportFile, ImportFileStatus } from "./repo-service.ts";
import fsExtra from "fs-extra";
import { type ActionResult, exec, execOpt } from "./exec.ts";
import dedent from "dedent";
import assert from "node:assert";
import osPath from "path";
import { gpgInitDeb } from "./gpg.ts";
import { getEnv } from "./env.ts";
import type { DebDistribution, DebDistributionMap, DebRelease, DebReleaseMap, DebRepository } from "./repo.ts";
import {
    LISTFILTER_FORMAT,
    parseListFilterOutput,
    parseSourcePackageListFilterOutput,
    SOURCEPKG_LISTFILTER_FORMAT,
} from "./deb-listfilter.ts";
import { PACKAGE_IDENTIFIER_REGEX } from "./validations.ts";
import _ from "lodash";
import { Readable } from "node:stream";
import * as readline from "node:readline";

type VersionFilter = string | { any: true };

function isAnyVersion(v: VersionFilter): v is { any: true } {
    return typeof v !== "string";
}

const REPREPRO_REMOVEFILTER_MAX_CLAUSES = 25;
const REPREPRO_REMOVEFILTER_MAX_FORMULA_LENGTH = 4096;

type DebCleanupTarget = {
    source: string,
    version: string
}

type ParsedChangesMetadata = {
    distributions: string[],
    source?: string,
    version?: string,
    architectures: Set<string>,
    hasDdeb: boolean
}

type ChangesDirectoryMap = Record<string, ParsedChangesMetadata[]>
type OptionalActionResult = ActionResult | undefined

function getEnvOrigin(distro: string, release: string) {
    return getEnv('DEB_ORIGIN', distro, release);
}

function getEnvDescription(distro: string, release: string) {
    return getEnv('DEB_DESCRIPTION', distro, release);
}

function finalizeReadingRelease(filePath: string, distro: string, release: string | undefined, readingRelease: Record<string, string>, debReleases: DebReleaseMap) {
    if (!release || release === readingRelease["codename"]) {
        const debRelease = debReleases[readingRelease["codename"]] = {
            path: `/deb/${ distro }/dists/${ readingRelease["codename"] }`,
            architectures: readingRelease["architectures"]?.split(' ').filter(Boolean) ?? [],
            components: readingRelease["components"]?.split(' ').filter(Boolean) ?? [],
            ddebComponents: readingRelease["ddebcomponents"]?.split(' ').filter(Boolean) ?? [],
            exists: true
        } satisfies DebRelease;

        if (debRelease.components.length === 0) {
            logger.warn(`No components found in ${ filePath }`);
        }
        if (debRelease.architectures.length === 0) {
            logger.warn(`No architectures found in ${ filePath }`);
        }
    }
}

async function readDistributionsFile(filePath: string, distro: string, release?: string): Promise<DebDistribution | undefined> {
    let content;
    try {
        content = await fs.readFile(filePath, 'utf8');
    } catch (err) {
        logger.warn(`Failed to read ${ filePath }`, { err });
        return;
    }

    try {
        const lines = readline.createInterface({
            input: Readable.from(content),
            crlfDelay: Infinity
        });
        const debReleases: DebReleaseMap = {};
        let readingRelease: Record<string, string> = {};
        let lastOption = undefined;
        for await (const line of lines) {
            if (line.length === 0) {
                // Separator, end of release
                if (!_.isEmpty(readingRelease)) {
                    finalizeReadingRelease(filePath, distro, release, readingRelease, debReleases);
                    readingRelease = {};
                    lastOption = undefined;
                }
            } else {
                const match = line.match(/^(Codename|Components|DDebComponents|Architectures):/i);
                if (match) {
                    lastOption = match[1].toLowerCase();
                    readingRelease[lastOption] = line.substring(match[0].length).trimStart();
                } else if (line[0] === "#") {
                    lastOption = undefined;
                } else if (lastOption !== undefined && line[0] === " ") {
                    // Continuation of previous line
                    readingRelease[lastOption] += line;
                }
            }
        }
        finalizeReadingRelease(filePath, distro, release, readingRelease, debReleases);
        return {
            path: `deb/${ distro }`,
            content: content,
            releases: debReleases
        };
    } catch (err) {
        logger.warn(`Failed to parse ${ filePath }`, { err });
    }
}

async function readDistributions(repoStateDir: string, distro?: string, release?: string): Promise<DebDistributionMap> {
    let distroFiles: string[];
    if (distro) {
        const distroFilePath = `deb-${ distro }/conf/distributions`;
        if (await fsExtra.pathExists(path.join(repoStateDir, distroFilePath))) {
            distroFiles = [distroFilePath];
        } else {
            distroFiles = [];
        }
    } else {
        distroFiles = await glob(`deb-*/conf/distributions`, { cwd: repoStateDir, posix: true });
    }

    const distroMap: DebDistributionMap = {};
    for (const distroFile of distroFiles) {
        const distro = distroFile.split(path.sep)[0].substring(4);
        const distroObj = await readDistributionsFile(path.join(repoStateDir, distroFile), distro, release);
        if (distroObj && Object.keys(distroObj.releases).length > 0) {
            distroMap[distro] = distroObj;
        }
    }

    return distroMap;
}

export async function getRepository(repoStateDir: string, distro?: string, release?: string): Promise<DebRepository> {
    return {
        type: "deb",
        path: "/deb",
        distributions: await readDistributions(repoStateDir, distro, release)
    }
}

function generateDistributionContent(distro: string, distroObj: DebDistribution, signScript: string | undefined) {
    let content = "";
    for (const [release, releaseObj] of Object.entries(distroObj.releases)) {
        if (content.length == 0) {
            content += dedent`
                # Generated by Simple Repo Manager
                # The following fields are read and preserved: Components, DDebComponents, Architectures
                # Changes to other fields will be lost!
                # Value of Origin and Description fields can be set via environment variables:
                # * DEB_ORIGIN[_<distro>][_<release>]
                # * DEB_DESCRIPTION[_<distro>][_<release>]
                #\n
            `;
        } else {
            content += "\n";
        }
        const origin = getEnvOrigin(distro, release);
        const description = getEnvDescription(distro, release);
        const signWith = signScript ?
            `SignWith: !${ path.isAbsolute(signScript) ? signScript : `+b/${ signScript }` }` : undefined;

        content += [
            dedent`
            Codename: ${ release }
            Suite: ${ release }
            Components: ${ [...releaseObj.components].join(' ') }
            `,
            !_.isEmpty(releaseObj.ddebComponents) ?
                `DDebComponents: ${ [...releaseObj.ddebComponents].join(' ') }` :
                undefined,
            `Architectures: ${ [...releaseObj.architectures].join(' ') }`,
            origin ? "Origin: " + origin : undefined,
            description ? "Description: " + description : undefined,
            dedent`
            DebOverride: +c/override
            UDebOverride: +c/override
            DscOverride: +c/override
            Tracking: minimal includechanges includebuildinfos
            Limit: 0
            Contents:
            `,
            signWith
        ].filter(Boolean).join("\n");
        if (content) {
            content += "\n";
        }
    }
    return content ? content : undefined;
}

async function updateDistributionsFileContent(distro: string, distroMap: DebDistributionMap, repoStateDir: string, signScript: string | undefined) {
    const distrosContent: Record<string, string> = {};
    const distroObj = distroMap[distro];
    if (distroObj) {
        const content = generateDistributionContent(distro, distroObj, signScript);
        if (content && content.length > 0) {
            if (content !== distroObj.content) {
                const stateDir = path.join(repoStateDir, `deb-${ distro }`);
                const confDir = path.join(stateDir, "conf");
                if (logger.isDebugEnabled()) {
                    logger.debug(`Writing ${ distro } conf/distributions:\n${ content.trim() }`);
                }
                await fsExtra.ensureDir(confDir);
                await fs.writeFile(path.join(confDir, "distributions"), content);

                distrosContent[distro] = content;
            }
        }
    }
    return distrosContent;
}

function generateIncomingContent(distro: string, release: string, incomingDir: string, tmpTmpDir: string) {
    return dedent`
        # Generated by Simple Repo Manager, manual changes will be lost!
        Name: ${ distro }
        IncomingDir: ${ incomingDir }
        TempDir: ${ tmpTmpDir }
        Allow: ${ release }
        Permit: older_version\n
    `;
}

async function parseChangesMetadata(incomingDebRoot: string, changesFile: string): Promise<ParsedChangesMetadata> {
    const content = await fs.readFile(path.join(incomingDebRoot, changesFile), 'utf8');
    const architectures = new Set<string>();

    const architecturesMatch = content.match(/^Architecture:\s*(.+)$/m);
    const architecturesString = architecturesMatch ? architecturesMatch[1].trim() : '';
    architecturesString.split(' ').filter(Boolean).forEach((architecture) => architectures.add(architecture));

    const distributionMatch = content.match(/^Distribution:\s*(.+)$/m);
    const sourceMatch = content.match(/^Source:\s*(.+)$/m);
    const versionMatch = content.match(/^Version:\s*(.+)$/m);

    const filesMatch = content.match(/^Files:[^\n]*\n((?: [^\n]+\n?)+)/m);
    const filesString = filesMatch ? filesMatch[1].trim() : '';

    return {
        distributions: distributionMatch ? distributionMatch[1].trim().split(/\s+/).filter(Boolean) : [],
        source: sourceMatch?.[1].trim() || undefined,
        version: versionMatch?.[1].trim() || undefined,
        architectures,
        hasDdeb: !!filesString.match(/\.ddeb([\r\n]|$)/)
    };
}

function aggregateChangesMetadata(changesMetadata: ParsedChangesMetadata[]) {
    const architectures = new Set<string>();
    let hasDdeb = false;

    for (const metadata of changesMetadata) {
        metadata.architectures.forEach((architecture) => architectures.add(architecture));
        hasDdeb ||= metadata.hasDdeb;
    }

    return { architectures, hasDdeb };
}

function validateChangesDistributionHeaders(directory: string, changesFiles: string[],
    changesMetadata: ParsedChangesMetadata[]): OptionalActionResult {
    const [, release] = directory.split(path.sep);

    for (const [index, metadata] of changesMetadata.entries()) {
        const changesFile = changesFiles[index];
        if (metadata.distributions.length === 0) {
            continue;
        }
        if (!metadata.distributions.includes(release)) {
            return {
                result: "error" as const,
                message: `Debian changes file ${ changesFile } has Distribution: ${ metadata.distributions.join(" ") } but is queued in release ${ release }`
            } satisfies ActionResult;
        }
    }

    return undefined;
}

function validateChangesCleanupMetadata(changesFiles: string[],
    changesMetadata: ParsedChangesMetadata[]): OptionalActionResult {
    for (const [index, metadata] of changesMetadata.entries()) {
        const changesFile = changesFiles[index];
        if (metadata.source && !PACKAGE_IDENTIFIER_REGEX.test(metadata.source)) {
            return {
                result: "error" as const,
                message: `Debian changes file ${ changesFile } has invalid/unsupported Source for cleanup: ${ metadata.source }`
            } satisfies ActionResult;
        }
        if (metadata.version && !PACKAGE_IDENTIFIER_REGEX.test(metadata.version)) {
            return {
                result: "error" as const,
                message: `Debian changes file ${ changesFile } has invalid/unsupported Version for cleanup: ${ metadata.version }`
            } satisfies ActionResult;
        }
    }

    return undefined;
}

function parseChangesCleanupTargets(changesMetadata: ParsedChangesMetadata[]) {
    const cleanupTargets: Record<string, DebCleanupTarget[]> = {};

    for (const metadata of changesMetadata) {
        if (!metadata.source || !metadata.version) {
            continue;
        }

        for (const release of metadata.distributions) {
            const releaseTargets = (cleanupTargets[release] ??= []);
            releaseTargets.push({ source: metadata.source, version: metadata.version });
        }
    }

    return _.mapValues(cleanupTargets, (targets) => _.uniqBy(targets, (target) => `${ target.source }\0${ target.version }`));
}

async function repreproExec(repreproBin: string, confDir: string, ...args: string[]): Promise<ActionResult> {
    const repreproConfDir = path.isAbsolute(confDir) ? confDir : `+b/${ confDir }`;
    return await exec(repreproBin, "--confdir", repreproConfDir, ...args);
}

async function repreproImportExec(repreproBin: string, confDir: string, distro: string): Promise<ActionResult> {
    // noinspection SpellCheckingInspection
    return await repreproExec(repreproBin, confDir, "--ignore=undefinedtarget", "--export=silent-never",
        'processincoming', distro);
}

async function repreproExportExec(repreproBin: string, confDir: string): Promise<ActionResult> {
    // noinspection SpellCheckingInspection
    return await repreproExec(repreproBin, confDir, 'export');
}

async function repreproCleanupExec(repreproBin: string, confDir: string): Promise<ActionResult> {
    // noinspection SpellCheckingInspection
    return await repreproExec(repreproBin, confDir, "clearvanished");
}

function buildRemoveFilterClause(target: DebCleanupTarget) {
    return `($Source (== ${ target.source }), $SourceVersion (= ${ target.version }))`;
}

function buildRemoveFormulaForTarget(source: string, version: VersionFilter): string {
    if (isAnyVersion(version)) {
        return `$Source (== ${ source })`;
    }
    return buildRemoveFilterClause({ source, version });
}

function chunkCleanupTargets(targets: DebCleanupTarget[]) {
    const chunks: DebCleanupTarget[][] = [];
    let currentChunk: DebCleanupTarget[] = [];
    let currentLength = 0;

    for (const target of targets) {
        const clause = buildRemoveFilterClause(target);
        const nextLength = currentChunk.length === 0 ? clause.length : currentLength + 3 + clause.length;

        if (currentChunk.length > 0
            && (currentChunk.length >= REPREPRO_REMOVEFILTER_MAX_CLAUSES
                || nextLength > REPREPRO_REMOVEFILTER_MAX_FORMULA_LENGTH)) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentLength = 0;
        }

        currentChunk.push(target);
        currentLength = currentChunk.length === 1 ? clause.length : currentLength + 3 + clause.length;
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

async function repreproRemoveFilterExec(repreproBin: string, confDir: string, release: string,
    cleanupTargets: DebCleanupTarget[]): Promise<ActionResult> {
    const formula = cleanupTargets.map(buildRemoveFilterClause).join(" | ");
    logger.info(`Running Debian cleanup for ${ release } with ${ cleanupTargets.length } source/version clause(s)`);
    logger.debug(`Debian cleanup formula for ${ release }: ${ formula }`);
    return await repreproExec(repreproBin, confDir, "--export=silent-never", "removefilter", release, formula);
}

async function cleanupQueuedReuploads(repreproBin: string, confDir: string,
    changesMetadata: ParsedChangesMetadata[]): Promise<OptionalActionResult> {
    const cleanupTargetsByRelease = parseChangesCleanupTargets(changesMetadata);

    for (const [release, cleanupTargets] of Object.entries(cleanupTargetsByRelease)) {
        for (const cleanupChunk of chunkCleanupTargets(cleanupTargets)) {
            const cleanupResult = await repreproRemoveFilterExec(repreproBin, confDir, release, cleanupChunk);
            if (cleanupResult.result !== "success") {
                return cleanupResult;
            }
        }
    }

    return undefined;
}

function getDirectoryCleanupMetadata(directory: string, directoryChangesMetadata: ChangesDirectoryMap) {
    return directoryChangesMetadata[directory] ?? [];
}

/**
 * Finds and organizes changes files by distro and directory
 */
async function findAndOrganizeChangesFiles(incomingDebRoot: string): Promise<Record<string, Record<string, string[]>>> {
    const changesFiles = await glob("*/*/**/*.changes", { cwd: incomingDebRoot, posix: true });
    const changesMap: Record<string, Record<string, string[]>> = {};

    for (const changesFile of changesFiles) {
        const directory = path.dirname(changesFile);
        const distro = directory.split(path.sep)[0];

        const distroMap = (changesMap[distro] ?? (changesMap[distro] = {}));
        const distroDirArray = (distroMap[directory] ?? (distroMap[directory] = []));
        distroDirArray.push(changesFile);
    }

    return changesMap;
}

async function parseChangesDirectoryMap(incomingDebRoot: string,
    directoryChangesFiles: Record<string, string[]>): Promise<ChangesDirectoryMap> {
    return _.fromPairs(await Promise.all(Object.entries(directoryChangesFiles).map(
        async ([directory, changesFiles]) => [
            directory,
            await Promise.all(changesFiles.map(async (changesFile) => await parseChangesMetadata(incomingDebRoot, changesFile)))
        ] as [string, ParsedChangesMetadata[]]
    )));
}

/**
 * Merges existing distributions with changes files
 */
async function mergeDistributionsWithChanges(
    changesMap: Record<string, ChangesDirectoryMap>,
    distributions: DebDistributionMap
): Promise<void> {
    // Merge existing distributions with changes files
    for (const [distro, directoryChangesFiles] of Object.entries(changesMap)) {
        const distroObj = distributions[distro] ?? (distributions[distro] = {
            path: path.join("/deb", distro),
            releases: {}
        });
        for (const [directory, changesMetadata] of Object.entries(directoryChangesFiles)) {
            const directoryComponents = directory.split(path.sep);
            const [, release, ...components] = directoryComponents;

            const component = components.join('/');
            const { architectures, hasDdeb } = aggregateChangesMetadata(changesMetadata);

            const releaseObj = distroObj.releases[release] ?? (distroObj.releases[release] = {
                path: path.join(distroObj.path, release),
                architectures: [],
                components: [],
                ddebComponents: [],
                exists: false
            });
            releaseObj.components = Array.from(new Set([component, ...releaseObj.components])).sort();
            releaseObj.architectures = Array.from(new Set([...architectures, ...releaseObj.architectures])).sort();
            if (hasDdeb) {
                releaseObj.ddebComponents =
                    Array.from(new Set([...components, ...(releaseObj.ddebComponents ?? [])])).sort();
            }
        }
    }
}

async function updateIncomingConfigFile(distro: string, release: string, repoStateDir: string, incomingDir: string) {
    const distroStateDir = path.join(repoStateDir, `deb-${ distro }`);
    const tmpTmpDir = path.join(distroStateDir, `tmp-${ release }`);
    const confDir = path.join(distroStateDir, "conf");

    await fsExtra.ensureDir(tmpTmpDir);
    const incomingContent = generateIncomingContent(distro, release, incomingDir, tmpTmpDir);
    if (logger.isDebugEnabled()) {
        logger.debug(`Writing ${ distro } conf/incoming:\n${ incomingContent.trim() }`);
    }
    await fs.writeFile(path.join(confDir, "incoming"), incomingContent);
}

async function updateOptionsFile(distro: string, repoDir: string, repoStateDir: string) {
    const distroStateDir = path.join(repoStateDir, `deb-${ distro }`);
    const outDir = path.join(repoDir, "deb", distro);
    const dbDir = path.join(distroStateDir, "db");
    const confDir = path.join(distroStateDir, "conf");

    await fsExtra.ensureDir(outDir);
    await fsExtra.ensureDir(dbDir);
    const optionsContent = dedent`
            # Generated by Simple Repo Manager, manual changes will be lost!
            verbose
            outdir ${ path.isAbsolute(outDir) ? outDir : `+b/${ outDir }` }
            dbdir ${ path.isAbsolute(dbDir) ? dbDir : `+b/${ dbDir }` }\n
        `;
    if (logger.isDebugEnabled()) {
        logger.debug(`Writing ${ distro } conf/options:\n${ optionsContent.trim() }`);
    }
    await fs.writeFile(path.join(confDir, "options"), optionsContent);
}

async function updateOverrideFile(distro: string, component: string, repoStateDir: string) {
    const distroStateDir = path.join(repoStateDir, `deb-${ distro }`);
    const confDir = path.join(distroStateDir, "conf");

    const overrideContent = dedent`
            * $Component ${ component }\n
        `;
    if (logger.isDebugEnabled()) {
        logger.debug(`Writing ${ distro } conf/override:\n${ overrideContent.trim() }`);
    }
    await fs.writeFile(path.join(confDir, "override"), overrideContent);
}

/**
 * Processes a single distribution
 */
async function processDistribution(
    distro: string,
    directoryChangesFiles: Record<string, string[]>,
    directoryChangesMetadata: ChangesDirectoryMap,
    distributions: DebDistributionMap,
    incomingDebRoot: string,
    paths: Paths
): Promise<Record<string, ActionResult>> {
    const result: Record<string, ActionResult> = {};

    const distroStateDir = path.join(paths.repoStateDir, `deb-${ distro }`);
    const confDir = path.join(distroStateDir, "conf");

    await updateDistributionsFileContent(distro, distributions, paths.repoStateDir, paths.signScript);

    for (const [directory, changesFiles] of Object.entries(directoryChangesFiles)) {
        const validationResult = validateChangesDistributionHeaders(directory, changesFiles, directoryChangesMetadata[directory]);
        if (validationResult) {
            result[`deb/${ directory }`] = validationResult;
            return result;
        }
        const cleanupMetadataValidationResult = validateChangesCleanupMetadata(changesFiles, directoryChangesMetadata[directory]);
        if (cleanupMetadataValidationResult) {
            result[`deb/${ directory }`] = cleanupMetadataValidationResult;
            return result;
        }
    }

    for (const directory of Object.keys(directoryChangesFiles)) {
        const [, release] = directory.split(path.sep);
        if (distributions[distro]?.releases[release]?.exists) {
            const cleanupResult = await cleanupQueuedReuploads(
                paths.repreproBin!,
                confDir,
                getDirectoryCleanupMetadata(directory, directoryChangesMetadata)
            );
            if (cleanupResult) {
                result[`deb/${ directory }`] = cleanupResult;
                return result;
            }
        }
    }

    for (const directory of Object.keys(directoryChangesFiles)) {
        const directoryComponents = directory.split(path.sep);
        const [, release, ...components] = directoryComponents;

        const incomingDir = path.join(incomingDebRoot, directory);
        const component = components.join('/');

        await updateIncomingConfigFile(distro, release, paths.repoStateDir, incomingDir);
        await updateOptionsFile(distro, paths.repoDir, paths.repoStateDir);
        await updateOverrideFile(distro, component, paths.repoStateDir);

        result[`deb/${ directory }`] = await repreproImportExec(paths.repreproBin!, confDir, distro);
    }

    return result;
}

async function reexportAndCleanupDistributions(distroMap: DebDistributionMap, paths: Paths): Promise<Record<string, ActionResult>> {
    const result: Record<string, ActionResult> = {};
    for (const distro of Object.keys(distroMap)) {
        if (distroMap[distro]) {
            const stateDir = path.join(paths.repoStateDir, `deb-${ distro }`);
            const confDir = path.join(stateDir, "conf");

            await updateDistributionsFileContent(distro, distroMap, paths.repoStateDir, paths.signScript);
            const exportResult =
                result[`deb/${ distro }`] = await repreproExportExec(paths.repreproBin!, confDir);
            if (exportResult.result === "success") {
                result[`deb/${ distro }`] = await repreproCleanupExec(paths.repreproBin!, confDir);
            }
        } else {
            logger.error(`No valid distribution configuration found for ${ distro }`);
        }
    }
    return result;
}

async function ensureDebRootExists(paths: Paths, gpg: Gpg) {
    const debRepoDir = osPath.join(paths.repoDir, "deb");
    if (!await fsExtra.pathExists(debRepoDir)) {
        await fsExtra.ensureDir(debRepoDir);
        await gpgInitDeb(paths, gpg);
    }
}

export interface StagingDirSnapshot {
    /** directory path relative to `process/deb/`, using forward slashes, e.g. "debian/trixie/main" */
    dirRel: string;
    /** basenames of files present in this directory (no nested subdirs) */
    files: string[];
}

/**
 * Recursively scan the given staging root and return a flat list of
 * leaf directories (directories containing files but no further subdirectories)
 * with their file basenames.
 *
 * Returns `[]` if the root does not exist. Other filesystem errors propagate.
 *
 * Path separators in the returned `dirRel` are forward slashes, matching
 * the project's `path.posix.join` convention for URL-shaped paths.
 */
export async function scanProcessDebTree(
    incomingDebRoot: string,
): Promise<StagingDirSnapshot[]> {
    const snapshots: StagingDirSnapshot[] = [];
    await walkStagingDir(incomingDebRoot, "", snapshots);
    return snapshots;
}

async function walkStagingDir(
    root: string, rel: string, out: StagingDirSnapshot[],
): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
        entries = await fs.readdir(osPath.join(root, rel), { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
    }
    const files: string[] = [];
    let sawSubdir = false;
    for (const e of entries) {
        if (e.isDirectory()) {
            sawSubdir = true;
            await walkStagingDir(root, path.posix.join(rel, e.name), out);
        } else if (e.isFile()) {
            files.push(e.name);
        }
    }
    if (files.length > 0 && !sawSubdir) {
        out.push({ dirRel: rel, files });
    }
}

export default async function processIncoming(paths: Paths, gpg: Gpg): Promise<ImportFile[]> {
    assert(paths.repreproBin, "repreproBin is not available");

    // Posix join: this value flows into reprepro's `IncomingDir:` config
    // (a tool-not-on-Windows artifact, posix-style by convention) as well as
    // into Node fs walkers below. Windows fs accepts forward slashes, so the
    // walkers are unaffected; reprepro config stays posix-clean.
    const incomingDebRoot = path.join(paths.incomingDir, "process", "deb");

    // Pre-scan: remember which files were present in each staging dir.
    const preSnaps = await scanProcessDebTree(incomingDebRoot);

    const changesMap = await findAndOrganizeChangesFiles(incomingDebRoot);
    const distroMap: DebDistributionMap = await readDistributions(paths.repoStateDir);
    const changesMetadataMap: Record<string, ChangesDirectoryMap> = {};
    // dirKey relative to `process/deb/`, e.g. "debian/trixie/main[/<sub>]"
    const failedDirs = new Set<string>();

    if (Object.keys(changesMap).length !== 0) {
        await ensureDebRootExists(paths, gpg);
        for (const [distro, directoryChangesFiles] of Object.entries(changesMap)) {
            changesMetadataMap[distro] = await parseChangesDirectoryMap(incomingDebRoot, directoryChangesFiles);
        }
        await mergeDistributionsWithChanges(changesMetadataMap, distroMap);

        for (const [distro, directoryChangesFiles] of Object.entries(changesMap)) {
            const distroResults = await processDistribution(
                distro,
                directoryChangesFiles,
                changesMetadataMap[distro],
                distroMap,
                incomingDebRoot,
                paths,
            );
            for (const [dirKey, actionResult] of Object.entries(distroResults)) {
                if (actionResult.result === "error" || actionResult.result === "script") {
                    // dirKey is "deb/<distro>/<release>/<component>[/<sub>]";
                    // strip the leading "deb/" to match StagingDirSnapshot.dirRel.
                    failedDirs.add(dirKey.replace(/^deb\//, ""));
                }
            }
        }
    }

    // Reexport and clean up distributions. Export is necessary, because the Origin/Description values might have
    // changed, so the importing defers exporting until now.
    if (!_.isEmpty(distroMap)) {
        await ensureDebRootExists(paths, gpg);
        await reexportAndCleanupDistributions(distroMap, paths);
    }

    // Post-scan: anything from pre-scan still present didn't get imported.
    const postSnaps = await scanProcessDebTree(incomingDebRoot);
    const postIndex = new Map<string, Set<string>>();
    for (const s of postSnaps) postIndex.set(s.dirRel, new Set(s.files));

    const sharedCid = getCorrelationId();
    const files: ImportFile[] = [];
    for (const pre of preSnaps) {
        const postFiles = postIndex.get(pre.dirRel) ?? new Set<string>();
        for (const name of pre.files) {
            const stillHere = postFiles.has(name);
            const logicalPath = path.posix.join("deb", pre.dirRel, name);

            let status: ImportFileStatus;
            let reason: string | undefined;

            if (!stillHere) {
                status = "ok";
            } else if (failedDirs.has(pre.dirRel)) {
                status = "failed";
                reason = sharedCid
                    ? `import failed, correlation id=${ sharedCid }`
                    : "import failed";
            } else {
                status = "skipped";
                reason = "reprepro did not process file (no .changes file references it)";
            }

            files.push({
                filename: name,
                path: logicalPath,
                status,
                ...(reason ? { reason } : {}),
            });
        }
    }

    return files;
}

export type DebRemovalFile = {
    filename: string;
    status: "ok" | "failed";
    path: string;
};

export type DebVersionFilter = VersionFilter;

export type DebRemovalResult =
    | { notFound: true }
    | { notFound: false; files: DebRemovalFile[]; action?: ActionResult };

export async function repreproListFilterWithFormatExec(
    repreproBin: string,
    confDir: string,
    release: string,
    formula: string,
    listFormat: string,
): Promise<ActionResult & { stdout: string }> {
    const repreproConfDir = path.isAbsolute(confDir) ? confDir : `+b/${ confDir }`;
    let stdout = "";
    const result = await execOpt({
        levelFn: (stdio, line) => {
            if (stdio === "stdout") {
                stdout += line + "\n";
                return "debug";
            }
            return "warn";
        },
    }, repreproBin,
       "--confdir", repreproConfDir,
       "--list-format", listFormat,
       "listfilter", release, formula);
    // Strip the trailing "\n" that the line-based logger appends after the
    // final record's "\0" terminator — without this, parseListFilterOutput
    // would see a spurious "\n"-only record at the end.
    if (stdout.endsWith("\n")) stdout = stdout.slice(0, -1);
    return { ...result, stdout };
}

export type DebListResult =
    | { notFound: true }
    | { notFound: false; files: DebRemovalFile[]; action?: ActionResult };

/**
 * Discover .changes and .buildinfo files in the source's pool directory
 * (preserved there when the distribution config sets
 * `Tracking: ... includechanges includebuildinfos`).
 *
 * Debian naming invariants: source names and versions contain no `_`, and
 * the arch-chunk joining architectures with `+` contains no `_` either, so
 * any file named `<dscBase>_<no-underscore>.{changes,buildinfo}` in the
 * pool dir belongs to this source. A pool without the tracked files (e.g.
 * a package imported before the flags were enabled) yields an empty array.
 */
async function discoverChangesAndBuildinfo(
    repoDir: string,
    distro: string,
    sourceDir: string,           // pool-relative, e.g. "pool/main/c/clevis"
    dscFilename: string,         // e.g. "clevis_22-1+tpm1u0+deb13.dsc"
): Promise<DebRemovalFile[]> {
    const dscBase = dscFilename.endsWith(".dsc")
        ? dscFilename.slice(0, -".dsc".length)
        : dscFilename;
    const prefix = `${ dscBase }_`;
    const poolDir = path.join(repoDir, "deb", distro, sourceDir);

    let names: string[];
    try {
        names = await fs.readdir(poolDir);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
    }

    const extra: DebRemovalFile[] = [];
    for (const name of names) {
        if (!name.startsWith(prefix)) continue;
        const rest = name.slice(prefix.length);
        if (rest.includes("_")) continue;
        if (!rest.endsWith(".changes") && !rest.endsWith(".buildinfo")) continue;
        extra.push({
            filename: name,
            status: "ok" as const,
            path: path.posix.join("deb", distro, sourceDir, name),
        });
    }
    return extra;
}

export async function listPackageFiles(
    paths: Paths,
    distro: string,
    release: string,
    source: string,
    version: VersionFilter,
): Promise<DebListResult> {
    assert(paths.repreproBin, "repreproBin is not available");

    const distroMap = await readDistributions(paths.repoStateDir, distro, release);
    if (!distroMap[distro] || !distroMap[distro].releases[release]) {
        return { notFound: true };
    }

    const confDir = path.join(paths.repoStateDir, `deb-${ distro }`, "conf");
    const formula = buildRemoveFormulaForTarget(source, version);

    const listResult = await repreproListFilterWithFormatExec(
        paths.repreproBin, confDir, release, formula, LISTFILTER_FORMAT,
    );
    if (listResult.result !== "success") {
        return { notFound: false, files: [], action: listResult };
    }

    const entries = parseListFilterOutput(listResult.stdout);
    const files: DebRemovalFile[] = entries.map((e) => ({
        filename: path.posix.basename(e.path),
        status: "ok" as const,
        path: path.posix.join("deb", distro, e.path),
    }));

    // Augment with .changes/.buildinfo when preserved in the pool by tracking flags.
    const dscEntry = entries.find((e) => e.type === "dsc" && e.path.endsWith(".dsc"));
    if (dscEntry !== undefined) {
        const sourceDir = path.posix.dirname(dscEntry.path);
        const dscFilename = path.posix.basename(dscEntry.path);
        const extras = await discoverChangesAndBuildinfo(
            paths.repoDir, distro, sourceDir, dscFilename,
        );
        files.push(...extras);
    }
    return { notFound: false, files };
}

export async function removePackage(
    paths: Paths,
    distro: string,
    release: string,
    source: string,
    version: VersionFilter
): Promise<DebRemovalResult> {
    assert(paths.repreproBin, "repreproBin is not available");

    const list = await listPackageFiles(paths, distro, release, source, version);
    if (list.notFound) return { notFound: true };
    if (list.action) {
        return { notFound: false, files: list.files, action: list.action };
    }
    const files = list.files;

    if (files.length === 0) {
        return { notFound: false, files: [] };
    }

    const confDir = path.join(paths.repoStateDir, `deb-${ distro }`, "conf");
    const formula = buildRemoveFormulaForTarget(source, version);

    const removeResult = await repreproExec(paths.repreproBin, confDir,
        "--export=silent-never", "removefilter", release, formula);
    if (removeResult.result !== "success") {
        return { notFound: false, files, action: removeResult };
    }

    const exportResult = await repreproExportExec(paths.repreproBin, confDir);
    if (exportResult.result !== "success") {
        return { notFound: false, files, action: exportResult };
    }

    const cleanupResult = await repreproCleanupExec(paths.repreproBin, confDir);
    return { notFound: false, files, action: cleanupResult };
}

export type DebRemovalTarget = { distribution: string; release: string };

export async function enumerateRemovalTargets(
    paths: Paths,
    distro: string | undefined,
    release: string | undefined
): Promise<DebRemovalTarget[]> {
    const distroMap = await readDistributions(paths.repoStateDir, distro, release);
    const targets: DebRemovalTarget[] = [];
    for (const [distName, distObj] of Object.entries(distroMap)) {
        for (const relName of Object.keys(distObj.releases)) {
            targets.push({ distribution: distName, release: relName });
        }
    }
    return targets;
}

export type DebSourcePackage = { source: string; version: string };

export async function listSourcePackages(
    paths: Paths,
    distro: string,
    release: string,
    source: string | undefined
): Promise<DebSourcePackage[]> {
    assert(paths.repreproBin, "repreproBin is not available");

    const distroMap = await readDistributions(paths.repoStateDir, distro, release);
    if (!distroMap[distro] || !distroMap[distro].releases[release]) {
        return [];
    }

    const confDir = path.join(paths.repoStateDir, `deb-${ distro }`, "conf");
    const formula = source === undefined
        ? `$Type (== dsc)`
        : `$Source (== ${ source }), $Type (== dsc)`;

    const result = await repreproListFilterWithFormatExec(
        paths.repreproBin, confDir, release, formula, SOURCEPKG_LISTFILTER_FORMAT,
    );
    if (result.result !== "success") return [];

    return parseSourcePackageListFilterOutput(result.stdout);
}
