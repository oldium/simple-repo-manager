// noinspection SpellCheckingInspection

import type { File, Locals } from "serve-index";
import serveIndex from "serve-index";
import path from "node:path/posix";
import { default as osPath } from "node:path";
import escapeHtml from "escape-html";
import type { Environment, Gpg, Paths } from "../lib/config.ts";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import express from "express";
import { fileURLToPath } from "node:url";
import * as util from "node:util";
import prettyBytes from "pretty-bytes";
import type { TransformFn } from "../lib/transform.ts";
import { serveMiddleware, transformMiddleware } from "../lib/transform.ts";
import fs from "fs/promises";
import serveStatic from "serve-static";
import parseurl from "parseurl";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Eta } from "eta";
import { initEta, renderDistroConfigs } from "../lib/render.ts";

function filterHidden(): RequestHandler {
    return (req: Request, _res: Response, next: NextFunction) => {
        const parsed = parseurl(req);
        if (!parsed || !parsed.pathname) {
            return next('router');
        }
        const dir = path.normalize(decodeURIComponent(parsed.pathname));
        if (!dir.startsWith('/.well-known/') && (dir.includes("/.") || dir.startsWith("."))) {
            return next('router');
        }
        next();
    }
}

async function transformCss(cssFile: string, environment: Environment): Promise<TransformFn> {
    if (environment === "development") {
        const { default: postcss } = await import("postcss");
        const { default: trailwidcss } = await import("@tailwindcss/postcss");
        const tailwindCss = postcss([trailwidcss]);
        return async (cssContent: string) => {
            const result = (await tailwindCss.process(cssContent, { from: cssFile, to: cssFile }));
            return result.css;
        }
    } else {
        return (cssContent) => cssContent;
    }
}

function renderDirEntry(file: File) {
    const classes = [];
    const isDirectory = file.stat?.isDirectory();
    if (isDirectory) {
        classes.push("icon-directory");
        if (file.name === '..') {
            classes.push("icon-up");
        }
    } else {
        classes.push("icon-file");
        const extension = path.extname(file.name).slice(1);
        if (extension) {
            classes.push(`icon-ext-${ extension }`);
        }
    }

    const size = file.stat && !file.stat.isDirectory()
        ? prettyBytes(file.stat.size, { binary: true })
        : undefined;
    const mtime = file.stat?.mtime;
    const date = file.stat && file.name !== '..'
        ? mtime.toISOString().slice(0, 19).replace('T', ' ')
        : undefined;

    return (`      <li><a href="${ escapeHtml(
            path.normalize(file.name) + (isDirectory ? "/" : "")) }" title="${ file.name }">` +
        `<span class="icon ${ classes.join(" ") }"></span>` +
        `<span class="name">${ escapeHtml(file.name) }</span>` +
        (size !== undefined ? `<span class="size">${ escapeHtml(size) }</span>` : '') +
        (date !== undefined ? `<span class="date">${ escapeHtml(date) }</span>` : '') +
        '</a></li>'
    );
}

function renderBreadcrumb(locals: Locals): string {
    const dirs = locals.directory.split("/").slice(1, -1)
    return dirs.reduce<{ herePath: string, result: string[] }>(
        ({ herePath, result }, part) => {
            result.push(
                `<a href="${ escapeHtml(
                    path.join(herePath, part) + "/") }" title="Home" class="name-directory">${ escapeHtml(
                    part) }</a>`);
            return { herePath: path.join(herePath, part), result };
        }, { herePath: "/", result: [""] })
        .result
        .join('<span class="separator">/</span>');
}

function htmlTemplate(repoDir: string, eta: Eta, gpg: Gpg, cssFilePath: string, iconNames: string[]) {
    return async (locals: Locals): Promise<string> => {
        const files: string[] = [];
        const req = getRequest()!;

        locals.fileList.map(renderDirEntry.bind(null)).filter(Boolean).forEach((f) => files.push(f));
        const pathBreadcrumb = renderBreadcrumb(locals);
        const configs = await renderDistroConfigs(req, eta, repoDir, gpg, locals.directory);

        return `\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset='utf-8'>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="${ cssFilePath }">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=swap">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..24,400,0,-25..0&icon_names=${ escapeHtml(
            iconNames.join(",")) }&display=block'">
  <title>Listing ${ locals.directory === "/" ? "repositories" : escapeHtml(locals.directory.slice(0, -1)) }</title>
</head>
<body class="directory">
  <div class="content">
    <h1 class="breadcrumb"><a href="/" class="name-directory icon icon-home"></a>${ pathBreadcrumb }</h1>
    <ul class="view view-list">${ files.length > 0 ? `\n${ files.join("\n") }` : "" }
    </ul>
  </div>${ configs.length > 0 ? `
  <div class="config">
    ${ configs }
  </div>` : "" }
</body>
</html>
`;
    }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function enforceContentType(res: Response, filePath: string, _stat: unknown) {
    if (["Release", "Packages"].includes(osPath.basename(filePath))) {
        res.setHeader("Content-Type", "text/plain");
    }
}

function getPublicDir(environment: Environment) {
    switch (environment) {
        case "production":
            return osPath.join(osPath.dirname(fileURLToPath(import.meta.url)), "..", "public");
        default:
            return osPath.join(osPath.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
    }
}

type RequestLocalStorage = {
    req: Request
};
const asyncLocalStorage = new AsyncLocalStorage<RequestLocalStorage>();

function getRequest() {
    return asyncLocalStorage.getStore()?.req;
}

async function serveHtmlTemplateIndex(repoDir: string, templateDir: string | undefined, gpg: Gpg,
    environment: Environment, cssFileUrl: string, iconNames: string[]): Promise<RequestHandler> {
    const eta = await initEta(templateDir, environment);

    const serve = serveIndex(repoDir, {
        icons: false,
        template: util.callbackify(htmlTemplate(repoDir, eta, gpg, cssFileUrl, iconNames))
    });
    return (req: Request, res: Response, next: NextFunction) => {
        asyncLocalStorage.run<void>({ req }, () => serve(req, res, next));
    }
}

export default async function files(paths: Paths, gpg: Gpg, environment: Environment) {
    const publicDir = getPublicDir(environment);
    const cssFilePath = osPath.join(publicDir, "style.css");
    const faviconFilePath = osPath.join(publicDir, "favicon.svg");

    const cssFileUrl = "/style.css";
    const cssFileContent = await fs.readFile(cssFilePath, 'utf8');
    const contentRegex = /\.icon-[^:\s]+::?before\s*{\s*content:\s*"([^"]+)"/g;
    const iconNames = Array.from(cssFileContent.matchAll(contentRegex), m => m[1]).sort();
    const cssTransform = await transformCss(cssFilePath, environment);

    const router = express.Router({ strict: true });
    router.get(cssFileUrl, transformMiddleware(cssFilePath, cssTransform, environment));
    router.get("/favicon.svg", serveMiddleware(faviconFilePath, environment));
    router.use(filterHidden());
    router.use(serveStatic(paths.repoDir, { index: false, setHeaders: enforceContentType }),
        await serveHtmlTemplateIndex(paths.repoDir, paths.templateDir, gpg, environment, cssFileUrl, iconNames)
    );
    return router;
}
