import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import osPath from "path";

process.env.NODE_ENV = "production";

const rootDir = osPath.dirname(fileURLToPath(import.meta.url));
const distDir = osPath.join(rootDir, "dist");
const sourceFile = osPath.join(rootDir, "styles", "style.css");
const targetFile = osPath.join(distDir, "style.css");

const { default: postcss } = await import("postcss");
const { default: tailwindCss } = await import("@tailwindcss/postcss");

const result = await postcss([tailwindCss]).process(await fs.readFile(sourceFile, "utf8"), { from: sourceFile, to: targetFile });
// Holds only what this build writes
await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(distDir, { recursive: true });
await fs.writeFile(targetFile, result.css, "utf8");
