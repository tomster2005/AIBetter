import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

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

export class BetsStore {
  private db: Database.Database;
  private legacyJsonPath: string;

  constructor(opts: BetsStoreOptions) {
    const dbPath = opts.dbPath || process.env.BETS_DB_PATH || join(opts.projectRoot, "server", "data", "bets.sqlite");
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
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

