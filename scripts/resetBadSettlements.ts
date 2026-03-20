/**
 * Reset previously-settled rows (actualCount/actualOutcome) for targeted markets/fixtures.
 *
 * This is a cleanup utility to undo bad settlement runs when the required stat data
 * was missing or incorrectly mapped.
 *
 * Usage:
 *   npx tsx scripts/resetBadSettlements.ts
 *   npx tsx scripts/resetBadSettlements.ts --market=334 --market=336
 *   npx tsx scripts/resetBadSettlements.ts --fixture=19427176
 *
 * Defaults:
 *   Resets Player Shots (336) and Player Shots On Target (334).
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { BacktestDataset, StoredBacktestRow } from "../src/lib/backtestDataset.js";
import { MARKET_ID_PLAYER_SHOTS, MARKET_ID_PLAYER_SHOTS_ON_TARGET } from "../src/constants/marketIds.js";

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

function saveDataset(data: BacktestDataset): void {
  writeFileSync(DATASET_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function isSettled(r: StoredBacktestRow): boolean {
  return r.actualOutcome === "hit" || r.actualOutcome === "miss";
}

function main(): void {
  const args = process.argv.slice(2);
  const marketIds = new Set<number>([MARKET_ID_PLAYER_SHOTS_ON_TARGET, MARKET_ID_PLAYER_SHOTS]);
  let fixtureId: number | null = null;
  let samplePrinted = 0;
  const MAX_SAMPLES = 10;

  for (const a of args) {
    if (a.startsWith("--market=")) {
      const n = parseInt(a.slice("--market=".length).trim(), 10);
      if (Number.isFinite(n) && n > 0) marketIds.add(n);
    } else if (a.startsWith("--fixture=")) {
      const n = parseInt(a.slice("--fixture=".length).trim(), 10);
      if (Number.isFinite(n) && n > 0) fixtureId = n;
    }
  }

  const data = loadDataset();
  const totalRows = data.rows.length;
  let resetCount = 0;
  let unchangedCount = 0;

  for (const r of data.rows) {
    const shouldConsider =
      (fixtureId != null ? r.fixtureId === fixtureId : marketIds.has(r.marketId));

    if (!shouldConsider) {
      unchangedCount += 1;
      continue;
    }

    if (!isSettled(r)) {
      unchangedCount += 1;
      continue;
    }

    if (samplePrinted < MAX_SAMPLES) {
      console.log("[reset-bad-settlements] resetting row sample", {
        fixtureId: r.fixtureId,
        playerName: r.playerName,
        marketId: r.marketId,
        line: r.line,
        prevActualCount: r.actualCount,
        prevActualOutcome: r.actualOutcome,
      });
      samplePrinted += 1;
    }

    r.actualCount = null;
    r.actualOutcome = null;
    resetCount += 1;
  }

  if (resetCount > 0) saveDataset(data);

  console.log("[reset-bad-settlements] summary", {
    datasetPath: DATASET_PATH,
    totalRowsScanned: totalRows,
    resetCount,
    unchangedCount,
    mode: fixtureId != null ? { fixtureId } : { marketIds: Array.from(marketIds.values()).sort((a, b) => a - b) },
  });
}

main();

