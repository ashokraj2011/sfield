/**
 * Schema for the durable_single store (§17.6): one table per record family holding the JSON record `body` plus the
 * indexed columns the contract's lookups need. `sfield_meta.schema_version` gates readers; migrations are explicit.
 */
import { SFieldError, nowIso } from "@sfield/core";
import type { SqliteDatabase } from "./db.js";

export const SCHEMA_VERSION = 1;

/** Explicit, idempotent migrations keyed by the version they upgrade from (§17.6). None exist for version 1. */
const MIGRATIONS: Partial<Record<number, (db: SqliteDatabase) => void>> = {};

export const DDL = `
CREATE TABLE IF NOT EXISTS owners (
  namespace    TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  pid          INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id          TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  conversation_id TEXT,
  scope_id        TEXT NOT NULL,
  state           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  wakeup_at       TEXT,
  body            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_tenant_created ON runs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id);
CREATE INDEX IF NOT EXISTS runs_state ON runs(state);
CREATE INDEX IF NOT EXISTS runs_wakeup ON runs(wakeup_at) WHERE wakeup_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS idempotency (
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  digest     TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS conversations (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  body      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  conversation_id TEXT NOT NULL,
  idx             INTEGER NOT NULL,
  id              TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  body            TEXT NOT NULL,
  PRIMARY KEY (conversation_id, idx)
);
CREATE INDEX IF NOT EXISTS messages_id ON messages(id);

CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  run_id  TEXT NOT NULL REFERENCES runs(run_id),
  state   TEXT NOT NULL,
  body    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_run ON calls(run_id);

CREATE TABLE IF NOT EXISTS approvals (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id    TEXT NOT NULL,
  status    TEXT NOT NULL,
  body      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_run ON approvals(run_id);
CREATE INDEX IF NOT EXISTS approvals_tenant_status ON approvals(tenant_id, status);

CREATE TABLE IF NOT EXISTS input_requests (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id    TEXT NOT NULL,
  status    TEXT NOT NULL,
  body      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS input_requests_run ON input_requests(run_id);
CREATE INDEX IF NOT EXISTS input_requests_tenant_status ON input_requests(tenant_id, status);

CREATE TABLE IF NOT EXISTS checkpoints (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
  body   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  seq    INTEGER NOT NULL,
  body   TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS audit (
  ord       INTEGER PRIMARY KEY AUTOINCREMENT,
  id        TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  run_id    TEXT,
  type      TEXT NOT NULL,
  body      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_tenant ON audit(tenant_id, ord);
CREATE INDEX IF NOT EXISTS audit_run ON audit(run_id, ord);
CREATE INDEX IF NOT EXISTS audit_type ON audit(type, ord);

CREATE TABLE IF NOT EXISTS reservations (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL,
  state              TEXT NOT NULL,
  estimate_micro_usd REAL NOT NULL,
  actual_micro_usd   REAL,
  body               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reservations_run ON reservations(run_id);

CREATE TABLE IF NOT EXISTS reservation_scopes (
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  scope_key      TEXT NOT NULL,
  PRIMARY KEY (reservation_id, scope_key)
);
CREATE INDEX IF NOT EXISTS reservation_scopes_key ON reservation_scopes(scope_key);

CREATE TABLE IF NOT EXISTS model_attempts (
  ord        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  body       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS model_attempts_run ON model_attempts(run_id, ord);

CREATE TABLE IF NOT EXISTS context_explanations (
  context_id TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  body       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ownership (
  scope_id   TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  epoch      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scope_epochs (
  scope_id TEXT PRIMARY KEY,
  epoch    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lock_approvals (
  digest     TEXT PRIMARY KEY,
  suite      TEXT,
  decided_at TEXT NOT NULL,
  body       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lock_approvals_suite ON lock_approvals(suite, decided_at);

CREATE TABLE IF NOT EXISTS eval_reports (
  id               TEXT PRIMARY KEY,
  suite            TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  body             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS eval_reports_suite ON eval_reports(suite);
CREATE INDEX IF NOT EXISTS eval_reports_candidate ON eval_reports(candidate_digest);

CREATE TABLE IF NOT EXISTS memory_items (
  tenant_id      TEXT NOT NULL,
  id             TEXT NOT NULL,
  scope_key      TEXT NOT NULL,
  kind           TEXT NOT NULL,
  status         TEXT NOT NULL,
  structured_key TEXT,
  expires_at     TEXT NOT NULL,
  valid_until    TEXT,
  updated_at     TEXT NOT NULL,
  body           TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS memory_items_scope ON memory_items(tenant_id, scope_key, kind, status);

CREATE TABLE IF NOT EXISTS memory_idempotency (
  tenant_id TEXT NOT NULL,
  key       TEXT NOT NULL,
  item_id   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS memory_deletes (
  tenant_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  generation INTEGER NOT NULL,
  count      INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS memory_generations (
  scope_key  TEXT PRIMARY KEY,
  generation INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_outbox (
  ord  INTEGER PRIMARY KEY AUTOINCREMENT,
  id   TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL
);
`;

/** Creates the schema on first use, applies explicit migrations, and refuses databases written by a newer version (§17.6). */
export function ensureSchema(db: SqliteDatabase): void {
  db.tx(() => {
    db.exec("CREATE TABLE IF NOT EXISTS sfield_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const row = db.one<{ value: string }>("SELECT value FROM sfield_meta WHERE key = 'schema_version'");
    if (!row) {
      db.exec(DDL);
      db.run("INSERT INTO sfield_meta (key, value) VALUES ('schema_version', ?), ('created_at', ?)", String(SCHEMA_VERSION), nowIso());
      return;
    }
    const stored = Number(row.value);
    if (!Number.isInteger(stored) || stored > SCHEMA_VERSION) {
      throw new SFieldError("UNSUPPORTED_DEPLOYMENT", `database ${db.label} has schema version ${row.value}; this build supports up to ${SCHEMA_VERSION}`, {
        suggestion: "Upgrade @sfield/store-sqlite, or point the store at a database written by a compatible version",
      });
    }
    for (let version = stored; version < SCHEMA_VERSION; version++) {
      const migrate = MIGRATIONS[version];
      if (!migrate) {
        throw new SFieldError("UNSUPPORTED_DEPLOYMENT", `database ${db.label} has schema version ${version} and no migration to ${version + 1} exists`, {
          suggestion: "Recreate the database or migrate it with a build that supports this version",
        });
      }
      migrate(db);
      db.run("UPDATE sfield_meta SET value = ? WHERE key = 'schema_version'", String(version + 1));
    }
    // Idempotent: on a current schema every statement is a no-op.
    db.exec(DDL);
  });
}
