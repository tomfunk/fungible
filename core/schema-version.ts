/**
 * Value stored in SQLite's `PRAGMA user_version` once initDb has run. Purely
 * additive: builds that predate it ignore the pragma. Snapshots record it in
 * their manifest and restore refuses a snapshot written by a newer build
 * (user_version greater than this), since this build cannot know that schema.
 * Bump when a migration makes the on-disk schema incompatible with older builds.
 */
export const SCHEMA_USER_VERSION = 1;
