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

type DistrosMap = Record<string, Record<string, Distribution>>;
type Distribution = {
    components: Set<string>,
    architectures: Set<string>,
}

function sanitize(str: string) {
    return str.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
}

function getEnv(prefix: string, distro: string, release: string): string | undefined {
    const distroEnv = sanitize(distro);
    const releaseEnv = sanitize(release);

    return (
        process.env[`${ prefix }_${ distroEnv }_${ releaseEnv }`] ??
        process.env[`${ prefix }_${ releaseEnv }`] ??
        process.env[`${ prefix }_${ distroEnv }`] ??
        process.env[`${ prefix }`]
    )
}

function getEnvOrigin(distro: string, release: string) {
    return getEnv('DEB_ORIGIN', distro, release);
}

function getEnvDescription(distro: string, release: string) {
    return getEnv('DEB_DESCRIPTION', distro, release);
}

async function readDistributions(distributions: string[], repoDir: string): Promise<DistrosMap> {
    // The path will be <repoDir>/deb/<distro>/dists/<release>/Release
    const debRoot = path.join(repoDir, "deb");
    let releaseFiles;
    if (distributions.length === 1) {
        releaseFiles = await glob(`${ distributions[0] }/dists/*/Release`,
            { cwd: debRoot, posix: true });
    } else {
        releaseFiles = await glob(`{${ distributions.join(",") }}/dists/*/Release`,
            { cwd: debRoot, posix: true, magicalBraces: true });
    }
    const distros: DistrosMap = {};

    for (const releaseFile of releaseFiles) {
        const pathSplit = releaseFile.split(path.sep);
        const [distro, , release] = pathSplit;

        const releaseFilePath = path.join(debRoot, releaseFile);
        const content = await fs.readFile(releaseFilePath, 'utf-8');

        const componentsMatch = content.match(/^Components:\s*(.+)$/m);
        const components = componentsMatch ? componentsMatch[1].trim() : '';

        const architecturesMatch = content.match(/^Architectures:\s*(.+)$/m);
        const architectures = architecturesMatch ? architecturesMatch[1].trim() : '';

        if (components.length > 0 && architectures.length > 0) {
            if (!distros[distro]) {
                distros[distro] = {};
            }

            distros[distro][release] = {
                architectures: new Set(architectures.split(' ').filter(Boolean)),
                components: new Set(components.split(' ').filter(Boolean))
            };
        } else {
            if (components.length === 0) {
                logger.warn(`No components found in ${ releaseFilePath }`);
            }
            if (architectures.length === 0) {
                logger.warn(`No architectures found in ${ releaseFilePath }`);
            }
        }
    }

    return distros;
}

function generateDistributionsContent(signScript: string | undefined, distros: DistrosMap) {
    const distrosContent: Record<string, string> = {};
    for (const [distro, releaseComponents] of Object.entries(distros)) {
        let content = "";
        for (const [release, distribution] of Object.entries(releaseComponents)) {
            if (content.length > 0) {
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
                Components: ${ [...distribution.components].join(' ') }
                Architectures: ${ [...distribution.architectures].join(' ') }
                `,
                origin ? "Origin: " + origin : undefined,
                description ? "Description: " + description : undefined,
                dedent`
                DebOverride: +c/override
                UDebOverride: +c/override
                DscOverride: +c/override
                Tracking: minimal
                Contents:
                `,
                signWith
            ].filter(Boolean).join("\n");
            if (content) {
                content += "\n";
            }
        }
        if (content.length > 0) {
            distrosContent[distro] = content;
        }
    }

    return distrosContent;
}

function generateIncomingContent(distro: string, release: string, incomingDir: string, tmpTmpDir: string) {
    return dedent`
        Name: ${ distro }
        IncomingDir: ${ incomingDir }
        TempDir: ${ tmpTmpDir }
        Allow: ${ release }
        Cleanup: unused_buildinfo_files\n
    `;
}

async function parseChangesArchitectures(incomingDebRoot: string, changesFiles: string[]) {
    const architectures = new Set<string>();
    for (const changesFile of changesFiles) {
        const content = await fs.readFile(path.join(incomingDebRoot, changesFile), 'utf-8');
        const architecturesMatch = content.match(/^Architecture:\s*(.+)$/m);
        const architecturesString = architecturesMatch ? architecturesMatch[1].trim() : '';
        architecturesString.split(' ').filter(Boolean).forEach((architecture) => architectures.add(architecture));
    }
    return architectures;
}

async function repreproExec(repreproBin: string, confDir: string, ...args: string[]): Promise<ActionResult> {
    const repreproConfDir = path.isAbsolute(confDir) ? confDir : `+b/${ confDir }`;
    return await exec(repreproBin, "--confdir", repreproConfDir, ...args);
}

async function repreproImportExec(repreproBin: string, confDir: string, distro: string): Promise<ActionResult> {
    return await repreproExec(repreproBin, confDir, "--ignore=undefinedtarget", 'processincoming', distro);
}

async function repreproCleanupExec(repreproBin: string, confDir: string): Promise<ActionResult> {
    return await repreproExec(repreproBin, confDir, "clearvanished");
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

/**
 * Merges existing distributions with changes files
 */
async function mergeDistributionsWithChanges(
    incomingDebRoot: string,
    changesMap: Record<string, Record<string, string[]>>,
    repoDir: string
): Promise<DistrosMap> {
    const distributions = await readDistributions(Object.keys(changesMap), repoDir);

    // Merge existing distributions with changes files
    for (const [distro, directoryChangesFiles] of Object.entries(changesMap)) {
        const releaseDistribution = distributions[distro] ?? (distributions[distro] = {});
        for (const [directory, changesFiles] of Object.entries(directoryChangesFiles)) {
            const directoryComponents = directory.split(path.sep);
            const [, release, ...components] = directoryComponents;

            const component = components.join('/');
            const architectures = await parseChangesArchitectures(incomingDebRoot, changesFiles);

            const distribution = releaseDistribution[release] ??
                (releaseDistribution[release] = { architectures: new Set(), components: new Set() });
            distribution.components.add(component);
            distribution.architectures = distribution.architectures.union(architectures);
        }
    }

    return distributions;
}

/**
 * Processes a single distribution
 */
async function processDistribution(
    distro: string,
    directoryChangesFiles: Record<string, string[]>,
    distributionFiles: Record<string, string>,
    incomingDebRoot: string,
    paths: Paths
): Promise<Record<string, ActionResult>> {
    const result: Record<string, ActionResult> = {};

    const stateDir = path.join(paths.repoStateDir, `deb-${ distro }`);
    const outDir = path.join(paths.repoDir, "deb", distro);
    const dbDir = path.join(stateDir, `db`);
    const confDir = path.join(stateDir, "conf");

    await fsExtra.ensureDir(outDir);
    await fsExtra.ensureDir(dbDir);
    await fsExtra.ensureDir(confDir);
    if (logger.isDebugEnabled()) {
        logger.debug(`Writing conf/distributions:\n${ distributionFiles[distro].trim() }`);
    }
    await fs.writeFile(path.join(confDir, "distributions"), distributionFiles[distro]);

    for (const directory of Object.keys(directoryChangesFiles)) {
        const directoryComponents = directory.split(path.sep);
        const [, release, ...components] = directoryComponents;

        const incomingDir = path.join(incomingDebRoot, directory);
        const tmpTmpDir = path.join(stateDir, `tmp-${ release }`);
        const component = components.join('/');

        await fsExtra.ensureDir(tmpTmpDir);

        const incomingContent = generateIncomingContent(distro, release, incomingDir, tmpTmpDir);
        if (logger.isDebugEnabled()) {
            logger.debug(`Writing conf/incoming:\n${ incomingContent.trim() }`);
        }
        await fs.writeFile(path.join(confDir, "incoming"), incomingContent);

        const optionsContent = dedent`
            verbose
            outdir ${ path.isAbsolute(outDir) ? outDir : `+b/${ outDir }` }
            dbdir ${ path.isAbsolute(dbDir) ? dbDir : `+b/${ dbDir }` }\n
        `;
        if (logger.isDebugEnabled()) {
            logger.debug(`Writing conf/options:\n${ optionsContent.trim() }`);
        }
        await fs.writeFile(path.join(confDir, "options"), optionsContent);

        const overrideContent = dedent`
            * $Component ${ component }\n
        `;
        if (logger.isDebugEnabled()) {
            logger.debug(`Writing conf/override:\n${ overrideContent.trim() }`);
        }
        await fs.writeFile(path.join(confDir, "override"), overrideContent);

        result[`deb/${ directory }`] = await repreproImportExec(paths.repreproBin!, confDir, distro);
    }

    return result;
}

async function cleanupDistributions(paths: Paths): Promise<Record<string, ActionResult>> {
    const distributions = await (glob("*/", { cwd: path.join(paths.repoDir, "deb") }));
    const result: Record<string, ActionResult> = {};
    for (const distro of distributions) {
        const stateDir = path.join(paths.repoStateDir, `deb-${ distro }`);
        const confDir = path.join(stateDir, "conf");
        result[`deb/${ distro }`] = await repreproCleanupExec(paths.repreproBin!, confDir);
    }
    return result;
}

export default async function processIncoming(paths: Paths, gpg: Gpg): Promise<Record<string, ActionResult>> {
    assert(paths.repreproBin, "repreproBin is not available");
    
    const incomingDebRoot = path.join(paths.incomingDir, "process", "deb");
    const changesMap = await findAndOrganizeChangesFiles(incomingDebRoot);

    const result: Record<string, ActionResult> = {};

    const debRepoDir = osPath.join(paths.repoDir, "deb");

    // Import new packages
    if (Object.keys(changesMap).length !== 0) {
        if (!await fsExtra.pathExists(debRepoDir)) {
            await fsExtra.ensureDir(debRepoDir);
            await gpgInitDeb(paths, gpg);
        }

        const distributions = await mergeDistributionsWithChanges(incomingDebRoot, changesMap, paths.repoDir);
        const distributionFiles = generateDistributionsContent(paths.signScript, distributions);

        for (const [distro, directoryChangesFiles] of Object.entries(changesMap)) {
            const distroResults = await processDistribution(
                distro,
                directoryChangesFiles,
                distributionFiles,
                incomingDebRoot,
                paths
            );

            // Merge results
            Object.assign(result, distroResults);
        }
    }

    // Clean-up distributions
    if (await fsExtra.pathExists(debRepoDir)) {
        Object.assign(result, await cleanupDistributions(paths));
    }

    return result;
}
