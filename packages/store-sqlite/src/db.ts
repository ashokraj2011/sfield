/**
 * Connection handle over `node:sqlite` for the durable_single store (§17.1): open/close, a prepared-statement cache,
 * and atomic transactions (§17.2 "required atomic behavior"). Every public store method runs synchronously inside one
 * `tx()` call, so two operations can never interleave on the connection.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { SFieldError } from "@sfield/core";

export type SqlParam = SQLInputValue | undefined;

/** Wait this long for a write lock held by another connection (a second process on the same file) before failing. */
const BUSY_TIMEOUT_MS = 5000;

export class SqliteDatabase {
  readonly path: string;
  private conn: DatabaseSync | null = null;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string) {
    this.path = path;
  }

  get isOpen(): boolean {
    return this.conn !== null;
  }

  get label(): string {
    return this.path === ":memory:" ? "(in-memory)" : this.path;
  }

  /** Opens the database (creating parent directories) with WAL journaling, foreign keys, and a busy timeout. Idempotent. */
  open(): void {
    if (this.conn) return;
    if (this.path !== ":memory:") mkdirSync(dirname(resolve(this.path)), { recursive: true });
    const conn = new DatabaseSync(this.path, { enableForeignKeyConstraints: true });
    conn.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    conn.exec("PRAGMA journal_mode = WAL");
    conn.exec("PRAGMA foreign_keys = ON");
    this.conn = conn;
    this.depth = 0;
  }

  close(): void {
    const conn = this.conn;
    this.conn = null;
    this.statements.clear();
    this.depth = 0;
    conn?.close();
  }

  connection(): DatabaseSync {
    if (!this.conn) {
      throw new SFieldError("STATE_UNAVAILABLE", `sqlite store ${this.label} is not open`, { suggestion: "Call init() before using the store (and again after close())" });
    }
    return this.conn;
  }

  exec(sql: string): void {
    this.connection().exec(sql);
  }

  run(sql: string, ...params: SqlParam[]): { changes: number } {
    const result = this.stmt(sql).run(...bind(params));
    return { changes: Number(result.changes) };
  }

  one<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.stmt(sql).get(...bind(params)) as unknown as T | undefined;
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.stmt(sql).all(...bind(params)) as unknown as T[];
  }

  /** Runs `fn` atomically: `BEGIN IMMEDIATE … COMMIT` at the outermost level, a SAVEPOINT when nested; any throw rolls back. */
  tx<T>(fn: () => T): T {
    const conn = this.connection();
    const depth = this.depth;
    conn.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT sp${depth}`);
    this.depth = depth + 1;
    try {
      const out = fn();
      conn.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT sp${depth}`);
      return out;
    } catch (err) {
      try {
        conn.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT sp${depth}; RELEASE SAVEPOINT sp${depth}`);
      } catch {
        // The connection is already unusable; surface the original error.
      }
      throw err;
    } finally {
      this.depth = depth;
    }
  }

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.connection().prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
}

function bind(params: SqlParam[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : p));
}
