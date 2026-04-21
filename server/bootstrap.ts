import { createRequire } from "node:module";
import logger from "./lib/logger.ts";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
const instanceLabel = process.env.INSTANCE_LABEL?.trim() || undefined;
const suffix = instanceLabel ? ` (${ instanceLabel })` : "";

logger.info(`> Starting Simple Repo Manager${ suffix } v${ pkg.version }`);
