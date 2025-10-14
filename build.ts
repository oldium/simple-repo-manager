import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import osPath from "path";
import fsExtra from "fs-extra";
import { glob } from "glob";

process.env.NODE_ENV = "production";

const distDir = osPath.join(osPath.dirname(fileURLToPath(import.meta.url)), "dist");
const templatesDir = osPath.join(osPath.dirname(fileURLToPath(import.meta.url)), "templates");
const publicDir = osPath.join(osPath.dirname(fileURLToPath(import.meta.url)), "public");
const distPublicDir = osPath.join(distDir, "public");
const distTemplatesDir = osPath.join(distDir, "templates");

const { default: postcss } = await import("postcss");
const { default: trailwidcss } = await import("@tailwindcss/postcss");
const tailwindCss = postcss([trailwidcss]);

for (const file of await glob("**/*", { cwd: publicDir, nodir: true })) {
    const sourceFile = osPath.join(publicDir, file);
    const targetFile = osPath.join(distPublicDir, file);
    await fsExtra.ensureDir(osPath.join(osPath.dirname(targetFile)));
    if (osPath.extname(file) === ".css") {
        const cssContent = await fs.readFile(sourceFile, 'utf8');
        const result = (await tailwindCss.process(cssContent, { from: sourceFile, to: targetFile }));
        await fs.writeFile(targetFile, result.css, 'utf8');
    } else {
        await fs.copyFile(sourceFile, targetFile);
    }
}

for (const file of await glob("**/*", { cwd: templatesDir, nodir: true })) {
    const sourceFile = osPath.join(templatesDir, file);
    const targetFile = osPath.join(distTemplatesDir, file);
    await fsExtra.ensureDir(osPath.join(osPath.dirname(targetFile)));
    await fs.copyFile(sourceFile, targetFile);
}
