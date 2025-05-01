import type { AppConfig, Gpg, Paths } from "./config.ts";
import fsExtra from "fs-extra";
import { exec } from "./exec.ts";
import logger from "./logger.ts";
import * as openpgp from "openpgp";
import { PublicKey } from "openpgp";
import osPath from "path";
import { glob } from "glob";
import { cached, type CachedValue } from "./cache.ts";
import fs from "fs/promises";

export async function extractPublicKey(privateKeyPath: string | undefined): Promise<openpgp.PublicKey | undefined> {
    if (privateKeyPath && await fsExtra.pathExists(privateKeyPath)) {
        const privateKeyData = await fs.readFile(privateKeyPath);

        try {
            let privateKey: openpgp.PrivateKey;
            try {
                privateKey = await openpgp.readPrivateKey({ armoredKey: privateKeyData.toString('utf8') });
            } catch {
                privateKey = await openpgp.readPrivateKey({ binaryKey: privateKeyData });
            }
            return privateKey.toPublic();
        } catch (err) {
            throw new Error(`Failed to read private key ${ privateKeyPath }`, { cause: err });
        }
    }
}

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
    await fsExtra.writeFile(repoKeyFile, publicKey.armor() + existingContent, 'utf8');
    logger.info(`Added public key to repository key file ${ repoKeyFile }`);
}

async function importGpgKeyFileIfExists(gpg: Gpg, filePath?: string | undefined) {
    if (gpg.gpgBin && filePath) {
        if (await fsExtra.exists(filePath)) {
            const result = await exec(gpg.gpgBin!, "--batch", "--quiet", "--import", filePath);
            if (result.result !== "success") {
                throw new Error(`Failed to import GPG public keys from ${ filePath }`);
            }
        } else {
            logger.warn(`GPG key file ${ filePath } does not exist.`);
        }
    }
}

async function importGpgPublicKeys(gpg: Gpg) {
    if (gpg.gpgBin) {
        await importGpgKeyFileIfExists(gpg, gpg.gpgPublicKeysFile);
        if (gpg.gpgPublicKeysDir && await fsExtra.pathExists(gpg.gpgPublicKeysDir)) {
            // noinspection SpellCheckingInspection
            for (const file of await glob('*', { cwd: gpg.gpgPublicKeysDir, nodir: true })) {
                await importGpgKeyFileIfExists(gpg, osPath.join(gpg.gpgPublicKeysDir, file));
            }
        }
    }
}

async function extractRepoPublicKey(gpg: Gpg): Promise<PublicKey | undefined> {
    if (gpg.gpgRepoPrivateKeyFile) {
        return await extractPublicKey(gpg.gpgRepoPrivateKeyFile);
    } else {
        return undefined;
    }
}

export async function gpgInitDeb(paths: Paths, gpg: Gpg,
    gpgRepoPublicKeyValue?: CachedValue<Promise<PublicKey | undefined>>) {
    if (await fsExtra.pathExists(osPath.join(paths.repoDir, "deb"))) {
        if (gpg.gpgRepoPrivateKeyFile) {
            const gpgRepoPublicKey =
                await (gpgRepoPublicKeyValue || extractRepoPublicKey.bind(null, gpg))();
            if (gpgRepoPublicKey) {
                const gpgRepoPublicKeyFile = osPath.join(paths.repoDir, "deb", "archive-keyring.asc");
                await addPublicKeyToRepo(gpgRepoPublicKeyFile, gpgRepoPublicKey);
                await importGpgKeyFileIfExists(gpg, gpgRepoPublicKeyFile);
            }
        }
        await importGpgPublicKeys(gpg);
    }
}

export async function gpgInitRpm(paths: Paths, gpg: Gpg,
    gpgRepoPublicKeyValue?: CachedValue<Promise<PublicKey | undefined>>) {
    if (await fsExtra.pathExists(osPath.join(paths.repoDir, "rpm"))) {
        if (gpg.gpgRepoPrivateKeyFile) {
            const gpgRepoPublicKey =
                await (gpgRepoPublicKeyValue || extractRepoPublicKey.bind(null, gpg))();
            if (gpgRepoPublicKey) {
                const gpgRepoPublicKeyFile = osPath.join(paths.repoDir, "rpm", "RPM-GPG-KEY.asc");
                await addPublicKeyToRepo(gpgRepoPublicKeyFile, gpgRepoPublicKey);
            }
        }
    }
}

export async function gpgInit(config: AppConfig) {
    const gpgRepoPublicKey =
        cached(async () => extractRepoPublicKey(config.gpg));

    if (config.upload.enabledApi.deb) {
        await gpgInitDeb(config.paths, config.gpg, gpgRepoPublicKey);
    }
    if (config.upload.enabledApi.rpm) {
        await gpgInitRpm(config.paths, config.gpg, gpgRepoPublicKey);
    }
}
