import fs from "node:fs/promises";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import _ from "lodash";
import osPath from "path";
import untildify from "untildify";
import logger from "./logger.ts";
import fsExtra from "fs-extra";
import proxyAddr from "proxy-addr";
import { execOpt } from "./exec.ts";
import { parseHumanJsonArray, parseHumanJsonObject } from "./json.ts";

export type Certificate = { cert: Buffer; key: Buffer } | { cert?: undefined; key?: undefined };

export type Addresses = [null] | [string, ...string[]];
export type TcpServerOptions = { hosts?: string[], addresses: Addresses, ports?: number[] | undefined };
export type TcpSecureServerOptions = TcpServerOptions & Certificate;

export type Http = {
    secure: boolean,
    serverOptions: TcpSecureServerOptions,
};

export type IpCheckFn = (addr: string) => boolean;

export type AppConfig = {
    security: Security,
    paths: Paths,
    gpg: Gpg,
    upload: UploadOptions,
    instanceLabel?: string,
}

export type Security = {
    trustProxy?: IpCheckFn,
}

export type Gpg = {
    gpgBin?: string | null,
    gpgRepoPrivateKeyFile?: string,
    gpgPublicKeysFile?: string,
    gpgPublicKeysDir?: string,
}

export type Paths = {
    incomingDir: string,
    repoStateDir: string,
    repoDir: string,
    templateDir?: string,
    signScript?: string,
    createrepoScript?: string | null,
    repreproBin?: string | null,
}

export type EnabledApi = {
    deb: boolean,
    rpm: boolean,
}

export type UploadOptions = {
    enabledApi: EnabledApi,
    allowedIps?: IpCheckFn,
    basicAuth?: string[],
    bearerAuth?: string[],
    sizeLimit?: number,
    postField: string,
}

export type Environment = "production" | "development" | "test";

export type Config = {
    environment: Environment,
    app: AppConfig,
    http: Http,
}

const environment: Environment = process.env.NODE_ENV === "production" ?
    "production" :
    process.env.NODE_ENV === "test" ?
        "test" :
        "development";

const incomingDir = process.env.INCOMING_DIR ? untildify(process.env.INCOMING_DIR) : 'data/incoming';
const repoStateDir = process.env.REPO_STATE_DIR ? untildify(process.env.REPO_STATE_DIR) : 'data/repo-state';
const repoDir = process.env.REPO_DIR ? untildify(process.env.REPO_DIR) : 'data/repo';
const templateDir = process.env.TEMPLATES_DIR ? untildify(process.env.TEMPLATES_DIR) : undefined;
const gpgRepoPrivateKeyFile = process.env.GPG_REPO_PRIVATE_KEY_FILE ? untildify(process.env.GPG_REPO_PRIVATE_KEY_FILE) :
    undefined;
const gpgPublicKeysFile = process.env.GPG_PUBLIC_KEYS_FILE ? untildify(process.env.GPG_PUBLIC_KEYS_FILE) : undefined;
const gpgPublicKeysDir = process.env.GPG_PUBLIC_KEYS_DIR ? untildify(process.env.GPG_PUBLIC_KEYS_DIR) : undefined;
const signScript = (gpgRepoPrivateKeyFile && await fsExtra.pathExists(gpgRepoPrivateKeyFile)) ?
    (process.env.SIGN_SCRIPT ? untildify(process.env.SIGN_SCRIPT) : osPath.join('scripts', 'sign.sh')) :
    undefined;
let createrepoScript: string | undefined | null = process.env.CREATEREPO_SCRIPT !== undefined ?
    (process.env.CREATEREPO_SCRIPT ? untildify(process.env.CREATEREPO_SCRIPT) : undefined) :
    osPath.join('scripts', 'createrepo.sh');
let repreproBin: string | undefined | null = process.env.REPREPRO_BIN !== undefined ?
    (process.env.REPREPRO_BIN ? untildify(process.env.REPREPRO_BIN) : undefined) :
    "reprepro";
let gpgBin: string | undefined | null = process.env.GPG_BIN !== undefined ?
    (process.env.GPG_BIN ? untildify(process.env.GPG_BIN) : undefined) :
    "gpg";

if (createrepoScript || repreproBin) {
    logger.debug("Checking existence of repository tools")
    if (createrepoScript) {
        if ((await execOpt({ errorAsWarn: true }, createrepoScript, "--version")).result !== "success") {
            logger.warn("No usable createrepo_c tool found");
            createrepoScript = null;
        }
    }
    if (repreproBin) {
        if ((await execOpt({
            errorAsWarn: true,
            levelFn: (stdio: string, message: string) => {
                switch (stdio) {
                    case "stderr":
                        return message.includes("reprepro version") ? "info" : "warn";
                    default:
                        return "info";
                }
            }
        }, repreproBin, "--version")).result !== "success") {
            logger.warn("No usable reprepro tool found");
            repreproBin = null;
        }
    }
}
if (gpgBin) {
    if ((await execOpt({ errorAsWarn: true }, gpgBin, "--version")).result !== "success") {
        logger.warn("No usable gpg tool found");
        gpgBin = null;
    }
}

const paths: Paths = {
    incomingDir,
    repoStateDir,
    repoDir,
    templateDir,
    signScript,
    createrepoScript,
    repreproBin,
};

const gpg: Gpg = {
    gpgBin,
    gpgRepoPrivateKeyFile,
    gpgPublicKeysFile,
    gpgPublicKeysDir,
}

const trustProxyArray = process.env.TRUST_PROXY?.trim().split(",").map((ip) => ip.trim()).filter(Boolean);
const trustProxy = !_.isEmpty(trustProxyArray) ? proxyAddr.compile(trustProxyArray) : undefined;

const security: Security = {
    trustProxy,
};

function readApiEnv(primary: string, legacy: string, label: string): string | undefined {
    const primaryValue = process.env[primary]?.trim();
    const legacyValue = process.env[legacy]?.trim();
    if (primaryValue && legacyValue) {
        logger.warn(`${ primary } overrides deprecated ${ legacy } (${ label }); please remove ${ legacy } from the environment`);
        return primaryValue;
    }
    if (primaryValue) return primaryValue;
    if (legacyValue) {
        logger.warn(`Deprecated ${ legacy } is set (${ label }); please rename to ${ primary }`);
        return legacyValue;
    }
    return undefined;
}

const allowedIpsRaw = readApiEnv("API_ALLOWED_IPS", "UPLOAD_ALLOWED_IPS", "IP allowlist");
const allowedIpsArray = allowedIpsRaw?.split(",").map((ip) => ip.trim()).filter(Boolean);
const allowedIps = !_.isEmpty(allowedIpsArray) ? proxyAddr.compile(allowedIpsArray) : undefined;

const basicAuthEnv = readApiEnv("API_BASIC_AUTH", "UPLOAD_BASIC_AUTH", "basic credentials");
let basicAuth: string[] | undefined = undefined;
try {
    basicAuth = Object.entries(parseHumanJsonObject(basicAuthEnv ?? "").value)
        .filter(([user, password]) =>
            _.isString(user) && _.isString(password)
            && !_.isEmpty(user) && !_.isEmpty(password))
        .map(([user, password]) => `${ user }:${ password }`)
} catch (err) {
    console.error(`Unable to parse BASIC_AUTH value: ${ err instanceof Error ? err.message : String(err) }`);
    process.exit(1);
}
if (_.isEmpty(basicAuth)) {
    basicAuth = undefined;
}

const bearerAuthEnv = process.env.API_BEARER_AUTH?.trim();
let bearerAuth: string[] | undefined = undefined;
try {
    bearerAuth = parseHumanJsonArray(bearerAuthEnv ?? "").value
        .map((token) => token.trim())
        .filter((token) => !_.isEmpty(token));
} catch (err) {
    console.error(`Unable to parse API_BEARER_AUTH value: ${ err instanceof Error ? err.message : String(err) }`);
    process.exit(1);
}
if (_.isEmpty(bearerAuth)) {
    bearerAuth = undefined;
}

const sizeLimitEnv = process.env.UPLOAD_SIZE_LIMIT?.trim();
const sizeLimit = sizeLimitEnv ? parseInt(sizeLimitEnv) : undefined;
const postField = (process.env.UPLOAD_POST_FIELD && process.env.UPLOAD_POST_FIELD.trim()) || 'package';

const enabledApi = {
    deb: !!repreproBin || environment === "development",
    rpm: !!createrepoScript || environment === "development",
}

const upload: UploadOptions = {
    enabledApi,
    allowedIps,
    basicAuth,
    bearerAuth,
    sizeLimit,
    postField,
};

const instanceLabel = process.env.INSTANCE_LABEL?.trim() || undefined;

const app: AppConfig = {
    security,
    paths,
    gpg,
    upload,
    instanceLabel,
};

const listenDefaultHosts = environment === "production" ? null : "localhost";

function formatListenHosts(hosts: string | null): string[] {
    const hostsArray = (hosts?.split(",") ?? []).map((host) => host.trim());
    return Array.from(new Set<string>(hostsArray)).filter((host) => !_.isEmpty(host) && !isIP(host));
}

async function resolveListenHosts(hosts: string | null): Promise<Addresses> {
    const hostsArray = (hosts?.split(",") ?? []).map((host) => host.trim());
    const hostsAddressesArray = (await Promise.all(hostsArray.map(async (host) => {
        return (isIP(host) || _.isEmpty(host)) ? host : await dns.lookup(host, { all: true, order: "ipv4first" });
    }))).flat();
    let listenAddresses = Array.from(new Set<string>(
        hostsAddressesArray.map((address) => _.isString(address) ? address : address.address)));
    listenAddresses = listenAddresses.filter((address) => !_.isEmpty(address));
    if (listenAddresses.length == 0) {
        // @ts-expect-error single null value represents all-network-address here
        listenAddresses.push(null);
    }
    return listenAddresses as Addresses;
}

function parsePortList(ports: string | undefined, defaultPort?: number): number[] {
    return (_.isEmpty(ports)
            ? (defaultPort ? [defaultPort] : [])
            : ports!.split(",").map(v => v.trim()).filter(Boolean).map((port) => parseInt(port))
    );
}

const withHttps = !!process.env.HTTPS_KEY_FILE && !!process.env.HTTPS_CERT_FILE;

if (withHttps && environment !== "production"
    && !await fsExtra.pathExists(process.env.HTTPS_KEY_FILE!)
    && !await fsExtra.pathExists(process.env.HTTPS_CERT_FILE!)) {
    logger.info("Generating self-signed certificate for HTTPS server...");
    const attrs = [{ name: 'commonName', value: 'localhost' }];
    // noinspection SpellCheckingInspection
    const pems = await (await import("selfsigned")).generate(attrs, { keySize: 2048 });
    const keyDir = osPath.dirname(process.env.HTTPS_KEY_FILE!);
    const certDir = osPath.dirname(process.env.HTTPS_CERT_FILE!);
    if (keyDir) {
        await fsExtra.ensureDir(keyDir);
    }
    if (certDir) {
        await fsExtra.ensureDir(certDir);
    }
    await fs.writeFile(process.env.HTTPS_KEY_FILE!, pems.private);
    await fs.writeFile(process.env.HTTPS_CERT_FILE!, pems.cert);
}
const httpsCertificate: Certificate =
    withHttps
        ? {
            key: await fs.readFile(process.env.HTTPS_KEY_FILE!),
            cert: await fs.readFile(process.env.HTTPS_CERT_FILE!),
        }
        : {};

const httpListenHostsEnv = process.env.HTTP_HOST?.trim();
const httpListenHostsStr = httpListenHostsEnv ? httpListenHostsEnv : listenDefaultHosts;
const httpListenHosts = formatListenHosts(httpListenHostsStr);
const httpListenAddresses = await resolveListenHosts(httpListenHostsStr);
const httpListenPorts = parsePortList(process.env.HTTP_PORT, 3000);
const http: Http = {
    secure: withHttps,
    serverOptions: {
        hosts: httpListenHosts,
        addresses: httpListenAddresses,
        ports: httpListenPorts,
        ...httpsCertificate
    }
}

const config: Config = {
    environment,
    app,
    http,
};

export default config;
