import { Database } from "node:sqlite";
import dedent from "dedent";

export const SCHEMA_VERSION = 1;

const SCHEMA_V1 = dedent`
    CREATE TABLE releases (id INTEGER PRIMARY KEY, format TEXT NOT NULL, distro TEXT NOT NULL, name TEXT NOT NULL,
        published_date INTEGER, origin TEXT, description TEXT, UNIQUE (format, distro, name));
    CREATE TABLE pool_files (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, size INTEGER NOT NULL,
        md5 TEXT NOT NULL, sha1 TEXT NOT NULL, sha256 TEXT NOT NULL, sha512 TEXT NOT NULL, removed_at INTEGER);
    CREATE INDEX pool_files_removed ON pool_files (removed_at) WHERE removed_at IS NOT NULL;
    CREATE TABLE deb_sources (id INTEGER PRIMARY KEY, release_id INTEGER NOT NULL REFERENCES releases (id),
        component TEXT NOT NULL, source TEXT NOT NULL, version TEXT NOT NULL, sort_key TEXT NOT NULL, stanza TEXT NOT NULL,
        UNIQUE (release_id, source, version));
    CREATE INDEX deb_sources_order ON deb_sources (release_id, component, sort_key);
    CREATE TABLE deb_source_files (source_id INTEGER NOT NULL REFERENCES deb_sources (id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES pool_files (id), PRIMARY KEY (source_id, file_id)) WITHOUT ROWID;
    CREATE INDEX deb_source_files_file ON deb_source_files (file_id);
    CREATE TABLE deb_binaries (id INTEGER PRIMARY KEY, release_id INTEGER NOT NULL REFERENCES releases (id),
        component TEXT NOT NULL, kind TEXT NOT NULL, package TEXT NOT NULL, version TEXT NOT NULL,
        architecture TEXT NOT NULL, source TEXT NOT NULL, source_version TEXT NOT NULL, section TEXT NOT NULL,
        sort_key TEXT NOT NULL, file_id INTEGER NOT NULL REFERENCES pool_files (id), stanza TEXT NOT NULL,
        UNIQUE (release_id, kind, package, version, architecture));
    CREATE INDEX deb_binaries_order ON deb_binaries (release_id, component, kind, sort_key);
    CREATE INDEX deb_binaries_source ON deb_binaries (release_id, source, source_version);
    CREATE INDEX deb_binaries_file ON deb_binaries (file_id);
    CREATE TABLE deb_binary_paths (release_id INTEGER NOT NULL REFERENCES releases (id), component TEXT NOT NULL, path TEXT NOT NULL,
        binary_id INTEGER NOT NULL REFERENCES deb_binaries (id) ON DELETE CASCADE,
        PRIMARY KEY (release_id, component, path, binary_id)) WITHOUT ROWID;
    CREATE INDEX deb_binary_paths_binary ON deb_binary_paths (binary_id);
    CREATE TABLE deb_uploads (id INTEGER PRIMARY KEY, release_id INTEGER NOT NULL REFERENCES releases (id),
        source TEXT NOT NULL, version TEXT NOT NULL, changes_name TEXT NOT NULL, architectures TEXT NOT NULL,
        UNIQUE (release_id, changes_name));
    CREATE INDEX deb_uploads_source ON deb_uploads (release_id, source, version);
    CREATE TABLE deb_upload_files (upload_id INTEGER NOT NULL REFERENCES deb_uploads (id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES pool_files (id), PRIMARY KEY (upload_id, file_id)) WITHOUT ROWID;
    CREATE INDEX deb_upload_files_file ON deb_upload_files (file_id);
    CREATE TABLE rpm_packages (id INTEGER PRIMARY KEY, release_id INTEGER NOT NULL REFERENCES releases (id),
        filename TEXT NOT NULL, name TEXT NOT NULL, epoch INTEGER NOT NULL, version TEXT NOT NULL, rel TEXT NOT NULL,
        arch TEXT NOT NULL, source_name TEXT NOT NULL, source_version TEXT NOT NULL, sort_key TEXT NOT NULL,
        file_id INTEGER NOT NULL REFERENCES pool_files (id), primary_xml TEXT NOT NULL, filelists_xml TEXT NOT NULL,
        other_xml TEXT NOT NULL, UNIQUE (release_id, filename));
    CREATE INDEX rpm_packages_order ON rpm_packages (release_id, sort_key);
    CREATE INDEX rpm_packages_source ON rpm_packages (release_id, source_name, source_version);
    CREATE INDEX rpm_packages_file ON rpm_packages (file_id);
    CREATE TABLE index_files (id INTEGER PRIMARY KEY, release_id INTEGER NOT NULL REFERENCES releases (id),
        kind TEXT NOT NULL, component TEXT NOT NULL DEFAULT '', architecture TEXT NOT NULL DEFAULT '',
        generation INTEGER NOT NULL DEFAULT 0, stored_path TEXT, size INTEGER, md5 TEXT, sha256 TEXT,
        raw_size INTEGER, raw_md5 TEXT, raw_sha256 TEXT, UNIQUE (release_id, kind, component, architecture));
    CREATE TABLE index_chunks (index_file_id INTEGER NOT NULL REFERENCES index_files (id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, start_key TEXT NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL,
        raw_offset INTEGER NOT NULL, raw_length INTEGER NOT NULL, PRIMARY KEY (index_file_id, seq)) WITHOUT ROWID;
    CREATE TABLE dirty_keys (index_file_id INTEGER NOT NULL REFERENCES index_files (id) ON DELETE CASCADE,
        key TEXT NOT NULL, PRIMARY KEY (index_file_id, key)) WITHOUT ROWID;
    CREATE TABLE superseded_files (path TEXT PRIMARY KEY, superseded_at INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE staged_digests (rel_path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
        md5 TEXT NOT NULL, sha1 TEXT NOT NULL, sha256 TEXT NOT NULL, sha512 TEXT NOT NULL) WITHOUT ROWID;
    PRAGMA user_version = 1;
`;

/** Opens the repository database, creating or upgrading its schema */
export function openDatabase(file: string): Database {
    const db = new Database(file);
    try {
        const { user_version: userVersion } = db.prepare("PRAGMA user_version").get() as { user_version: number };
        if (userVersion > SCHEMA_VERSION) {
            throw new Error(`Database ${ file } has schema version ${ userVersion }, newer than supported ${
                SCHEMA_VERSION }`);
        }
        if (userVersion === 0) {
            // Only honoured before the first page is written
            db.exec("PRAGMA page_size = 16384");
        }
        db.exec("PRAGMA journal_mode = WAL");
        // WAL's NORMAL can lose the last commits at a power loss, and a commit is what the published files are built on
        db.exec("PRAGMA synchronous = FULL");
        db.exec("PRAGMA foreign_keys = ON");
        db.exec("PRAGMA busy_timeout = 5000");
        if (userVersion === 0) {
            transaction(db, () => db.exec(SCHEMA_V1));
        }
        return db;
    } catch (err) {
        db.close();
        throw err;
    }
}

// A transaction must not span an await, so async callbacks fail to compile
type Sync<T> = T extends PromiseLike<unknown> ? never : T;

/** Runs fn inside BEGIN IMMEDIATE; commits its result or rolls back on throw */
export function transaction<T>(db: Database, fn: () => Sync<T>): T {
    db.exec("BEGIN IMMEDIATE");
    try {
        const result = fn();
        db.exec("COMMIT");
        return result;
    } catch (err) {
        db.exec("ROLLBACK");
        throw err;
    }
}
