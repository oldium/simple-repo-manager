import type { DatabaseSync, StatementSync } from "node:sqlite";

// Node 26 exports Database/Statement as the stable names, @types/node still declares only the *Sync ones
declare module "node:sqlite" {
    export const Database: typeof DatabaseSync;
    export type Database = DatabaseSync;
    export const Statement: typeof StatementSync;
    export type Statement = StatementSync;
}
