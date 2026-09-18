/** @sfield/store-sqlite: `durable_single` persistence over the built-in `node:sqlite` module (§17.1, §17.2). */
import { SqlitePersistence, type SqlitePersistenceOptions } from "./sqlite-persistence.js";

export { SqlitePersistence, type SqlitePersistenceOptions } from "./sqlite-persistence.js";
export { SqliteMemoryRepository } from "./sqlite-memory.js";
export { SqliteDatabase } from "./db.js";
export { SCHEMA_VERSION } from "./schema.js";

/** Creates a durable_single store. Call `init({ namespace, ownerId })` before use and `close()` on shutdown. */
export function sqlitePersistence(opts: SqlitePersistenceOptions): SqlitePersistence {
  return new SqlitePersistence(opts);
}
