import type { Stats } from "fs";
import type { Digests } from "../hash.ts";
import { checkSafeName, checkVersion } from "../staging.ts";
import { rpmHref, rpmPoolPath } from "./catalog.ts";
import type { RpmPackageInput } from "./catalog.ts";
import { parseSourceRpmName, readRpmHeader } from "./header.ts";
import { renderFilelistsPackage, renderOtherPackage, renderPrimaryPackage } from "./xml.ts";
import type { RpmMeta } from "./xml.ts";
import { checkPosixPath } from "../../lib/safe-path.ts";

/** The catalog input for an .rpm on disk: its source identity, pool path and the metadata fragments rendered from its header */
export async function readRpm(location: string, name: string, target: { distro: string; release: string }, digests: Digests, stat: Stats):
    Promise<RpmPackageInput> {

    const header = await readRpmHeader(location);
    const source = header.isSource ? { name: header.name, version: header.version, release: header.release } : parseSourceRpmName(header.sourceRpm);
    const sourceVersion = `${ source.version }-${ source.release }`;
    checkSafeName("rpmName", header.name, "NAME");
    // The name rule, as x86_64 does not fit the Debian one
    checkSafeName("rpmName", header.arch, "ARCH");
    checkSafeName("rpmName", source.name, "source name");
    checkVersion(header.version, "VERSION");
    checkVersion(header.release, "RELEASE");
    checkVersion(sourceVersion, "source version");
    const poolPath = rpmPoolPath(target.distro, target.release, source.name, name);
    // The catalog commits before the move, which must not fail on the name then
    checkPosixPath(poolPath);
    const meta: RpmMeta = { ...header, pkgid: digests.sha256, size: digests.size, mtime: Math.floor(stat.mtimeMs / 1000), href: rpmHref(source.name, name) };
    return {
        ...target, filename: name, name: header.name, epoch: header.epoch, version: header.version, rel: header.release, arch: header.arch,
        sourceName: source.name, sourceVersion, file: { path: poolPath, ...digests },
        primaryXml: renderPrimaryPackage(meta), filelistsXml: renderFilelistsPackage(meta), otherXml: renderOtherPackage(meta),
    };
}
