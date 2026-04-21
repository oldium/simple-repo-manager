import { createRequire } from "node:module";
import logger from "./lib/logger.ts";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

logger.info(`> Starting Simple Repo Manager v${ pkg.version }`);
