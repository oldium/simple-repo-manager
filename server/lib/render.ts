import type { Environment, Gpg, Paths } from "./config.ts";
import { Eta } from "eta";
import escapeHtml from "escape-html";
import fsExtra from "fs-extra";
import fs from "fs/promises";
import { default as osPath } from "node:path";
import path from "node:path/posix";
import type { Distribution, Release, Repository, RepoType } from "./repo.ts";
import type { RepositoryRef } from "./repo-service.ts";
import { RepoNotFoundError } from "./errors.ts";
import { htmlToMarkdown } from "./html-markdown.ts";
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

type RepoData<T extends Repository> = (repoObj: T, distro: string, release: string, data: RenderData) => object;

async function releaseRenderData<T extends Repository>(req: Request, repoDir: string, gpg: Gpg, repoObj: T, distro: string, release: string,
    repoData: RepoData<T>): Promise<RenderData> {
    const distroObj = repoObj.distributions[distro];
    const repoEnvPrefix = repoObj.type.toUpperCase();
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
        releaseUri: getUriNoQuery(req, distroObj.releases[release].path),
        releaseSlug: release,
        releaseName: getEnv(`${ repoEnvPrefix }_RELEASE_NAME`, distro, release) ?? _.capitalize(release),
    };
    _.merge(data, repoData(repoObj, distro, release, data));
    return data;
}

async function renderRelease(eta: Eta, type: RepoType, data: RenderData) {
    const { templateName, templateFile } = await locateTemplate(eta, type, data.distroSlug, data.releaseSlug);
    return renderTemplate(eta, templateName, templateFile, data);
}

async function renderDistroConfig<T extends Repository>(req: Request, eta: Eta, repoDir: string, gpg: Gpg,
    repoObj: T, repoData: RepoData<T>) {
    const navigation: string[] = [];
    const configs: string[] = [];

    const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
    const debDistros = repoObj.distributions;
    const renderData: Record<string, RenderData[]> = {};
    if (Object.keys(repoObj.distributions).length !== 0) {
        for (const [distro, distroObj] of Object.entries(debDistros)) {
            for (const release of Object.keys(distroObj.releases)) {
                const data = await releaseRenderData(req, repoDir, gpg, repoObj, distro, release, repoData);
                const distroData = renderData[data.distroName] ?? (renderData[data.distroName] = []);
                distroData.push(data);
            }
        }
    }

    for (const distroKeys of Object.keys(renderData).toSorted(collator.compare)) {
        const distroRender = [];
        const sortedReleases = renderData[distroKeys].toSorted((a, b) => collator.compare(a.releaseName, b.releaseName));
        for (const data of sortedReleases.reverse()) {
            const rendered = await renderRelease(eta, repoObj.type, data);
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

type RepositoryTree = ReturnType<ReturnType<typeof getBackend>["repositoryTree"]>;

function debRepository(tree: RepositoryTree, distro: string | undefined, release: string | undefined) {
    return toRepository("deb", tree.deb, distro, release, (distroPath, view) => ({
        path: path.join(distroPath, "dists", view.release),
        components: view.components,
        architectures: view.architectures,
    }));
}

const debData: RepoData<ReturnType<typeof debRepository>> = (repoObj, distro, release, data) => ({
    releaseComponents: repoObj.distributions[distro].releases[release].components,
    releaseArchitectures: repoObj.distributions[distro].releases[release].architectures,
    sourcesListDir: getEnv("DEB_SOURCES_LIST_DIR", distro, release) ?? "/etc/apt/sources.list.d",
    gpgKeyDir: data.gpgUri ?
        (getEnv(`DEB_GPG_KEY_DIR`, distro, release) || "/etc/apt/trusted.gpg.d") :
        undefined,
    gpgKeyFile: data.gpgUri ?
        (getEnv(`DEB_GPG_KEY_FILE`, distro, release) || `${ data.repoSlug }.gpg`) :
        undefined,
});

function rpmRepository(tree: RepositoryTree, distro: string | undefined, release: string | undefined) {
    return toRepository("rpm", tree.rpm, distro, release, (distroPath, view) => ({
        path: path.join(distroPath, view.release),
    }));
}

const rpmData: RepoData<ReturnType<typeof rpmRepository>> = (_repoObj, distro, release, data) => ({
    reposDir: getEnv("RPM_REPOS_DIR", distro, release) ?? "/etc/yum.repos.d",
    gpgKeyDir: data.gpgUri ?
        (getEnv(`RPM_GPG_KEY_DIR`, distro, release) || "/etc/pki/rpm-gpg") :
        undefined,
    gpgKeyFile: data.gpgUri ?
        (getEnv(`RPM_GPG_KEY_FILE`, distro, release) || `RPM-GPG-KEY-${ data.repoDashSlug }`) :
        undefined,
});

/** The setup of one release as markdown, from the template its browse page shows */
export async function renderSetupInstructions(req: Request, paths: Paths, gpg: Gpg, eta: Eta, target: RepositoryRef): Promise<string> {
    const tree = getBackend(paths.repoStateDir).repositoryTree();
    const distro = repoDirectoryName(target.distribution);
    const release = repoDirectoryName(target.release);
    if (!tree[target.format].some(view => view.distro === distro && view.release === release)) {
        throw new RepoNotFoundError(`No such repository ${ target.format }/${ target.distribution }/${ target.release }`);
    }
    const data = target.format === "deb"
        ? await releaseRenderData(req, paths.repoDir, gpg, debRepository(tree, distro, release), distro, release, debData)
        : await releaseRenderData(req, paths.repoDir, gpg, rpmRepository(tree, distro, release), distro, release, rpmData);
    const rendered = await renderRelease(eta, target.format, data);
    if (!rendered) {
        throw new Error(`No setup of ${ target.format }/${ distro }/${ release }, the template did not render`);
    }
    return `# ${ data.distroName } ${ data.releaseName }\n\n${ htmlToMarkdown(rendered) }\n`;
}

export async function renderDistroConfigs(req: Request, paths: Paths, gpg: Gpg, eta: Eta, directory: string) {
    const navigation: string[] = [];
    const configs: string[] = [];
    const tree = getBackend(paths.repoStateDir).repositoryTree();
    // The file system serves any spelling, the rows hold one
    const browsed = repoDirectoryName(directory);

    if (browsed === "/" || browsed.startsWith("/deb/")) {
        const [, , pathDistro, , pathRelease] = browsed.split("/");
        const { navigation: repoNavigation, configs: repoConfigs } = await renderDistroConfig(req, eta, paths.repoDir, gpg,
            debRepository(tree, pathDistro, pathRelease), debData);
        navigation.push(...repoNavigation);
        configs.push(...repoConfigs);
    }

    if (browsed === "/" || browsed.startsWith("/rpm/")) {
        const [, , pathDistro, pathRelease] = browsed.split("/");
        const { navigation: repoNavigation, configs: repoConfigs } = await renderDistroConfig(req, eta, paths.repoDir, gpg,
            rpmRepository(tree, pathDistro, pathRelease), rpmData);
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
