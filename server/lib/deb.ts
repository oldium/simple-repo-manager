import { glob } from "glob";
import path from "node:path/posix";
import fs from "node:fs/promises";
import logger from "./logger.ts";
import type { Gpg, Paths } from "./config.ts";
import fsExtra from "fs-extra";
import { type ActionResult, exec } from "./exec.ts";
import dedent from "dedent";
import assert from "node:assert";
import osPath from "path";
import { gpgInitDeb } from "./gpg.ts";
import { getEnv } from "./env.ts";
import type { DebDistribution, DebDistributionMap, DebRelease, DebReleaseMap, DebRepository } from "./repo.ts";
import _ from "lodash";
import { Readable } from "node:stream";
import * as readline from "node:readline";

const REPREPRO_REMOVEFILTER_MAX_CLAUSES = 25;
const REPREPRO_REMOVEFILTER_MAX_FORMULA_LENGTH = 4096;
const DEBIAN_CLEANUP_VALUE_REGEX = /^[a-z0-9.+:~_-]+$/;

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
            Tracking: minimal
            Limit: 2
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
        Cleanup: unused_buildinfo_files\n
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
        if (metadata.source && !DEBIAN_CLEANUP_VALUE_REGEX.test(metadata.source)) {
            return {
                result: "error" as const,
                message: `Debian changes file ${ changesFile } has invalid/unsupported Source for cleanup: ${ metadata.source }`
            } satisfies ActionResult;
        }
        if (metadata.version && !DEBIAN_CLEANUP_VALUE_REGEX.test(metadata.version)) {
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

export default async function processIncoming(paths: Paths, gpg: Gpg): Promise<Record<string, ActionResult>> {
    assert(paths.repreproBin, "repreproBin is not available");

    const incomingDebRoot = path.join(paths.incomingDir, "process", "deb");
    const changesMap = await findAndOrganizeChangesFiles(incomingDebRoot);

    const result: Record<string, ActionResult> = {};

    // Read all distributions
    const distroMap: DebDistributionMap = await readDistributions(paths.repoStateDir);
    const changesMetadataMap: Record<string, ChangesDirectoryMap> = {};

    // Import new packages
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
                paths
            );

            // Merge results
            Object.assign(result, distroResults);
        }
    }

    // Reexport and clean up distributions. Export is necessary, because the Origin/Description values might have
    // changed, so the importing defers exporting until now.
    if (!_.isEmpty(distroMap)) {
        await ensureDebRootExists(paths, gpg);
        Object.assign(result, await reexportAndCleanupDistributions(distroMap, paths));
    }

    return result;
}
