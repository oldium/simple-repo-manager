import type { Environment, Gpg, Paths } from "./config.ts";
import { Eta } from "eta";
import escapeHtml from "escape-html";
import fsExtra from "fs-extra";
import fs from "fs/promises";
import { default as osPath } from "node:path";
import path from "node:path/posix";
import type { Distribution, Release, Repository, RepoType } from "./repo.ts";
import { getEnv, sanitize } from "./env.ts";
import logger from "./logger.ts";
import { fileURLToPath } from "node:url";
import type { Request } from "express";
import { gpgPublicKeyPath } from "./gpg.ts";
import { getHostname, getUriNoQuery } from "./req.ts";
import _ from "lodash";
import dedent from "dedent";
import { getBackend } from "../backend/index.ts";
import { repoDirectoryName } from "./file-naming.ts";
import { toOsPath } from "./safe-path.ts";

const loadedTemplate: Record<string, boolean> = {};

function safeSlug(slug: string) {
    return slug.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
}

async function locateTemplate(eta: Eta, type: RepoType, distro: string, release: string) {
    for (const definition of [[distro, release], [release], [distro], []]) {
        const templateName = safeSlug([type, ...definition].join("-"));
        const templateFile = getEnv(sanitize([type, "TEMPLATE", ...definition].join("_").toUpperCase()));
        if (templateFile && await fsExtra.pathExists(templateFile)) {
            return { templateName: `@${ templateName }`, templateFile }
        } else if (eta.config.views &&
            await fsExtra.pathExists(toOsPath(eta.config.views, templateName + eta.config.defaultExtension))) {
            return { templateName }
        }
    }
    return { templateName: `@default-${ type }` }
}

function getTemplateDir(environment: Environment) {
    switch (environment) {
        case "production":
            return osPath.join(osPath.dirname(fileURLToPath(import.meta.url)), "..", "templates");
        default:
            return osPath.join(osPath.dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
    }
}

function renderConfigRef(refName: string, title: string, releaseName: string) {
    return `<a href="#cfg:${ escapeHtml(refName) }" title="${ escapeHtml(title) }">${ escapeHtml(releaseName) }</a>`
}

function renderConfigSection(refName: string, title: string, content: string) {
    return [
        `<section id="${ escapeHtml(refName) }">`,
        `<h3>${ escapeHtml(title) }</h3>`,
        content.trimEnd(),
        `</section>`
    ].join("\n");
}

async function renderTemplate<T extends object>(eta: Eta, templateName: string, templatePath: string | undefined,
    data: T) {
    if (templatePath && !loadedTemplate[templateName]) {
        let template;
        try {
            template = await fs.readFile(templatePath, 'utf8');
        } catch (err) {
            logger.error(`Failed to read config template: ${ err }`);
            return;
        }
        try {
            const compiledTemplate = eta.compile(template);
            eta.loadTemplate(templateName, compiledTemplate);
            loadedTemplate[templateName] = true;
        } catch (err) {
            logger.error(`Failed to compile template: ${ err }`);
            return;
        }
    }

    try {
        return eta.render<T>(templateName, data);
    } catch (err) {
        logger.error(`Failed to render template: ${ err }`);
    }
}

type RenderData = {
    gpgUri: string | undefined;
    rootUri: string;
    repoUri: string;
    repoSlug: string;
    repoDashSlug: string;
    repoName: string;
    distroUri: string;
    distroSlug: string;
    distroName: string;
    releaseUri: string;
    releaseSlug: string;
    releaseName: string;
    [key: string]: string[] | string | undefined;
};

async function renderDistroConfig<T extends Repository>(req: Request, eta: Eta, repoDir: string, gpg: Gpg,
    repoObj: T, repoData?: (repoObj: T, distro: string, release: string, data: RenderData) => object) {
    const navigation: string[] = [];
    const configs: string[] = [];

    const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
    const repoEnvPrefix = repoObj.type.toUpperCase();
    const debDistros = repoObj.distributions;
    const renderData: Record<string, RenderData[]> = {};
    if (Object.keys(repoObj.distributions).length !== 0) {
        for (const [distro, distroObj] of Object.entries(debDistros)) {
            for (const [release, releaseObj] of Object.entries(distroObj.releases)) {
                const gpgPath = await gpgPublicKeyPath(repoDir, gpg, repoObj.type);
                const repoSlug = getEnv(`${ repoEnvPrefix }_SLUG`, distro, release) ?? getEnv("SLUG") ?? getHostname(req);
                const data: RenderData = {
                    gpgUri: gpgPath ? getUriNoQuery(req, gpgPath) : undefined,
                    rootUri: getUriNoQuery(req, "/"),
                    repoUri: getUriNoQuery(req, repoObj.path),
                    repoSlug: repoSlug,
                    repoDashSlug: safeSlug(repoSlug),
                    repoName: getEnv(`${ repoEnvPrefix }_REPO_NAME`, distro, release) ?? getEnv("REPO_NAME") ??
                        `Repository ${ repoSlug }`,
                    distroUri: getUriNoQuery(req, distroObj.path),
                    distroSlug: distro,
                    distroName: getEnv(`${ repoEnvPrefix }_DISTRO_NAME`, distro) ?? _.capitalize(distro),
                    releaseUri: getUriNoQuery(req, releaseObj.path),
                    releaseSlug: release,
                    releaseName: getEnv(`${ repoEnvPrefix }_RELEASE_NAME`, distro, release) ?? _.capitalize(release),
                };
                if (repoData) {
                    _.merge(data, repoData(repoObj, distro, release, data));
                }
                const distroData = renderData[data.distroName] ?? (renderData[data.distroName] = []);
                distroData.push(data);
            }
        }
    }

    for (const distroKeys of Object.keys(renderData).toSorted(collator.compare)) {
        const distroRender = [];
        const sortedReleases = renderData[distroKeys].toSorted((a, b) => collator.compare(a.releaseName, b.releaseName));
        for (const data of sortedReleases.reverse()) {
            const { templateName, templateFile } = await locateTemplate(eta, repoObj.type, data.distroSlug, data.releaseSlug);
            const rendered = await renderTemplate(eta, templateName, templateFile,
                data);
            if (rendered) {
                const refName = `${ repoObj.type }-${ safeSlug(data.distroSlug) }-${ safeSlug(data.releaseSlug) }`;
                if (distroRender.length == 0) {
                    distroRender.push(`<li>${ data.distroName }: `);
                }
                distroRender.push(
                    renderConfigRef(refName, `${ data.distroName } ${ data.releaseName } configuration`,
                        data.releaseName));
                configs.push(
                    renderConfigSection(refName, `${ data.distroName } ${ data.releaseName }`, rendered));
            }
        }
        if (distroRender.length > 0) {
            distroRender.push(`</li>`);
            navigation.push(distroRender[0], distroRender.slice(1, -1).join(", "),
                distroRender.at(-1) as string
            );
        }
    }

    return { navigation, configs };
}

type RepositoryOf<R extends Release> = Repository & { distributions: Record<string, Distribution & { releases: Record<string, R> }> };

/** The releases below /<type> that match the browsed distro and release; an empty or missing segment matches all */
function toRepository<V extends { distro: string; release: string }, R extends Release>(type: RepoType, views: V[],
    distro: string | undefined, release: string | undefined, toRelease: (distroPath: string, view: V) => R): RepositoryOf<R> {
    const repoObj: RepositoryOf<R> = { type, path: path.join("/", type), distributions: {} };
    for (const view of views) {
        if ((distro && view.distro !== distro) || (release && view.release !== release)) {
            continue;
        }
        const distroObj = repoObj.distributions[view.distro] ??= { path: path.join(repoObj.path, view.distro), releases: {} };
        distroObj.releases[view.release] = toRelease(distroObj.path, view);
    }
    return repoObj;
}

export async function renderDistroConfigs(req: Request, paths: Paths, gpg: Gpg, eta: Eta, directory: string) {
    const navigation: string[] = [];
    const configs: string[] = [];
    const tree = getBackend(paths.repoStateDir).repositoryTree();
    // The file system serves any spelling, the rows hold one
    const browsed = repoDirectoryName(directory);

    if (browsed === "/" || browsed.startsWith("/deb/")) {
        const [, , pathDistro, , pathRelease] = browsed.split("/");
        const repoObj = toRepository("deb", tree.deb, pathDistro, pathRelease, (distroPath, view) => ({
            path: path.join(distroPath, "dists", view.release),
            components: view.components,
            architectures: view.architectures,
        }));
        const { navigation: repoNavigation, configs: repoConfigs } = await renderDistroConfig(req, eta, paths.repoDir, gpg,
            repoObj, (repoObj, distro, release, data) => {
                return {
                    releaseComponents: repoObj.distributions[distro].releases[release].components,
                    releaseArchitectures: repoObj.distributions[distro].releases[release].architectures,
                    sourcesListDir: getEnv("DEB_SOURCES_LIST_DIR", distro, release) ?? "/etc/apt/sources.list.d",
                    gpgKeyDir: data.gpgUri ?
                        (getEnv(`DEB_GPG_KEY_DIR`, distro, release) || "/etc/apt/trusted.gpg.d") :
                        undefined,
                    gpgKeyFile: data.gpgUri ?
                        (getEnv(`DEB_GPG_KEY_FILE`, distro, release) || `${ data.repoSlug }.gpg`) :
                        undefined,
                };
            });
        navigation.push(...repoNavigation);
        configs.push(...repoConfigs);
    }

    if (browsed === "/" || browsed.startsWith("/rpm/")) {
        const [, , pathDistro, pathRelease] = browsed.split("/");
        const repoObj = toRepository("rpm", tree.rpm, pathDistro, pathRelease, (distroPath, view) => ({
            path: path.join(distroPath, view.release),
        }));
        const { navigation: repoNavigation, configs: repoConfigs } = await renderDistroConfig(req, eta, paths.repoDir, gpg,
            repoObj, (repoObj, distro, release, data) => {
                return {
                    reposDir: getEnv("RPM_REPOS_DIR", distro, release) ?? "/etc/yum.repos.d",
                    gpgKeyDir: data.gpgUri ?
                        (getEnv(`RPM_GPG_KEY_DIR`, distro, release) || "/etc/pki/rpm-gpg") :
                        undefined,
                    gpgKeyFile: data.gpgUri ?
                        (getEnv(`RPM_GPG_KEY_FILE`, distro, release) || `RPM-GPG-KEY-${ data.repoDashSlug }`) :
                        undefined,
                };
            });
        navigation.push(...repoNavigation);
        configs.push(...repoConfigs);
    }

    const COPY_BUTTON_SCRIPT = dedent`
        <script>
            document.querySelectorAll("pre").forEach(pre => {
                if (pre.parentNode.classList.contains("copy-btn")) return;
                const wrap = document.createElement("div");
                wrap.className = "copy-btn";
                pre.parentNode.insertBefore(wrap, pre);
                pre.parentNode.removeChild(pre);
                wrap.appendChild(pre);

                const btn = document.createElement("button");
                btn.className = "icon icon-copy";
                btn.addEventListener("click", async () => {
                    const code = pre.innerText;
                    let btnClass = "copy-success";
                    try {
                        await navigator.clipboard.writeText(code);
                    } catch (err) {
                        console.error("Copy failed:", err);
                        btnClass = "copy-fail";
                    }
                    btn.classList.add(btnClass);
                    setTimeout(() => btn.classList.remove(btnClass), 400);
                });
                wrap.appendChild(btn);
            });
        </script>
    `;

    const render = [];
    if (configs.length === 1) {
        render.push(`<h2><span class="icon icon-settings"></span><span>Configuration</span></h2>`);
        render.push(configs[0]);
        render.push(COPY_BUTTON_SCRIPT);
    } else if (configs.length > 1) {
        render.push(dedent`
            <h2><span class="icon icon-settings"></span><span>Configuration${ navigation.length > 1 ? "s" : "" }</span></h2>
            <div>Select a distribution and release to view its configuration:</div>
            <ul>`);
        render.push(...navigation);
        render.push(`</ul>`);
        render.push(...configs.map(c => c.replace("<section", "<section hidden")));
        render.push(COPY_BUTTON_SCRIPT);
        render.push(dedent`
            <script type="text/javascript">
            (() => {
                const HASH_PREFIX = "cfg:";
                const revealed = { visible: null };
                function getKeyFromHash() {
                    const h = decodeURIComponent(location.hash.slice(1));
                    return h.startsWith(HASH_PREFIX) ? h.slice(HASH_PREFIX.length) : null;
                }
                function reveal(key) {
                    const el = document.getElementById(key);
                    if (revealed.visible !== el) {
                        if (revealed.visible) {
                            revealed.visible.hidden = true;
                        }
                        if (el) {
                            el.hidden = false;
                        }
                        revealed.visible = el;
                    }
                }
                const initialKey = getKeyFromHash();
                if (initialKey) reveal(initialKey);
                window.addEventListener("hashchange", () => {
                    const key = getKeyFromHash();
                    reveal(key);
                })
            })();
            </script>`);
    }
    return render.join("\n");
}

export async function initEta(templateDir: string | undefined, environment: Environment) {
    const eta = new Eta({
        debug: true,
        cache: true,
        useWith: true,
        varName: "data",
        escapeFunction: escapeHtml.bind(null) as (str: unknown) => string,
        autoTrim: false,
        tags: ["<%", "%>"],
        defaultExtension: ".eta.html",
        views: templateDir,
    });

    // Check if we need default templates
    for (const template of ["deb", "rpm"]) {
        const templateContent = await fs.readFile(
            osPath.join(getTemplateDir(environment), `${ template }.eta.html`), 'utf8');
        const compiledTemplate = eta.compile(templateContent);
        eta.loadTemplate(`@default-${ template }`, compiledTemplate);
    }

    return eta;
}
