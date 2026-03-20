/**
 * Remove unsupported (non-backtest-capable) markets from stored backtest dataset.
 *
 * Uses src/lib/marketCapabilities.ts as the single source of truth.
 *
 * Usage:
 *   npx tsx scripts/cleanUnsupportedBacktestRows.ts
 *
 * This mutates data/backtestRows.json by removing rows whose marketId is not supported for backtest.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { BacktestDataset } from "../src/lib/backtestDataset.js";
import { isMarketSupportedForBacktest } from "../src/lib/marketCapabilities.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const DATASET_PATH = join(PROJECT_ROOT, "data", "backtestRows.json");

function loadDataset(): BacktestDataset {
  if (!existsSync(DATASET_PATH)) return { rows: [] };
  try {
    const raw = readFileSync(DATASET_PATH, "utf-8");
    const data = JSON.parse(raw) as BacktestDataset;
    return Array.isArray(data?.rows) ? data : { rows: [] };
  } catch {
    return { rows: [] };
  }
}

function main(): void {
  const data = loadDataset();
  const total = data.rows.length;

  const removedByMarket = new Map<number, number>();
  const kept = [];
  for (const r of data.rows) {
    if (isMarketSupportedForBacktest(r.marketId)) {
      kept.push(r);
    } else {
      removedByMarket.set(r.marketId, (removedByMarket.get(r.marketId) ?? 0) + 1);
    }
  }

  const removed = total - kept.length;
  if (removed === 0) {
    console.log("[clean-unsupported] no rows removed", { datasetPath: DATASET_PATH, totalRows: total });
    return;
  }

  data.rows = kept;
  writeFileSync(DATASET_PATH, JSON.stringify(data, null, 2), "utf-8");

  const removedByMarketList = Array.from(removedByMarket.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([marketId, count]) => ({ marketId, removedCount: count }));

  console.log("[clean-unsupported] cleaned dataset", {
    datasetPath: DATASET_PATH,
    totalRowsBefore: total,
    totalRowsAfter: kept.length,
    removedRows: removed,
    removedByMarket: removedByMarketList,
  });
}

main();

