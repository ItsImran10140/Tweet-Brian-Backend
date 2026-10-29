/**
 * Compatibility re-export. Prefer importing from `../data` for new code.
 * JSON file persistence has been replaced by Supabase (see src/data/).
 * The old data/db.json file is left on disk as a backup and is no longer written.
 */
export { db, type Row, type Table, USER_TABLES, SHARED_TABLES, TABLES } from '../data';
