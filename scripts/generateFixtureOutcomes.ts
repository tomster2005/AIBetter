/**
 * Generate data/fixtureOutcomes.json keyed by real Sportmonks fixtureId.
 *
 * Reads the backtest dataset, collects fixtureIds, fetches post-match player stats,
 * and writes outcomes in the shape:
 * {
 *   "<fixtureId>": { "playerResults": [ { playerId, playerName, shots?, shotsOnTarget?, foulsCommitted?, foulsWon? } ] }
 * }
 *
 * Usage:
 *   npx tsx scripts/generateFixtureOutcomes.ts
 *   npx tsx scripts/generateFixtureOutcomes.ts --out=data/fixtureOutcomes.json --dataset=data/backtestRows.json
 *   npx tsx scripts/generateFixtureOutcomes.ts --fixture=19427176
 *
 * Env:
 *   SPORTMONKS_API_TOKEN required for live fetches.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { BacktestDataset } from "../src/lib/backtestDataset.js";
import { getFixtureStateAndPlayerStats } from "../src/api/fixtureSettlement.js";
import { getFixtureDetailsForSettlementDebug, SETTLEMENT_INCLUDES } from "../src/api/fixtureSettlement.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

const DEFAULT_DATASET = join(PROJECT_ROOT, "data", "backtestRows.json");
const DEFAULT_OUT = join(PROJECT_ROOT, "data", "fixtureOutcomes.json");
const DEBUG = process.env.OUTCOMES_DEBUG === "1";

function loadDataset(path: string): BacktestDataset {
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as BacktestDataset;
    return Array.isArray(data?.rows) ? data : { rows: [] };
  } catch {
    return { rows: [] };
  }
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function main() {
  const args = process.argv.slice(2);
  let datasetPath = DEFAULT_DATASET;
  let outPath = DEFAULT_OUT;
  let onlyFixture: number | null = null;

  for (const a of args) {
    if (a.startsWith("--dataset=")) datasetPath = join(PROJECT_ROOT, a.slice("--dataset=".length).trim());
    if (a.startsWith("--out=")) outPath = join(PROJECT_ROOT, a.slice("--out=".length).trim());
    if (a.startsWith("--fixture=")) {
      const n = parseInt(a.slice("--fixture=".length).trim(), 10);
      if (Number.isFinite(n) && n > 0) onlyFixture = n;
    }
  }

  const data = loadDataset(datasetPath);
  const fixtureIds = new Set<number>();
  for (const r of data.rows) {
    if (onlyFixture != null && r.fixtureId !== onlyFixture) continue;
    fixtureIds.add(r.fixtureId);
  }

  const ids = Array.from(fixtureIds.values()).sort((a, b) => a - b);
  console.log("[outcomes-gen] start", {
    datasetPath,
    outPath,
    fixtureIdCount: ids.length,
    sampleFixtureIds: ids.slice(0, 10),
  });

  const out: Record<string, { playerResults: unknown[] }> = {};
  let finishedCount = 0;
  let skippedUnfinished = 0;
  let skippedNoPlayerResults = 0;
  let failedCount = 0;

  for (const fixtureId of ids) {
    try {
      const outcome = await getFixtureStateAndPlayerStats(fixtureId);
      if (!outcome.isFinished) {
        skippedUnfinished += 1;
        continue;
      }
      if (!outcome.playerResults.length) {
        skippedNoPlayerResults += 1;
        continue;
      }
      out[String(fixtureId)] = { playerResults: outcome.playerResults };
      finishedCount += 1;
      const sample = outcome.playerResults[0] as Record<string, unknown> | undefined;
      console.log("[outcomes-gen] wrote", {
        fixtureId,
        playerResultsCount: outcome.playerResults.length,
        samplePlayerResultKeys: sample ? Object.keys(sample) : null,
      });

      if (DEBUG) {
        try {
          const raw = (await getFixtureDetailsForSettlementDebug(fixtureId)) as Record<string, unknown>;
          const lineupsRaw = raw?.lineups as unknown;
          const lineupsArr =
            Array.isArray(lineupsRaw) ? (lineupsRaw as unknown[]) : (lineupsRaw && typeof lineupsRaw === "object" && "data" in (lineupsRaw as object) ? ((lineupsRaw as { data?: unknown }).data as unknown[]) : []);
          const firstLineup = Array.isArray(lineupsArr) && lineupsArr.length > 0 ? (lineupsArr[0] as Record<string, unknown>) : null;
          const rawDetails = firstLineup?.details as unknown;
          const detailsArr =
            Array.isArray(rawDetails)
              ? (rawDetails as unknown[])
              : rawDetails && typeof rawDetails === "object" && "data" in (rawDetails as object)
                ? (((rawDetails as { data?: unknown }).data as unknown[]) ?? [])
                : [];
          const detailPreview = detailsArr.slice(0, 12).map((d) => ({
            type: String((d as { type?: { name?: unknown } })?.type?.name ?? ""),
            value: (d as { value?: unknown })?.value ?? null,
          }));
          const foulDetails = detailsArr
            .map((d) => ({
              type: String((d as { type?: { name?: unknown } })?.type?.name ?? ""),
              value: (d as { value?: unknown })?.value ?? null,
            }))
            .filter((x) => x.type.toLowerCase().includes("foul"))
            .slice(0, 6);
          // Also scan other lineup entries for the first one with foul details (goalkeepers often have none).
          let firstFoulPlayer: { playerName: string | null; foulDetails: Array<{ type: string; value: unknown }> } | null = null;
          let firstFoulPlayerWithValue: { playerName: string | null; foulDetails: Array<{ type: string; value: unknown }> } | null = null;
          if (!foulDetails.length && Array.isArray(lineupsArr)) {
            for (const le of lineupsArr as unknown[]) {
              const entry = le as Record<string, unknown>;
              const entryName = String(entry.player_name ?? (entry.player as { name?: string } | undefined)?.name ?? "").trim() || null;
              const rd = entry.details as unknown;
              const da =
                Array.isArray(rd)
                  ? (rd as unknown[])
                  : rd && typeof rd === "object" && "data" in (rd as object)
                    ? (((rd as { data?: unknown }).data as unknown[]) ?? [])
                    : [];
              const fd = da
                .map((d) => ({
                  type: String((d as { type?: { name?: unknown } })?.type?.name ?? ""),
                  value: (d as { value?: unknown })?.value ?? null,
                }))
                .filter((x) => x.type.toLowerCase().includes("foul"));
              if (fd.length) {
                firstFoulPlayer = { playerName: entryName, foulDetails: fd.slice(0, 6) };
                const nonNull = fd.filter((x) => x.value != null);
                if (nonNull.length && firstFoulPlayerWithValue == null) {
                  firstFoulPlayerWithValue = { playerName: entryName, foulDetails: nonNull.slice(0, 6) };
                }
                break;
              }
            }
          }
          const safeJson = (v: unknown): string => {
            try {
              return JSON.stringify(v);
            } catch {
              return "\"(unserializable)\"";
            }
          };
          console.log("[outcomes-gen-debug] settlement fetch include", { fixtureId, includeUsed: SETTLEMENT_INCLUDES });
          console.log("[outcomes-gen-debug] lineup details preview", {
            fixtureId,
            lineupsLength: Array.isArray(lineupsArr) ? lineupsArr.length : 0,
            firstLineupPlayerName: firstLineup ? String(firstLineup.player_name ?? (firstLineup.player as { name?: string } | undefined)?.name ?? "") : null,
            detailsLength: detailsArr.length,
            detailPreview,
            foulDetails: foulDetails.length ? foulDetails : null,
            firstFoulPlayer: firstFoulPlayer
              ? {
                  playerName: firstFoulPlayer.playerName,
                  foulDetails: firstFoulPlayer.foulDetails.map((x) => ({ type: x.type, valueJson: safeJson(x.value) })),
                }
              : null,
            firstFoulPlayerWithValue: firstFoulPlayerWithValue
              ? {
                  playerName: firstFoulPlayerWithValue.playerName,
                  foulDetails: firstFoulPlayerWithValue.foulDetails.map((x) => ({ type: x.type, valueJson: safeJson(x.value) })),
                }
              : null,
          });
          if (firstFoulPlayer) {
            console.log(
              "[outcomes-gen-debug] firstFoulPlayer json",
              safeJson({
                fixtureId,
                playerName: firstFoulPlayer.playerName,
                foulDetails: firstFoulPlayer.foulDetails.map((x) => ({ type: x.type, value: x.value })),
              })
            );
          }
        } catch (err) {
          console.log("[outcomes-gen-debug] raw fetch failed", {
            fixtureId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      failedCount += 1;
      console.log("[outcomes-gen] fetch failed", {
        fixtureId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  ensureDir(outPath);
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf-8");

  console.log("[outcomes-gen] done", {
    wroteFixtureCount: finishedCount,
    skippedUnfinished,
    skippedNoPlayerResults,
    failedCount,
    outputFixtureIdCount: Object.keys(out).length,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

