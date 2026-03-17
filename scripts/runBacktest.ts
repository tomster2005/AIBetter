/**
 * Run value-bet backtest and write calibration + report.
 * Usage: npx tsx scripts/runBacktest.ts [path-to-data.json]
 * Data JSON shape: { "contexts": PreMatchContext[], "outcomes": HistoricalFixtureOutcome[] }
 * See src/lib/valueBetBacktest.ts for types.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  runBacktest,
  buildLowLineEvaluation,
  type PreMatchContext,
  type HistoricalFixtureOutcome,
} from "../src/lib/valueBetBacktest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function main() {
  const dataPath = process.argv[2] ?? process.env.BACKTEST_DATA ?? join(root, "backtest-data.json");
  let data: { contexts: PreMatchContext[]; outcomes: HistoricalFixtureOutcome[] };
  try {
    const raw = readFileSync(dataPath, "utf-8");
    data = JSON.parse(raw) as { contexts: PreMatchContext[]; outcomes: HistoricalFixtureOutcome[] };
  } catch (e) {
    console.error("Failed to read backtest data from", dataPath, e);
    process.exit(1);
  }

  const { contexts, outcomes } = data;
  if (!Array.isArray(contexts) || !Array.isArray(outcomes)) {
    console.error("Data must have contexts and outcomes arrays");
    process.exit(1);
  }

  const { rows, summary, calibrationTable } = runBacktest(contexts, outcomes);

  console.log("\n=== Value Bet Backtest Report ===\n");
  console.log("Total rows:", summary.totalBets);
  console.log("Hits:", summary.hits);
  console.log("Hit rate:", (summary.hitRate * 100).toFixed(2) + "%");
  console.log("Avg bookmaker prob:", (summary.avgBookmakerProbability * 100).toFixed(2) + "%");
  console.log("Avg raw model prob:", (summary.avgRawModelProbability * 100).toFixed(2) + "%");
  console.log("Avg calibrated prob:", (summary.avgCalibratedProbability * 100).toFixed(2) + "%");
  console.log("Brier (raw):", summary.brierScoreRaw.toFixed(4));
  console.log("Brier (calibrated):", summary.brierScoreCalibrated.toFixed(4));
  console.log("Log loss (raw):", summary.logLossRaw.toFixed(4));
  console.log("Log loss (calibrated):", summary.logLossCalibrated.toFixed(4));
  console.log("ROI (positive edge only):", (summary.roiPositiveEdge * 100).toFixed(2) + "%");
  console.log("\nROI by edge bucket:", JSON.stringify(summary.roiByEdgeBucket, null, 2));
  console.log("\nROI by confidence:", JSON.stringify(summary.roiByConfidence, null, 2));
  console.log("\nHit rate by confidence:", JSON.stringify(summary.hitRateByConfidence, null, 2));
  console.log("\nCalibration table:");
  for (const b of calibrationTable) {
    console.log(
      `  ${b.bucketKey}: n=${b.count} hitRate=${(b.hitRate * 100).toFixed(1)}% avgRaw=${((b.avgRawModelProbability ?? 0) * 100).toFixed(1)}%`
    );
  }

  const lowLineEval = buildLowLineEvaluation(rows);
  if (lowLineEval && lowLineEval.totalRowCount > 0) {
    console.log("\n=== 0.5-line evaluation (model vs actual outcomes) ===");
    console.log("Total 0.5-line rows:", lowLineEval.totalRowCount);
    console.log("\nBy market:");
    for (const ev of Object.values(lowLineEval.byMarket)) {
      console.log(`  ${ev.marketName} (${ev.marketId}):`);
      console.log(`    rowCount=${ev.rowCount} avgModelProb=${(ev.averageModelProbability * 100).toFixed(2)}% actualHitRate=${(ev.actualHitRate * 100).toFixed(2)}% avgBookProb=${(ev.averageBookmakerProbability * 100).toFixed(2)}% calibrationGap=${(ev.calibrationGap * 100).toFixed(2)}%`);
    }
    console.log("\nBy probability bucket (0.5 lines only):");
    for (const [key, b] of Object.entries(lowLineEval.byProbabilityBucket)) {
      console.log(`  ${key}: n=${b.rowCount} avgModelProb=${(b.averageModelProbability * 100).toFixed(2)}% actualHitRate=${(b.actualHitRate * 100).toFixed(2)}% calibrationGap=${(b.calibrationGap * 100).toFixed(2)}%`);
    }
  } else {
    console.log("\nNo 0.5-line rows in backtest data; skipping low-line evaluation.");
  }

  const publicDir = join(root, "public");
  if (!existsSync(publicDir)) mkdirSync(publicDir, { recursive: true });
  const outPath = join(publicDir, "calibration.json");
  try {
    writeFileSync(
      outPath,
      JSON.stringify({ calibrationTable, summary: { ...summary, calibration: undefined } }, null, 2),
      "utf-8"
    );
    console.log("\nCalibration written to", outPath);
  } catch (e) {
    console.error("Failed to write calibration.json", e);
  }
}

main();
