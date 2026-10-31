// @ts-check

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

const PATH_IMPORT_NAMES = [
    {
        selector: "ImportDeclaration[source.value=/^(node:)?path$/] > :matches(ImportDefaultSpecifier, ImportSpecifier[imported.name='default'])[local.name!='osPath']",
        message: "node:path holds OS paths: import it as osPath.",
    },
    {
        selector: "ImportDeclaration[source.value=/^(node:)?path.posix$/] > :matches(ImportDefaultSpecifier, ImportSpecifier[imported.name='default'])[local.name!='path']",
        message: "node:path/posix holds URL and repo-relative paths: import it as path.",
    },
    {
        selector: "ImportDeclaration[source.value=/^(node:)?path(.posix)?$/] > :matches(ImportNamespaceSpecifier, ImportSpecifier[imported.name!='default'])",
        message: "Import the default of node:path as osPath and of node:path/posix as path, so a call shows which paths it works on.",
    },
];

export default tseslint.config(
    eslint.configs.recommended,
    tseslint.configs.recommended,
    {
        files: ["server/**/*.ts", "tests/**/*.ts", "types/**/*.ts", "*.ts", "*.mjs"],
        rules: { "no-restricted-syntax": ["error", ...PATH_IMPORT_NAMES] },
    },
    {
        files: ["server/**/*.ts"],
        ignores: ["server/lib/safe-path.ts"],
        rules: {
            "no-restricted-syntax": ["error", ...PATH_IMPORT_NAMES, {
                selector: "CallExpression[callee.object.name='osPath'][callee.property.name=/^(join|resolve)$/] > SpreadElement",
                message: "Segments of a URL or repo-relative path go through toOsPath, which checks them; walk a directory by joining one entry at a time.",
            }],
        },
    },
    defineConfig([globalIgnores(["dist/", "tmp/"])])
);
