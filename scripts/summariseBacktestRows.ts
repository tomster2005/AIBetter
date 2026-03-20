/**
 * Read-only backtest summary over data/backtestRows.json.
 * Flat 1 unit per settled bet. Does not modify the dataset.
 *
 * Usage: npx tsx scripts/summariseBacktestRows.ts
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { StoredBacktestRow, BacktestDataset } from "../src/lib/backtestDataset.js";
import { isMarketSupportedForBacktest, getMarketCapability } from "../src/lib/marketCapabilities.js";
import { MARKET_ID_PLAYER_FOULS_COMMITTED, MARKET_ID_PLAYER_FOULS_WON } from "../src/constants/marketIds.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const DATASET_PATH = join(PROJECT_ROOT, "data", "backtestRows.json");

function loadRows(): StoredBacktestRow[] {
  if (!existsSync(DATASET_PATH)) {
    console.log("Dataset not found:", DATASET_PATH);
    return [];
  }
  try {
    const raw = readFileSync(DATASET_PATH, "utf-8");
    const data = JSON.parse(raw) as BacktestDataset;
    return Array.isArray(data?.rows) ? data.rows : [];
  } catch (e) {
    console.error("Failed to load dataset:", e);
    return [];
  }
}

function profitForRow(row: StoredBacktestRow): number | null {
  if (row.actualOutcome === "hit") return (row.odds ?? 0) - 1;
  if (row.actualOutcome === "miss") return -1;
  return null;
}

function isSettled(row: StoredBacktestRow): boolean {
  return row.actualOutcome === "hit" || row.actualOutcome === "miss";
}

function settledSampleNote(settledCount: number): string {
  return settledCount > 0 && settledCount < 20 ? " (low sample)" : "";
}

function getOddsBand(odds: number): string {
  if (!Number.isFinite(odds) || odds <= 0) return "invalid";
  if (odds < 1.5) return "< 1.50";
  if (odds < 2.0) return "1.50–1.99";
  if (odds < 2.5) return "2.00–2.49";
  if (odds < 3.0) return "2.50–2.99";
  return "3.00+";
}

function getDirectionLabel(row: StoredBacktestRow): "Over" | "Under" | null {
  const o = (row as unknown as { outcome?: unknown }).outcome;
  if (o === "Over" || o === "Under") return o;
  return null;
}

function getConfidence01(row: StoredBacktestRow): number | null {
  // StoredBacktestRow doesn't guarantee confidence fields, but older/newer datasets might include them.
  const raw = (row as unknown as { dataConfidenceScore?: unknown; confidence?: unknown }).dataConfidenceScore ??
    (row as unknown as { confidence?: unknown }).confidence;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw >= 0 && raw <= 1) return raw;
  if (raw >= 0 && raw <= 100) return raw / 100;
  return null;
}

function getConfidenceBand01(c: number): string {
  if (c < 0.5) return "< 0.50";
  if (c < 0.6) return "0.50–0.59";
  if (c < 0.7) return "0.60–0.69";
  return "0.70+";
}

function computeBucket(rows: StoredBacktestRow[]): {
  total: number;
  settled: number;
  hit: number;
  miss: number;
  unresolved: number;
  hitRate: number;
  roi: number;
} {
  const total = rows.length;
  const settledRows = rows.filter(isSettled);
  const hit = settledRows.filter((r) => r.actualOutcome === "hit").length;
  const miss = settledRows.filter((r) => r.actualOutcome === "miss").length;
  const settled = settledRows.length;
  const unresolved = total - settled;
  let totalProfit = 0;
  for (const r of settledRows) {
    const p = profitForRow(r);
    if (p != null) totalProfit += p;
  }
  const hitRate = settled > 0 ? hit / settled : 0;
  const roi = settled > 0 ? totalProfit / settled : 0;
  return { total, settled, hit, miss, unresolved, hitRate, roi };
}

function printBucketLine(label: string, b: ReturnType<typeof computeBucket>): void {
  const note = settledSampleNote(b.settled);
  console.log(
    `  ${label}: total=${b.total} settled=${b.settled} hit=${b.hit} miss=${b.miss} unresolved=${b.unresolved} hitRate=${(b.hitRate * 100).toFixed(2)}% ROI=${(b.roi * 100).toFixed(2)}%${note}`
  );
}

interface RowStats {
  settledCount: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  averageOdds: number;
  averageEdge: number;
  totalProfit: number;
  roi: number;
}

function computeStats(rows: StoredBacktestRow[]): RowStats {
  const settled = rows.filter((r) => r.actualOutcome === "hit" || r.actualOutcome === "miss");
  const hitCount = settled.filter((r) => r.actualOutcome === "hit").length;
  const missCount = settled.filter((r) => r.actualOutcome === "miss").length;
  const settledCount = settled.length;
  const hitRate = settledCount > 0 ? hitCount / settledCount : 0;
  let sumOdds = 0;
  let sumEdge = 0;
  let totalProfit = 0;
  for (const r of settled) {
    if (typeof r.odds === "number" && Number.isFinite(r.odds)) sumOdds += r.odds;
    if (typeof r.edge === "number" && Number.isFinite(r.edge)) sumEdge += r.edge;
    const p = profitForRow(r);
    if (p !== null) totalProfit += p;
  }
  const averageOdds = settledCount > 0 ? sumOdds / settledCount : 0;
  const edgeCount = settled.filter((r) => typeof r.edge === "number" && Number.isFinite(r.edge)).length;
  const averageEdge = edgeCount > 0 ? sumEdge / edgeCount : 0;
  const roi = settledCount > 0 ? totalProfit / settledCount : 0;
  return {
    settledCount,
    hitCount,
    missCount,
    hitRate,
    averageOdds,
    averageEdge,
    totalProfit,
    roi,
  };
}

function printStats(s: RowStats, label?: string): void {
  if (label != null && label !== "") console.log(`  ${label}`);
  console.log(`    settledCount: ${s.settledCount}  hitCount: ${s.hitCount}  missCount: ${s.missCount}`);
  console.log(`    hitRate: ${(s.hitRate * 100).toFixed(2)}%`);
  console.log(`    averageOdds: ${s.averageOdds.toFixed(2)}  averageEdge: ${(s.averageEdge * 100).toFixed(2)}%`);
  console.log(`    totalProfit: ${s.totalProfit.toFixed(2)}  ROI: ${(s.roi * 100).toFixed(2)}%`);
}

function main(): void {
  const rows = loadRows();
  if (rows.length === 0) {
    console.log("No rows in dataset.");
    return;
  }

  const eligible = rows.filter((r) => isMarketSupportedForBacktest(r.marketId));
  const excluded = rows.filter((r) => !isMarketSupportedForBacktest(r.marketId));

  const unresolved = eligible.filter((r) => r.actualOutcome == null);
  const settled = eligible.filter((r) => r.actualOutcome === "hit" || r.actualOutcome === "miss");

  const missingOdds = eligible.filter((r) => r.odds == null || !Number.isFinite(r.odds));
  const missingEdge = eligible.filter((r) => r.edge == null && r.actualOutcome != null);
  const invalidOutcome = eligible.filter(
    (r) => r.actualOutcome != null && r.actualOutcome !== "hit" && r.actualOutcome !== "miss"
  );
  if (missingOdds.length > 0) console.warn("[summariseBacktestRows] rows missing odds:", missingOdds.length);
  if (missingEdge.length > 0) console.warn("[summariseBacktestRows] settled rows missing edge:", missingEdge.length);
  if (invalidOutcome.length > 0) console.warn("[summariseBacktestRows] rows with invalid actualOutcome:", invalidOutcome.length);

  const overall = computeStats(eligible);
  console.log("\n=== Backtest summary ===\n");
  console.log("totalRows:", rows.length);
  console.log("eligibleRows (capability-filtered):", eligible.length);
  console.log("excludedRows (unsupported markets):", excluded.length);
  if (excluded.length > 0) {
    const byMarket = new Map<number, number>();
    for (const r of excluded) byMarket.set(r.marketId, (byMarket.get(r.marketId) ?? 0) + 1);
    const excludedByMarket = Array.from(byMarket.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([marketId, count]) => ({ marketId, count, note: getMarketCapability(marketId).note ?? null }));
    console.log("excludedByMarket:", excludedByMarket);
  }
  console.log("unresolvedRows:", unresolved.length);
  console.log("settledRows:", settled.length);
  console.log("");
  printStats(overall, "Overall (settled only)");

  const byMarket = new Map<number, { marketName: string; rows: StoredBacktestRow[] }>();
  for (const r of eligible) {
    const id = r.marketId ?? 0;
    const name = r.marketName ?? `Market ${id}`;
    if (!byMarket.has(id)) byMarket.set(id, { marketName: name, rows: [] });
    byMarket.get(id)!.rows.push(r);
  }
  console.log("\n--- Per market ---\n");
  const marketIds = [...byMarket.keys()].sort((a, b) => a - b);
  for (const marketId of marketIds) {
    const { marketName, rows: marketRows } = byMarket.get(marketId)!;
    const marketStats = computeStats(marketRows);
    if (marketStats.settledCount > 0) {
      console.log(`Market ${marketId} (${marketName}):`);
      printStats(marketStats);
      console.log("");
    }
  }

  // Fouls-first breakdowns (evaluation only; uses capability-filtered eligible rows).
  const foulsOnly = eligible.filter(
    (r) => r.marketId === MARKET_ID_PLAYER_FOULS_COMMITTED || r.marketId === MARKET_ID_PLAYER_FOULS_WON
  );
  console.log("\n--- Fouls-only breakdown (capability-filtered) ---\n");
  if (foulsOnly.length === 0) {
    console.log("No eligible fouls rows found.");
    console.log("Done.");
    return;
  }

  console.log("By market (includes unresolved):");
  const foulsByMarket = new Map<number, StoredBacktestRow[]>();
  for (const r of foulsOnly) {
    const id = r.marketId;
    if (!foulsByMarket.has(id)) foulsByMarket.set(id, []);
    foulsByMarket.get(id)!.push(r);
  }
  for (const mid of [...foulsByMarket.keys()].sort((a, b) => a - b)) {
    printBucketLine(`Market ${mid}`, computeBucket(foulsByMarket.get(mid)!));
  }

  // Direction breakdown (only if outcome field exists on enough rows).
  const dirKnown = foulsOnly.filter((r) => getDirectionLabel(r) != null);
  console.log("\nBy direction:");
  if (dirKnown.length < Math.max(10, Math.floor(foulsOnly.length * 0.5))) {
    console.log(
      `  Direction not available on enough rows (have ${dirKnown.length}/${foulsOnly.length} with outcome=Over/Under).`
    );
  } else {
    const byDir = new Map<"Over" | "Under", StoredBacktestRow[]>();
    for (const r of dirKnown) {
      const d = getDirectionLabel(r)!;
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d)!.push(r);
    }
    for (const d of ["Over", "Under"] as const) {
      if (byDir.has(d)) printBucketLine(d, computeBucket(byDir.get(d)!));
    }
  }

  console.log("\nBy odds band:");
  const byOddsBand = new Map<string, StoredBacktestRow[]>();
  for (const r of foulsOnly) {
    const band = getOddsBand(r.odds);
    if (!byOddsBand.has(band)) byOddsBand.set(band, []);
    byOddsBand.get(band)!.push(r);
  }
  const oddsOrder = ["< 1.50", "1.50–1.99", "2.00–2.49", "2.50–2.99", "3.00+", "invalid"];
  for (const band of oddsOrder) {
    const rowsInBand = byOddsBand.get(band);
    if (rowsInBand && rowsInBand.length > 0) printBucketLine(band, computeBucket(rowsInBand));
  }

  console.log("\nBy confidence band:");
  const withConf = foulsOnly
    .map((r) => ({ r, c: getConfidence01(r) }))
    .filter((x) => x.c != null) as Array<{ r: StoredBacktestRow; c: number }>;
  if (withConf.length < Math.max(10, Math.floor(foulsOnly.length * 0.5))) {
    console.log(`  Confidence not available on enough rows (have ${withConf.length}/${foulsOnly.length}).`);
  } else {
    const byConfBand = new Map<string, StoredBacktestRow[]>();
    for (const { r, c } of withConf) {
      const band = getConfidenceBand01(c);
      if (!byConfBand.has(band)) byConfBand.set(band, []);
      byConfBand.get(band)!.push(r);
    }
    const confOrder = ["< 0.50", "0.50–0.59", "0.60–0.69", "0.70+"];
    for (const band of confOrder) {
      const rs = byConfBand.get(band);
      if (rs && rs.length > 0) printBucketLine(band, computeBucket(rs));
    }
  }

  console.log("Done.");
}

main();
