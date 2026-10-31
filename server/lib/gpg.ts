import type { AppConfig, Gpg } from "./config.ts";
import fsExtra from "fs-extra";
import logger from "./logger.ts";
import * as openpgp from "openpgp";
import osPath from "path";
import path from "path/posix";
import fs from "fs/promises";
import { loadSigningKey } from "../backend/pgp.ts";
import { writeFileAtomic } from "../backend/publish-fs.ts";
import { KEYRING_FILES } from "./validations.ts";

async function addPublicKeyToRepo(repoKeyFile: string, publicKey: openpgp.PublicKey) {
    let existingContent = "";
    if (await fsExtra.pathExists(repoKeyFile)) {
        existingContent = await fs.readFile(repoKeyFile, 'utf8');
        const keysMatch = existingContent.split(
            /(-----BEGIN (PGP (?:PUBLIC|PRIVATE) KEY BLOCK)-----[\s\S]+?-----END \2-----)/g);
        const armoredKeys = keysMatch.filter((_, index) => index % 3 === 1);
        for (const armoredKey of armoredKeys) {
            const readKeys = await openpgp.readKeys({ armoredKeys: armoredKey });
            if (readKeys.some(k => publicKey.getKeyID().equals(k.getKeyID()))) {
                logger.debug(`Public key already exists in the repository key file ${ repoKeyFile }`);
                return;
            }
        }
    }
    await writeFileAtomic(repoKeyFile, publicKey.armor() + existingContent);
    logger.info(`Added public key to repository key file ${ repoKeyFile }`);
}

/** To the keyring of each format directory that exists */
export async function addPublicKeyToKeyrings(repoDir: string, publicKey: openpgp.PublicKey): Promise<void> {
    for (const format of ["deb", "rpm"] as const) {
        if (await fsExtra.pathExists(osPath.join(repoDir, format))) {
            await addPublicKeyToRepo(osPath.join(repoDir, format, KEYRING_FILES[format]), publicKey);
        }
    }
}

export async function gpgDebPublicKeyPath(repoDir: string, gpg: Gpg) {
    const gpgRepoPublicKeyFile = osPath.join(repoDir, "deb", KEYRING_FILES.deb);
    if (gpg.gpgRepoPrivateKeyFile && await fsExtra.pathExists(gpgRepoPublicKeyFile)) {
        return path.join("/deb", KEYRING_FILES.deb);
    } else {
        return undefined;
    }
}

export async function gpgInit(config: AppConfig) {
    const publicKey = (await loadSigningKey(config.gpg.gpgRepoPrivateKeyFile))?.toPublic();
    if (publicKey) {
        await addPublicKeyToKeyrings(config.paths.repoDir, publicKey);
    }
}
