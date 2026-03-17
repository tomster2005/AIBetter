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

  const unresolved = rows.filter((r) => r.actualOutcome == null);
  const settled = rows.filter((r) => r.actualOutcome === "hit" || r.actualOutcome === "miss");

  const missingOdds = rows.filter((r) => r.odds == null || !Number.isFinite(r.odds));
  const missingEdge = rows.filter((r) => r.edge == null && r.actualOutcome != null);
  const invalidOutcome = rows.filter(
    (r) => r.actualOutcome != null && r.actualOutcome !== "hit" && r.actualOutcome !== "miss"
  );
  if (missingOdds.length > 0) console.warn("[summariseBacktestRows] rows missing odds:", missingOdds.length);
  if (missingEdge.length > 0) console.warn("[summariseBacktestRows] settled rows missing edge:", missingEdge.length);
  if (invalidOutcome.length > 0) console.warn("[summariseBacktestRows] rows with invalid actualOutcome:", invalidOutcome.length);

  const overall = computeStats(rows);
  console.log("\n=== Backtest summary ===\n");
  console.log("totalRows:", rows.length);
  console.log("unresolvedRows:", unresolved.length);
  console.log("settledRows:", settled.length);
  console.log("");
  printStats(overall, "Overall (settled only)");

  const byMarket = new Map<number, { marketName: string; rows: StoredBacktestRow[] }>();
  for (const r of rows) {
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
  console.log("Done.");
}

main();
