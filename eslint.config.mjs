// @ts-check

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default tseslint.config(
    eslint.configs.recommended,
    tseslint.configs.recommended,
    defineConfig([globalIgnores(["dist/"])])
);
