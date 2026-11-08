import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { migrations } from "./migrations.js";

export type DB = DatabaseSync;
export type Row = Record<string, SQLInputValue>;

const statementCache = new WeakMap<DB, Map<string, StatementSync>>();
const txDepth = new WeakMap<DB, number>();

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < migrations.length; v++) {
    tx(db, () => {
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Prepared-statement cache so hot queries are compiled once per connection. */
export function stmt(db: DB, sql: string): StatementSync {
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

export function one<T>(db: DB, sql: string, ...params: SQLInputValue[]): T | undefined {
  return stmt(db, sql).get(...params) as T | undefined;
}

export function all<T>(db: DB, sql: string, ...params: SQLInputValue[]): T[] {
  return stmt(db, sql).all(...params) as T[];
}

export function run(db: DB, sql: string, ...params: SQLInputValue[]) {
  return stmt(db, sql).run(...params);
}

/**
 * Runs `fn` inside a transaction. node:sqlite is synchronous, so `fn` must be synchronous too:
 * no awaits inside. Nested calls become savepoints, so services can compose freely.
 */
export function tx<T>(db: DB, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  const savepoint = `sp_${depth}`;
  db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    if (result instanceof Promise) {
      throw new Error("tx() callback must be synchronous");
    }
    db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}

export function nowIso() {
  return new Date().toISOString();
}
