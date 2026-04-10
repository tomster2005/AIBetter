import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createRequire } from "module";

export type SharedBetRecord = {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

type BetsStoreOptions = {
  projectRoot: string;
  legacyJsonPath: string;
  dbPath?: string;
};

type BetsStoreBackend = {
  list(): SharedBetRecord[];
  upsert(record: SharedBetRecord): SharedBetRecord;
  patch(id: string, patch: Record<string, unknown>): SharedBetRecord | null;
  deleteById(id: string): boolean;
  deleteAll(): number;
  getById(id: string): SharedBetRecord | null;
  count(): number;
};

class SqliteBetsStore implements BetsStoreBackend {
  private db: any;
  private legacyJsonPath: string;

  constructor(opts: BetsStoreOptions) {
    const dbPath = opts.dbPath || process.env.BETS_DB_PATH || join(opts.projectRoot, "server", "data", "bets.sqlite");
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.legacyJsonPath = opts.legacyJsonPath;
    this.initSchema();
    this.migrateFromLegacyJsonIfNeeded();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shared_bets (
        id TEXT PRIMARY KEY,
        created_at TEXT,
        updated_at TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shared_bets_created_at ON shared_bets(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_shared_bets_updated_at ON shared_bets(updated_at DESC);
    `);
  }

  private migrateFromLegacyJsonIfNeeded(): void {
    if (!existsSync(this.legacyJsonPath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.legacyJsonPath, "utf-8"));
    } catch {
      return;
    }
    const rows = Array.isArray(parsed) ? parsed : [];
    if (rows.length === 0) return;

    const upsert = this.db.prepare(`
      INSERT INTO shared_bets (id, created_at, updated_at, payload_json)
      VALUES (@id, @created_at, @updated_at, @payload_json)
      ON CONFLICT(id) DO UPDATE SET
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `);
    const tx = this.db.transaction((records: SharedBetRecord[]) => {
      for (const r of records) {
        if (!r || typeof r !== "object" || typeof r.id !== "string" || r.id.trim() === "") continue;
        upsert.run({
          id: r.id,
          created_at: typeof r.createdAt === "string" ? r.createdAt : null,
          updated_at: typeof r.updatedAt === "string" ? r.updatedAt : null,
          payload_json: JSON.stringify(r),
        });
      }
    });
    tx(rows as SharedBetRecord[]);
    const count = this.count();
    console.log("[api/bets migration] legacy bets.json imported/upserted", { legacyCount: rows.length, dbCount: count });
  }

  list(): SharedBetRecord[] {
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM shared_bets
         ORDER BY datetime(COALESCE(created_at, updated_at)) DESC, id DESC`
      )
      .all() as Array<{ payload_json: string }>;
    const out: SharedBetRecord[] = [];
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.payload_json) as unknown;
        if (parsed && typeof parsed === "object" && typeof (parsed as any).id === "string") {
          out.push(parsed as SharedBetRecord);
        }
      } catch {
        // skip malformed row
      }
    }
    return out;
  }

  upsert(record: SharedBetRecord): SharedBetRecord {
    this.db
      .prepare(
        `INSERT INTO shared_bets (id, created_at, updated_at, payload_json)
         VALUES (@id, @created_at, @updated_at, @payload_json)
         ON CONFLICT(id) DO UPDATE SET
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           payload_json = excluded.payload_json`
      )
      .run({
        id: record.id,
        created_at: typeof record.createdAt === "string" ? record.createdAt : null,
        updated_at: typeof record.updatedAt === "string" ? record.updatedAt : null,
        payload_json: JSON.stringify(record),
      });
    return record;
  }

  patch(id: string, patch: Record<string, unknown>): SharedBetRecord | null {
    const current = this.getById(id);
    if (!current) return null;
    const next = { ...current, ...patch, id };
    this.upsert(next);
    return next;
  }

  deleteById(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM shared_bets WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  deleteAll(): number {
    const result = this.db.prepare(`DELETE FROM shared_bets`).run();
    return result.changes ?? 0;
  }

  getById(id: string): SharedBetRecord | null {
    const row = this.db.prepare(`SELECT payload_json FROM shared_bets WHERE id = ?`).get(id) as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as any).id === "string") {
        return parsed as SharedBetRecord;
      }
    } catch {
      // ignore
    }
    return null;
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(1) as c FROM shared_bets`).get() as { c: number };
    return Number(row?.c ?? 0);
  }
}

class JsonBetsStore implements BetsStoreBackend {
  private jsonPath: string;

  constructor(opts: BetsStoreOptions) {
    this.jsonPath = opts.legacyJsonPath;
    const dir = dirname(this.jsonPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private load(): SharedBetRecord[] {
    if (!existsSync(this.jsonPath)) return [];
    try {
      const raw = readFileSync(this.jsonPath, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SharedBetRecord[]) : [];
    } catch {
      return [];
    }
  }

  private save(rows: SharedBetRecord[]): void {
    writeFileSync(this.jsonPath, JSON.stringify(rows, null, 2), "utf-8");
  }

  list(): SharedBetRecord[] {
    const rows = this.load();
    return rows
      .slice()
      .sort((a, b) => {
        const aTime = Date.parse(a.createdAt ?? a.updatedAt ?? "") || 0;
        const bTime = Date.parse(b.createdAt ?? b.updatedAt ?? "") || 0;
        if (aTime !== bTime) return bTime - aTime;
        return String(b.id ?? "").localeCompare(String(a.id ?? ""));
      });
  }

  upsert(record: SharedBetRecord): SharedBetRecord {
    const rows = this.load();
    const idx = rows.findIndex((r) => r.id === record.id);
    if (idx >= 0) rows[idx] = { ...rows[idx], ...record, id: record.id };
    else rows.push(record);
    this.save(rows);
    return record;
  }

  patch(id: string, patch: Record<string, unknown>): SharedBetRecord | null {
    const current = this.getById(id);
    if (!current) return null;
    const next = { ...current, ...patch, id } as SharedBetRecord;
    this.upsert(next);
    return next;
  }

  deleteById(id: string): boolean {
    const rows = this.load();
    const next = rows.filter((r) => r.id !== id);
    if (next.length === rows.length) return false;
    this.save(next);
    return true;
  }

  deleteAll(): number {
    const rows = this.load();
    this.save([]);
    return rows.length;
  }

  getById(id: string): SharedBetRecord | null {
    const rows = this.load();
    return rows.find((r) => r.id === id) ?? null;
  }

  count(): number {
    return this.load().length;
  }
}

export class BetsStore {
  private backend: BetsStoreBackend;

  constructor(opts: BetsStoreOptions) {
    const forceJson = process.env.BETS_STORE === "json";
    if (!forceJson) {
      try {
        this.backend = new SqliteBetsStore(opts);
        return;
      } catch (err) {
        console.warn("[api/bets] sqlite unavailable; falling back to JSON store", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.backend = new JsonBetsStore(opts);
  }

  list(): SharedBetRecord[] {
    return this.backend.list();
  }

  upsert(record: SharedBetRecord): SharedBetRecord {
    return this.backend.upsert(record);
  }

  patch(id: string, patch: Record<string, unknown>): SharedBetRecord | null {
    return this.backend.patch(id, patch);
  }

  deleteById(id: string): boolean {
    return this.backend.deleteById(id);
  }

  deleteAll(): number {
    return this.backend.deleteAll();
  }

  getById(id: string): SharedBetRecord | null {
    return this.backend.getById(id);
  }

  count(): number {
    return this.backend.count();
  }
}

