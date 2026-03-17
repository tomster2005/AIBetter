/**
 * Recent match-by-match player stats from fixture outcomes + backtest row order.
 * Used to populate evidenceContext.playerRecentStats[].recentValues (last 5 appearances).
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const BACKTEST_DATASET_PATH = join(PROJECT_ROOT, "data", "backtestRows.json");
const FIXTURE_OUTCOMES_PATH = join(PROJECT_ROOT, "data", "fixtureOutcomes.json");

/** Match backend/outcomes shape. */
interface PlayerMatchStats {
  playerId: number;
  playerName: string;
  shots: number;
  shotsOnTarget: number;
  foulsCommitted?: number;
  foulsWon?: number;
}

interface OutcomesByFixture {
  [fixtureId: string]: { playerResults: PlayerMatchStats[] };
}

interface BacktestRow {
  fixtureId: number;
  kickoffAt: string;
  playerName: string;
  [key: string]: unknown;
}

interface BacktestDataset {
  rows: BacktestRow[];
}

/** Normalize player name for lookup (must match valueBetBuilder normalisation). */
function normalizeName(name: string): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

const MAX_RECENT = 5;

export interface RecentStatsForPlayer {
  shots: number[];
  shotsOnTarget: number[];
  foulsCommitted: number[];
  foulsWon: number[];
}

/** Key: normalized player name. Value: last 5 match values per stat (oldest to newest). */
let cachedByNormalizedName: Record<string, RecentStatsForPlayer> | null = null;

function loadOutcomes(): OutcomesByFixture {
  if (!existsSync(FIXTURE_OUTCOMES_PATH)) return {};
  try {
    const raw = readFileSync(FIXTURE_OUTCOMES_PATH, "utf-8");
    const data = JSON.parse(raw) as OutcomesByFixture;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function loadBacktestRows(): BacktestRow[] {
  if (!existsSync(BACKTEST_DATASET_PATH)) return [];
  try {
    const raw = readFileSync(BACKTEST_DATASET_PATH, "utf-8");
    const data = JSON.parse(raw) as BacktestDataset;
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    return rows;
  } catch {
    return [];
  }
}

/**
 * Build index: normalized player name -> last MAX_RECENT match values per stat (chronological).
 * Uses backtest row order (kickoffAt) to order fixtures; then outcome playerResults per fixture.
 */
function buildIndex(): Record<string, RecentStatsForPlayer> {
  const outcomes = loadOutcomes();
  const rows = loadBacktestRows();

  const fixtureOrder: { fixtureId: number; kickoffAt: string }[] = [];
  const seenFixture = new Set<number>();
  for (const r of rows) {
    const fid = r.fixtureId;
    if (seenFixture.has(fid)) continue;
    seenFixture.add(fid);
    fixtureOrder.push({ fixtureId: fid, kickoffAt: r.kickoffAt || "" });
  }
  fixtureOrder.sort((a, b) => (a.kickoffAt || "").localeCompare(b.kickoffAt || ""));

  const byPlayer: Record<string, { shots: number[]; shotsOnTarget: number[]; foulsCommitted: number[]; foulsWon: number[] }> = {};

  for (const { fixtureId } of fixtureOrder) {
    const outcome = outcomes[String(fixtureId)];
    if (!outcome?.playerResults?.length) continue;

    for (const p of outcome.playerResults) {
      const key = normalizeName(p.playerName);
      if (!key) continue;
      if (!byPlayer[key]) {
        byPlayer[key] = { shots: [], shotsOnTarget: [], foulsCommitted: [], foulsWon: [] };
      }
      const arr = byPlayer[key];
      arr.shots.push(typeof p.shots === "number" ? p.shots : 0);
      arr.shotsOnTarget.push(typeof p.shotsOnTarget === "number" ? p.shotsOnTarget : 0);
      arr.foulsCommitted.push(typeof p.foulsCommitted === "number" ? p.foulsCommitted : 0);
      arr.foulsWon.push(typeof p.foulsWon === "number" ? p.foulsWon : 0);
    }
  }

  const result: Record<string, RecentStatsForPlayer> = {};
  for (const [key, arr] of Object.entries(byPlayer)) {
    result[key] = {
      shots: arr.shots.slice(-MAX_RECENT),
      shotsOnTarget: arr.shotsOnTarget.slice(-MAX_RECENT),
      foulsCommitted: arr.foulsCommitted.slice(-MAX_RECENT),
      foulsWon: arr.foulsWon.slice(-MAX_RECENT),
    };
  }
  return result;
}

function getIndex(): Record<string, RecentStatsForPlayer> {
  if (cachedByNormalizedName == null) {
    cachedByNormalizedName = buildIndex();
  }
  return cachedByNormalizedName;
}

/**
 * Return recent match-by-match stats for the given player names (by normalized name).
 * Only includes players that appear in outcomes; others are omitted.
 */
export function getRecentPlayerStats(playerNames: string[]): Record<string, RecentStatsForPlayer> {
  const index = getIndex();
  const out: Record<string, RecentStatsForPlayer> = {};
  const seen = new Set<string>();
  for (const name of playerNames) {
    const key = normalizeName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const stats = index[key];
    if (stats) out[key] = stats;
  }
  return out;
}

/** Clear in-memory cache (e.g. after outcomes or backtest data is updated). */
export function clearRecentPlayerStatsCache(): void {
  cachedByNormalizedName = null;
}
