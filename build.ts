import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import osPath from "path";
import fsExtra from "fs-extra";
import { glob } from "glob";

process.env.NODE_ENV = "production";

const sourceDir = osPath.join(osPath.dirname(fileURLToPath(import.meta.url)), "public");
const targetDir = osPath.join(osPath.dirname(fileURLToPath(import.meta.url)), "dist", "public");

const { default: postcss } = await import("postcss");
const { default: trailwidcss } = await import("@tailwindcss/postcss");
const tailwindCss = postcss([trailwidcss]);

for (const file of await glob("**/*", { cwd: sourceDir, nodir: true })) {
    const sourceFile = osPath.join(sourceDir, file);
    const targetFile = osPath.join(targetDir, file);
    await fsExtra.ensureDir(osPath.join(osPath.dirname(targetFile)));
    if (osPath.extname(file) === ".css") {
        const cssContent = await fs.readFile(sourceFile, 'utf8');
        const result = (await tailwindCss.process(cssContent, { from: sourceFile, to: targetFile }));
        await fs.writeFile(targetFile, result.css, 'utf8');
    } else {
        await fs.copyFile(sourceFile, targetFile);
    }
}
