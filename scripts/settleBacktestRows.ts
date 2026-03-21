/**
 * Settlement script: fill actualCount and actualOutcome for saved backtest rows.
 * Loads data/backtestRows.json, groups unresolved rows by fixture, fetches post-match
 * player stats (or uses optional outcomes file), then updates and saves.
 *
 * Usage: npx tsx scripts/settleBacktestRows.ts [--outcomes=path]
 * Optional: BACKTEST_OUTCOMES_PATH or --outcomes=data/fixtureOutcomes.json
 *   Shape: { [fixtureId: string]: { playerResults: Array<{ playerId, playerName, shots, shotsOnTarget, foulsCommitted?, foulsWon? }> } }
 */

import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { StoredBacktestRow, BacktestDataset } from "../src/lib/backtestDataset.js";
import {
  MARKET_ID_PLAYER_SHOTS,
  MARKET_ID_PLAYER_SHOTS_ON_TARGET,
  MARKET_ID_PLAYER_FOULS_COMMITTED,
  MARKET_ID_PLAYER_FOULS_WON,
  MARKET_ID_PLAYER_TACKLES,
} from "../src/constants/marketIds.js";
import type { PlayerMatchStats } from "../src/api/fixtureSettlement.js";
import { getFixtureStateAndPlayerStats, getFixtureDetailsForSettlementDebug, SETTLEMENT_INCLUDES } from "../src/api/fixtureSettlement.js";
import { isMarketSupportedForSettlement, getMarketCapability } from "../src/lib/marketCapabilities.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const DEFAULT_DATASET_PATH = join(PROJECT_ROOT, "data", "backtestRows.json");
const DEBUG = process.env.SETTLE_DEBUG === "1";
const FORCE_RESETTLE = process.env.FORCE_RESETTLE === "1";

function loadDataset(path: string): BacktestDataset {
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as BacktestDataset;
    return Array.isArray(data?.rows) ? data : { rows: [] };
  } catch {
    return { rows: [] };
  }
}

function saveDataset(filePath: string, data: BacktestDataset): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function isUnresolved(row: StoredBacktestRow): boolean {
  return row.actualCount === null || row.actualOutcome === null;
}

function getActualCountForMarket(stats: PlayerMatchStats, marketId: number): number | null {
  switch (marketId) {
    case MARKET_ID_PLAYER_SHOTS:
      return stats.shots != null ? stats.shots : null;
    case MARKET_ID_PLAYER_SHOTS_ON_TARGET:
      return stats.shotsOnTarget != null ? stats.shotsOnTarget : null;
    case MARKET_ID_PLAYER_FOULS_COMMITTED:
      return stats.foulsCommitted != null ? stats.foulsCommitted : null;
    case MARKET_ID_PLAYER_FOULS_WON:
      return stats.foulsWon != null ? stats.foulsWon : null;
    case MARKET_ID_PLAYER_TACKLES:
      return stats.tackles != null ? stats.tackles : null;
    default:
      return null;
  }
}

/** Over X.5 hits when actualCount >= floor(line) + 1 (e.g. 0.5 -> >=1, 1.5 -> >=2). */
function outcomeFromCount(actualCount: number, line: number): "hit" | "miss" {
  const threshold = Math.floor(line) + 1;
  return actualCount >= threshold ? "hit" : "miss";
}

function normalizeName(s: string): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findPlayerStats(
  playerResults: PlayerMatchStats[],
  row: StoredBacktestRow
): PlayerMatchStats | null {
  if (row.playerId != null) {
    const byId = playerResults.find((p) => p.playerId === row.playerId);
    if (byId) return byId;
  }
  const want = normalizeName(row.playerName);
  return playerResults.find((p) => normalizeName(p.playerName) === want) ?? null;
}

async function main() {
  const args = process.argv.slice(2);
  let outcomesPath: string | null = process.env.BACKTEST_OUTCOMES_PATH ?? null;
  for (const a of args) {
    if (a.startsWith("--outcomes=")) outcomesPath = a.slice("--outcomes=".length).trim() || null;
  }

  const datasetPath = process.env.BACKTEST_DATASET_PATH ?? DEFAULT_DATASET_PATH;
  const data = loadDataset(datasetPath);
  const unresolved = FORCE_RESETTLE ? data.rows : data.rows.filter(isUnresolved);
  if (unresolved.length === 0) {
    console.log("[backtest-dataset] no unresolved rows");
    return;
  }
  if (DEBUG || FORCE_RESETTLE) {
    console.log("[settle-debug] run config", {
      datasetPath,
      forceResettle: FORCE_RESETTLE,
      debug: DEBUG,
      candidateRowCount: unresolved.length,
    });
  }

  const byFixture = new Map<number, StoredBacktestRow[]>();
  for (const row of unresolved) {
    const list = byFixture.get(row.fixtureId) ?? [];
    list.push(row);
    byFixture.set(row.fixtureId, list);
  }

  let settledCount = 0;
  let skippedUnfinished = 0;
  let skippedMissingStatCount = 0;
  let skippedUnsupportedMarketCount = 0;
  let settleCheckPrinted = 0;

  let outcomesByFixture: Record<string, { playerResults: PlayerMatchStats[] }> = {};
  if (outcomesPath) {
    const fullPath = join(PROJECT_ROOT, outcomesPath);
    try {
      const raw = readFileSync(fullPath, "utf-8");
      outcomesByFixture = JSON.parse(raw) as Record<string, { playerResults: PlayerMatchStats[] }>;
    } catch {
      // optional file
    }
  }

  if (DEBUG && outcomesPath) {
    const outcomeFixtureIds = Object.keys(outcomesByFixture || {}).slice(0, 15);
    const unresolvedFixtureIds = Array.from(byFixture.keys()).slice(0, 15).map(String);
    console.log("[settle-debug] outcomes file loaded", {
      outcomesPath,
      outcomeFixtureIdCount: Object.keys(outcomesByFixture || {}).length,
      sampleOutcomeFixtureIds: outcomeFixtureIds.length ? outcomeFixtureIds : null,
      unresolvedFixtureIdCount: byFixture.size,
      sampleUnresolvedFixtureIds: unresolvedFixtureIds.length ? unresolvedFixtureIds : null,
    });
  }

  for (const [fixtureId, rows] of byFixture) {
    let playerResults: PlayerMatchStats[];

    const fromFile = outcomesByFixture[String(fixtureId)];
    if (fromFile && Array.isArray(fromFile.playerResults) && fromFile.playerResults.length > 0) {
      playerResults = fromFile.playerResults;
      if (DEBUG) {
        const sampleRow = rows[0] ?? null;
        console.log("[settle-debug] outcomes-file branch", {
          fixtureId,
          fromFileExists: Boolean(fromFile),
          playerResultsLength: playerResults.length,
          unresolvedRowsForFixture: rows.length,
          sampleUnresolvedRow: sampleRow
            ? {
                playerId: sampleRow.playerId,
                playerName: sampleRow.playerName,
                marketId: sampleRow.marketId,
                line: sampleRow.line,
              }
            : null,
          samplePlayerResult: playerResults[0]
            ? {
                playerId: playerResults[0].playerId,
                playerName: playerResults[0].playerName,
                shots: playerResults[0].shots,
                shotsOnTarget: playerResults[0].shotsOnTarget,
                foulsCommitted: playerResults[0].foulsCommitted,
                foulsWon: playerResults[0].foulsWon,
              }
            : null,
        });
      }
    } else {
      try {
        const outcome = await getFixtureStateAndPlayerStats(fixtureId);
        if (!outcome.isFinished) {
          const firstRow = rows[0];
          const storedKickoffAt = firstRow?.kickoffAt ?? "(no kickoffAt)";
          const parsedKickoffAt = firstRow?.kickoffAt ? new Date(firstRow.kickoffAt) : null;
          const now = new Date();
          let rawDetails: Record<string, unknown> | null = null;
          try {
            rawDetails = (await getFixtureDetailsForSettlementDebug(fixtureId)) as Record<string, unknown>;
          } catch {
            rawDetails = null;
          }
          const state = rawDetails?.state as { name_short?: string; name?: string } | undefined;
          const short = (state?.name_short ?? state?.name ?? "").toUpperCase();
          const name = (state?.name ?? "").toLowerCase();
          const checkFT = short === "FT";
          const checkFullTime = name.includes("full time");
          const checkFinished = name.includes("finished");
          const checkAOT = short === "AOT";
          const timeStatusKeys = rawDetails
            ? Object.keys(rawDetails).filter(
                (k) =>
                  /state|time|date|kickoff|start|end|result|status|finished|period/i.test(k)
              )
            : [];
          const timeStatusSlice = rawDetails
            ? (Object.fromEntries(
                timeStatusKeys.map((k) => [k, rawDetails![k]])
              ) as Record<string, unknown>)
            : null;
          console.log("[settle-debug] unfinished fixture decision", {
            fixtureId,
            includeUsed: SETTLEMENT_INCLUDES,
            storedKickoffAt,
            parsedKickoffAt: parsedKickoffAt?.toISOString() ?? null,
            parsedKickoffAtInvalid: parsedKickoffAt != null && Number.isNaN(parsedKickoffAt.getTime()),
            currentTime: now.toISOString(),
            apiState: state ?? null,
            apiStateNameShort: state?.name_short ?? null,
            apiStateName: state?.name ?? null,
            booleanChecks: {
              "short === 'FT'": checkFT,
              "name.includes('full time')": checkFullTime,
              "name.includes('finished')": checkFinished,
              "short === 'AOT'": checkAOT,
            },
            isFinishedFromApi: outcome.isFinished,
            rawFixtureKeysTimeStatus: timeStatusKeys.length ? timeStatusKeys : null,
            rawFixtureTimeStatusSlice: timeStatusSlice,
          });
          skippedUnfinished += 1;
          continue;
        }
        if (!outcome.playerResults.length) {
          console.log("[settle-debug] finished but no playerResults", {
            fixtureId,
            isFinishedFromApi: outcome.isFinished,
            playerResultsLength: outcome.playerResults.length,
          });
          skippedUnfinished += 1;
          continue;
        }
        playerResults = outcome.playerResults;
        if (DEBUG) {
          let rawDetails: Record<string, unknown> | null = null;
          try {
            rawDetails = (await getFixtureDetailsForSettlementDebug(fixtureId)) as Record<string, unknown>;
          } catch {
            rawDetails = null;
          }
          const lineupsRaw = rawDetails?.lineups as unknown;
          const lineupsArr =
            Array.isArray(lineupsRaw) ? (lineupsRaw as unknown[]) : (lineupsRaw && typeof lineupsRaw === "object" && "data" in (lineupsRaw as object) ? ((lineupsRaw as { data?: unknown }).data as unknown[]) : []);
          const firstLineup = Array.isArray(lineupsArr) && lineupsArr.length > 0 ? (lineupsArr[0] as Record<string, unknown>) : null;
          const rawLineupDetails = firstLineup?.details as unknown;
          const detailsArr =
            Array.isArray(rawLineupDetails)
              ? (rawLineupDetails as unknown[])
              : rawLineupDetails && typeof rawLineupDetails === "object" && "data" in (rawLineupDetails as object)
                ? (((rawLineupDetails as { data?: unknown }).data as unknown[]) ?? [])
                : [];
          const detailTypeNames = detailsArr
            .slice(0, 15)
            .map((d) => String((d as { type?: { name?: unknown } })?.type?.name ?? "").trim())
            .filter((s) => s !== "");
          console.log("[settle-debug] sample playerResults", {
            fixtureId,
            includeUsed: SETTLEMENT_INCLUDES,
            sample: playerResults[0] ?? null,
          });
          console.log("[settle-debug] fixture lineup details sample", {
            fixtureId,
            lineupsLength: Array.isArray(lineupsArr) ? lineupsArr.length : 0,
            firstLineupPlayerName: firstLineup ? String(firstLineup.player_name ?? (firstLineup.player as { name?: string } | undefined)?.name ?? "") : null,
            detailsLength: detailsArr.length,
            detailTypeNames,
            firstDetail: detailsArr[0] ?? null,
          });
        }
      } catch (err) {
        console.log("[settle-debug] fixture fetch failed", {
          fixtureId,
          error: err instanceof Error ? err.message : String(err),
        });
        skippedUnfinished += 1;
        continue;
      }
    }

    let rowDebugCount = 0;
    let rowsTried = 0;
    let rowsMatchedToPlayer = 0;
    let rowsSettledThisFixture = 0;
    let rowsNoPlayerMatch = 0;
    let rowsNullActualCount = 0;
    for (const row of rows) {
      rowsTried += 1;
      if (!isMarketSupportedForSettlement(row.marketId)) {
        skippedUnsupportedMarketCount += 1;
        if (DEBUG && rowDebugCount < 12) {
          console.log("[settle-debug] skipped unsupported market for settlement", {
            fixtureId,
            marketId: row.marketId,
            marketName: row.marketName,
            playerName: row.playerName,
            note: getMarketCapability(row.marketId).note ?? null,
          });
          rowDebugCount += 1;
        }
        continue;
      }
      const stats = findPlayerStats(playerResults, row);
      if (!stats) {
        rowsNoPlayerMatch += 1;
        if (DEBUG && rowDebugCount < 12) {
          console.log("[settle-debug] no player match", {
            fixtureId,
            playerId: row.playerId,
            playerName: row.playerName,
            marketId: row.marketId,
            line: row.line,
          });
          rowDebugCount += 1;
        }
        continue;
      }
      rowsMatchedToPlayer += 1;
      const actualCount = getActualCountForMarket(stats, row.marketId);
      if (actualCount === null) {
        rowsNullActualCount += 1;
        skippedMissingStatCount += 1;
        if (DEBUG && rowDebugCount < 12) {
          console.log("[settle-debug] skipped due to missing stat", {
            fixtureId,
            playerName: row.playerName,
            marketId: row.marketId,
          });
          rowDebugCount += 1;
        }
        if (DEBUG && rowDebugCount < 12) {
          console.log("[settle-debug] matched player but null actualCount", {
            fixtureId,
            playerName: row.playerName,
            marketId: row.marketId,
            line: row.line,
            stats,
          });
          rowDebugCount += 1;
        }
        continue;
      }
      if (DEBUG && rowDebugCount < 8) {
        console.log("[settle-debug] row vs stats", {
          fixtureId,
          playerName: row.playerName,
          marketId: row.marketId,
          line: row.line,
          actualCount,
          stats,
        });
        rowDebugCount += 1;
      }
      row.actualCount = actualCount;
      row.actualOutcome = outcomeFromCount(actualCount, row.line);
      settledCount += 1;
      rowsSettledThisFixture += 1;

      if (DEBUG && settleCheckPrinted < 10) {
        const selection = (row as unknown as { outcome?: unknown }).outcome;
        const assumedSelection = selection === "Over" || selection === "Under" ? selection : null;
        const threshold = Math.floor(row.line) + 1;
        console.log("[settle-debug-check]", {
          fixtureId,
          marketId: row.marketId,
          marketName: row.marketName,
          playerName: row.playerName,
          playerId: row.playerId,
          line: row.line,
          selection: assumedSelection,
          actualStat: actualCount,
          comparison: {
            actual: actualCount,
            line: row.line,
            thresholdOverX5: threshold,
            result: actualCount >= threshold ? "over-hit" : "over-miss",
          },
          finalOutcome: row.actualOutcome,
        });
        settleCheckPrinted += 1;
      }
    }
    if (DEBUG && fromFile && Array.isArray(fromFile.playerResults) && fromFile.playerResults.length > 0) {
      console.log("[settle-debug] outcomes-file fixture summary", {
        fixtureId,
        rowsTried,
        rowsMatchedToPlayer,
        rowsSettled: rowsSettledThisFixture,
        rowsNoPlayerMatch,
        rowsNullActualCount,
      });
    }
  }

  if (settledCount > 0) saveDataset(datasetPath, data);

  console.log("[backtest-dataset] settled rows:", settledCount);
  console.log("[backtest-dataset] skipped unfinished fixtures:", skippedUnfinished);
  console.log("[backtest-dataset] skipped rows due to missing stat:", skippedMissingStatCount);
  console.log("[backtest-dataset] skipped rows due to unsupported market:", skippedUnsupportedMarketCount);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
