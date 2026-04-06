/**
 * Backtesting framework for the value-bet model.
 * Compares model probability vs bookmaker probability vs actual outcome.
 * Produces calibration data so calibrated probability can replace raw in edge calculation.
 */

import {
  MARKET_ID_PLAYER_SHOTS,
  MARKET_ID_PLAYER_SHOTS_ON_TARGET,
  MARKET_ID_PLAYER_FOULS_COMMITTED,
  MARKET_ID_PLAYER_FOULS_WON,
  MARKET_ID_PLAYER_TACKLES,
} from "../constants/marketIds.js";
import {
  computeRawModelProbability,
  computeExpectedMinutes,
  computeDataConfidenceScore,
  dataConfidenceBucket,
  shouldRejectByHardFilter,
  isOddsSane,
  bookmakerProbability,
  type ConfidenceLevel,
  type StatsForModel,
} from "./valueBetModel.js";
import type { CalibrationBucket } from "./valueBetCalibration.js";
import { isMarketSupportedForBacktest } from "./marketCapabilities.js";

/** Outcome for a prop: Over or Under the line. */
export type PropOutcome = "Over" | "Under";

/** Full historical backtest row for scoring and slicing. */
export interface BacktestRow {
  fixtureId: number;
  playerId: number;
  playerName: string;
  marketId: number;
  marketName: string;
  line: number;
  outcome: PropOutcome;
  odds: number;
  bookmakerProbability: number;

  rawModelProbability: number;
  calibratedProbability?: number;
  modelEdge?: number;

  /** 1 = prop won, 0 = prop lost */
  actualResult: 0 | 1;

  appearances: number;
  minutesPlayed: number;
  expectedMinutes: number;
  dataConfidence: ConfidenceLevel;
  dataConfidenceScore: number;

  positionId?: number | null;
  isHome?: boolean;
  lineupConfirmed?: boolean;
  matchedById?: boolean;

  matchDate?: string;
  leagueName?: string;
}

/** Actual match stats for one player in one fixture (post-match). */
export interface PlayerMatchStats {
  playerId: number;
  playerName: string;
  shots: number;
  shotsOnTarget: number;
  foulsCommitted?: number;
  foulsWon?: number;
  tackles?: number;
}

/** Historical fixture outcome: actual stats per player for one match. */
export interface HistoricalFixtureOutcome {
  fixtureId: number;
  matchDate?: string;
  leagueName?: string;
  playerResults: PlayerMatchStats[];
}

/** Pre-match context: one selection (line, outcome, odds) for one player. */
export interface PreMatchSelection {
  playerId: number;
  playerName: string;
  marketId: number;
  marketName: string;
  line: number;
  outcome: PropOutcome;
  odds: number;
  /** Season stats known before the match. */
  stats: StatsForModel;
  positionId?: number | null;
  isHome?: boolean;
  lineupConfirmed?: boolean;
  matchedById?: boolean;
}

/** Pre-match context for one fixture: all selections we can backtest. */
export interface PreMatchContext {
  fixtureId: number;
  matchDate?: string;
  leagueName?: string;
  homeTeamId: number;
  awayTeamId: number;
  lineupConfirmed?: boolean;
  selections: PreMatchSelection[];
}

/**
 * Resolves whether a historical prop actually won (1) or lost (0).
 * Over X.5 hits if actual >= ceil(X.5); Under X.5 hits if actual <= floor(X.5).
 */
export function resolveHistoricalPropResult(params: {
  marketId: number;
  line: number;
  outcome: PropOutcome;
  actualShots: number;
  actualShotsOnTarget: number;
  actualFoulsCommitted: number;
  actualFoulsWon: number;
  actualTackles: number;
}): 0 | 1 {
  const {
    marketId,
    line,
    outcome,
    actualShots,
    actualShotsOnTarget,
    actualFoulsCommitted,
    actualFoulsWon,
    actualTackles,
  } = params;
  const actual =
    marketId === MARKET_ID_PLAYER_SHOTS
      ? actualShots
      : marketId === MARKET_ID_PLAYER_SHOTS_ON_TARGET
        ? actualShotsOnTarget
        : marketId === MARKET_ID_PLAYER_FOULS_COMMITTED
          ? actualFoulsCommitted
          : marketId === MARKET_ID_PLAYER_FOULS_WON
            ? actualFoulsWon
            : marketId === MARKET_ID_PLAYER_TACKLES
              ? actualTackles
              : 0;

  if (outcome === "Over") {
    const threshold = Math.ceil(line);
    return actual >= threshold ? 1 : 0;
  }
  const threshold = Math.floor(line - 0.5);
  return actual <= threshold ? 1 : 0;
}

/**
 * Generate backtest rows from pre-match contexts and historical outcomes.
 * No future information: only pre-match stats and odds, then actual result from outcome.
 */
export function generateBacktestRows(
  contexts: PreMatchContext[],
  outcomes: HistoricalFixtureOutcome[],
  getCalibratedProbability: (raw: number, bucketKey: string) => number
): BacktestRow[] {
  const outcomeByFixture = new Map<number, HistoricalFixtureOutcome>();
  for (const o of outcomes) outcomeByFixture.set(o.fixtureId, o);

  const rows: BacktestRow[] = [];
  for (const ctx of contexts) {
    const outcome = outcomeByFixture.get(ctx.fixtureId);
    const playerActuals = outcome
      ? new Map(outcome.playerResults.map((p) => [p.playerId, p]))
      : null;

    for (const sel of ctx.selections) {
      if (!isMarketSupportedForBacktest(sel.marketId)) continue;
      const appearances = sel.stats.appearances ?? 0;
      const minutesPlayed = sel.stats.minutesPlayed ?? 0;
      const expectedMinutes = computeExpectedMinutes(minutesPlayed, appearances);
      if (shouldRejectByHardFilter(appearances, minutesPlayed, expectedMinutes)) continue;
      if (!isOddsSane(sel.odds) || !Number.isFinite(sel.line)) continue;

      const bookmakerProb = bookmakerProbability(sel.odds);
      if (bookmakerProb <= 0) continue;

      const rawModelProbability = computeRawModelProbability(
        sel.stats,
        sel.marketId,
        sel.line,
        sel.outcome,
        sel.positionId,
        sel.isHome
      );

      const bucketKey = getCalibrationBucketKey(rawModelProbability);
      const calibratedProbability = getCalibratedProbability(rawModelProbability, bucketKey);

      let actualResult: 0 | 1 = 0;
      if (playerActuals) {
        const actual = playerActuals.get(sel.playerId);
        if (actual != null) {
          actualResult = resolveHistoricalPropResult({
            marketId: sel.marketId,
            line: sel.line,
            outcome: sel.outcome,
            actualShots: actual.shots,
            actualShotsOnTarget: actual.shotsOnTarget,
            actualFoulsCommitted: actual.foulsCommitted ?? 0,
            actualFoulsWon: actual.foulsWon ?? 0,
            actualTackles: actual.tackles ?? 0,
          });
        }
      }

      const dataConfidenceScore = computeDataConfidenceScore({
        appearances,
        minutesPlayed,
        expectedMinutes,
        confirmedStarter: false,
        matchedById: sel.matchedById ?? false,
        lineupConfirmed: ctx.lineupConfirmed ?? false,
      });
      const dataConfidence = dataConfidenceBucket(dataConfidenceScore);
      const modelEdge = calibratedProbability - bookmakerProb;

      rows.push({
        fixtureId: ctx.fixtureId,
        playerId: sel.playerId,
        playerName: sel.playerName,
        marketId: sel.marketId,
        marketName: sel.marketName,
        line: sel.line,
        outcome: sel.outcome,
        odds: sel.odds,
        bookmakerProbability: bookmakerProb,
        rawModelProbability,
        calibratedProbability,
        modelEdge,
        actualResult,
        appearances,
        minutesPlayed,
        expectedMinutes,
        dataConfidence,
        dataConfidenceScore,
        positionId: sel.positionId,
        isHome: sel.isHome,
        lineupConfirmed: ctx.lineupConfirmed,
        matchedById: sel.matchedById,
        matchDate: ctx.matchDate,
        leagueName: ctx.leagueName,
      });
    }
  }
  return rows;
}

/** Probability bucket key for calibration (e.g. "50-60"). */
export const CALIBRATION_BUCKETS: Array<{ key: string; min: number; max: number }> = [
  { key: "0-5", min: 0, max: 0.05 },
  { key: "5-10", min: 0.05, max: 0.1 },
  { key: "10-15", min: 0.1, max: 0.15 },
  { key: "15-20", min: 0.15, max: 0.2 },
  { key: "20-30", min: 0.2, max: 0.3 },
  { key: "30-40", min: 0.3, max: 0.4 },
  { key: "40-50", min: 0.4, max: 0.5 },
  { key: "50-60", min: 0.5, max: 0.6 },
  { key: "60-70", min: 0.6, max: 0.7 },
  { key: "70+", min: 0.7, max: 1.01 },
];

function getCalibrationBucketKey(rawProb: number): string {
  for (const b of CALIBRATION_BUCKETS) {
    if (rawProb >= b.min && rawProb < b.max) return b.key;
  }
  return "70+";
}

export interface BacktestSummary {
  totalBets: number;
  hits: number;
  hitRate: number;
  avgBookmakerProbability: number;
  avgRawModelProbability: number;
  avgCalibratedProbability: number;
  brierScoreRaw: number;
  brierScoreCalibrated: number;
  logLossRaw: number;
  logLossCalibrated: number;
  roiPositiveEdge: number;
  roiByEdgeBucket: Record<string, number>;
  roiByConfidence: Record<string, number>;
  hitRateByMarket: Record<number, number>;
  hitRateByConfidence: Record<string, number>;
  calibration: CalibrationBucket[];
}

/**
 * Brier score: (1/N) * sum((predicted - actual)^2). Lower is better.
 */
export function brierScore(rows: BacktestRow[], useCalibrated: boolean): number {
  if (rows.length === 0) return 0;
  let sum = 0;
  for (const r of rows) {
    const pred = useCalibrated ? (r.calibratedProbability ?? r.rawModelProbability) : r.rawModelProbability;
    const actual = r.actualResult;
    sum += (pred - actual) ** 2;
  }
  return sum / rows.length;
}

/**
 * Log loss. Lower is better.
 */
export function logLoss(rows: BacktestRow[], useCalibrated: boolean): number {
  if (rows.length === 0) return 0;
  const eps = 1e-15;
  let sum = 0;
  for (const r of rows) {
    const p = Math.max(eps, Math.min(1 - eps, useCalibrated ? (r.calibratedProbability ?? r.rawModelProbability) : r.rawModelProbability));
    const actual = r.actualResult;
    sum += actual * Math.log(p) + (1 - actual) * Math.log(1 - p);
  }
  return -sum / rows.length;
}

/** ROI: (total returns - total stakes) / total stakes. Bet 1 unit per selection. */
function roi(rows: BacktestRow[], oddsKey: "odds" = "odds"): number {
  if (rows.length === 0) return 0;
  let stakes = 0;
  let returns = 0;
  for (const r of rows) {
    stakes += 1;
    if (r.actualResult === 1) returns += r.odds;
  }
  return stakes > 0 ? (returns - stakes) / stakes : 0;
}

/**
 * Build full backtest summary and calibration table from rows.
 */
export function buildBacktestSummary(
  rows: BacktestRow[],
  calibrationTable: CalibrationBucket[]
): BacktestSummary {
  const total = rows.length;
  const hits = rows.filter((r) => r.actualResult === 1).length;
  const hitRate = total > 0 ? hits / total : 0;

  const avgBookmakerProbability =
    total > 0 ? rows.reduce((s, r) => s + r.bookmakerProbability, 0) / total : 0;
  const avgRawModelProbability =
    total > 0 ? rows.reduce((s, r) => s + r.rawModelProbability, 0) / total : 0;
  const avgCalibratedProbability =
    total > 0
      ? rows.reduce((s, r) => s + (r.calibratedProbability ?? r.rawModelProbability), 0) / total
      : 0;

  const positiveEdgeRows = rows.filter((r) => (r.modelEdge ?? 0) > 0);
  const roiPositiveEdge = roi(positiveEdgeRows);

  const roiByEdgeBucket: Record<string, number> = {};
  const edgeBuckets: Array<{ key: string; min: number; max: number | null }> = [
    { key: "0-0.02", min: 0, max: 0.02 },
    { key: "0.02-0.05", min: 0.02, max: 0.05 },
    { key: "0.05-0.10", min: 0.05, max: 0.1 },
    { key: "0.10+", min: 0.1, max: null },
  ];
  for (const { key, min, max } of edgeBuckets) {
    const sub = rows.filter((r) => {
      const e = r.modelEdge ?? 0;
      return e >= min && (max === null || e < max);
    });
    roiByEdgeBucket[key] = roi(sub);
  }

  const roiByConfidence: Record<string, number> = {};
  const hitRateByConfidence: Record<string, number> = {};
  for (const c of ["low", "medium", "high"] as const) {
    const sub = rows.filter((r) => r.dataConfidence === c);
    roiByConfidence[c] = roi(sub);
    hitRateByConfidence[c] = sub.length > 0 ? sub.filter((r) => r.actualResult === 1).length / sub.length : 0;
  }

  const hitRateByMarket: Record<number, number> = {};
  for (const r of rows) {
    if (!hitRateByMarket[r.marketId]) {
      const sub = rows.filter((x) => x.marketId === r.marketId);
      hitRateByMarket[r.marketId] =
        sub.length > 0 ? sub.filter((x) => x.actualResult === 1).length / sub.length : 0;
    }
  }

  return {
    totalBets: total,
    hits,
    hitRate,
    avgBookmakerProbability,
    avgRawModelProbability,
    avgCalibratedProbability,
    brierScoreRaw: brierScore(rows, false),
    brierScoreCalibrated: brierScore(rows, true),
    logLossRaw: logLoss(rows, false),
    logLossCalibrated: logLoss(rows, true),
    roiPositiveEdge,
    roiByEdgeBucket,
    roiByConfidence,
    hitRateByMarket,
    hitRateByConfidence,
    calibration: calibrationTable,
  };
}

/**
 * Build calibration table from backtest rows: for each probability bucket, compute actual hit rate.
 */
export function buildCalibrationTable(rows: BacktestRow[]): CalibrationBucket[] {
  const byBucket = new Map<string, { rawSum: number; hits: number; count: number }>();
  for (const b of CALIBRATION_BUCKETS) {
    byBucket.set(b.key, { rawSum: 0, hits: 0, count: 0 });
  }
  for (const r of rows) {
    const key = getCalibrationBucketKey(r.rawModelProbability);
    const entry = byBucket.get(key);
    if (entry) {
      entry.rawSum += r.rawModelProbability;
      entry.hits += r.actualResult;
      entry.count += 1;
    }
  }
  return CALIBRATION_BUCKETS.map((b) => {
    const e = byBucket.get(b.key)!;
    const hitRate = e.count > 0 ? e.hits / e.count : 0;
    const avgRaw = e.count > 0 ? e.rawSum / e.count : 0;
    return {
      bucketKey: b.key,
      minProb: b.min,
      maxProb: b.max,
      count: e.count,
      hitRate,
      avgRawModelProbability: avgRaw,
    };
  });
}

/**
 * Run backtest: generate rows from contexts + outcomes, build calibration table, then recompute calibrated prob and summary.
 */
export function runBacktest(
  contexts: PreMatchContext[],
  outcomes: HistoricalFixtureOutcome[]
): { rows: BacktestRow[]; summary: BacktestSummary; calibrationTable: CalibrationBucket[] } {
  const rowsPass1 = generateBacktestRows(contexts, outcomes, (raw, _) => raw);
  const calibrationTable = buildCalibrationTable(rowsPass1);

  const getCalibrated = (raw: number, bucketKey: string): number => {
    const b = calibrationTable.find((c) => c.bucketKey === bucketKey);
    if (b && b.count >= 30) return b.hitRate;
    return raw;
  };

  const rows = generateBacktestRows(contexts, outcomes, getCalibrated);
  const summary = buildBacktestSummary(rows, calibrationTable);
  return { rows, summary, calibrationTable };
}

/** Probability buckets for 0.5-line calibration evaluation (model prob vs actual hit rate). */
export const LOW_LINE_PROB_BUCKETS: Array<{ key: string; min: number; max: number }> = [
  { key: "0.00–0.20", min: 0, max: 0.2 },
  { key: "0.20–0.40", min: 0.2, max: 0.4 },
  { key: "0.40–0.60", min: 0.4, max: 0.6 },
  { key: "0.60–0.80", min: 0.6, max: 0.8 },
  { key: "0.80–1.00", min: 0.8, max: 1.01 },
];

/** Per-market evaluation for 0.5 lines only: model vs actual outcomes (truth-based). */
export interface LowLineMarketEval {
  marketId: number;
  marketName: string;
  rowCount: number;
  averageModelProbability: number;
  actualHitRate: number;
  averageBookmakerProbability: number;
  calibrationGap: number;
}

/** Per–probability-bucket evaluation for 0.5 lines (optional diagnostic). */
export interface LowLineProbBucketEval {
  bucketKey: string;
  rowCount: number;
  averageModelProbability: number;
  actualHitRate: number;
  averageBookmakerProbability: number;
  calibrationGap: number;
}

/** Full 0.5-line evaluation summary: by market and optionally by probability bucket. */
export interface LowLineEvalSummary {
  totalRowCount: number;
  byMarket: Record<number, LowLineMarketEval>;
  byProbabilityBucket: Record<string, LowLineProbBucketEval>;
}

function getLowLineProbBucketKey(prob: number): string {
  for (const b of LOW_LINE_PROB_BUCKETS) {
    if (prob >= b.min && prob < b.max) return b.key;
  }
  return "0.80–1.00";
}

/**
 * Build truth-based evaluation for 0.5 lines only.
 * Compares model probability to actual hit rate (not bookmaker). Use to validate whether
 * the model is systematically underestimating "at least one" outcomes.
 */
export function buildLowLineEvaluation(rows: BacktestRow[]): LowLineEvalSummary | null {
  const lowRows = rows.filter((r) => r.line === 0.5);
  if (lowRows.length === 0) return null;

  const byMarket: Record<number, LowLineMarketEval> = {};
  const marketIds = [...new Set(lowRows.map((r) => r.marketId))];
  for (const marketId of marketIds) {
    const sub = lowRows.filter((r) => r.marketId === marketId);
    const n = sub.length;
    const hits = sub.filter((r) => r.actualResult === 1).length;
    const avgModel =
      n > 0
        ? sub.reduce((s, r) => s + (r.calibratedProbability ?? r.rawModelProbability), 0) / n
        : 0;
    const avgBook = n > 0 ? sub.reduce((s, r) => s + r.bookmakerProbability, 0) / n : 0;
    const actualHitRate = n > 0 ? hits / n : 0;
    const marketName = sub[0]?.marketName ?? `Market ${marketId}`;
    byMarket[marketId] = {
      marketId,
      marketName,
      rowCount: n,
      averageModelProbability: avgModel,
      actualHitRate,
      averageBookmakerProbability: avgBook,
      calibrationGap: actualHitRate - avgModel,
    };
  }

  const byProbabilityBucket: Record<string, LowLineProbBucketEval> = {};
  for (const b of LOW_LINE_PROB_BUCKETS) {
    const sub = lowRows.filter((r) => {
      const p = r.calibratedProbability ?? r.rawModelProbability;
      return p >= b.min && p < b.max;
    });
    const n = sub.length;
    if (n === 0) continue;
    const hits = sub.filter((r) => r.actualResult === 1).length;
    const avgModel =
      n > 0
        ? sub.reduce((s, r) => s + (r.calibratedProbability ?? r.rawModelProbability), 0) / n
        : 0;
    const avgBook = n > 0 ? sub.reduce((s, r) => s + r.bookmakerProbability, 0) / n : 0;
    const actualHitRate = n > 0 ? hits / n : 0;
    byProbabilityBucket[b.key] = {
      bucketKey: b.key,
      rowCount: n,
      averageModelProbability: avgModel,
      actualHitRate,
      averageBookmakerProbability: avgBook,
      calibrationGap: actualHitRate - avgModel,
    };
  }

  return {
    totalRowCount: lowRows.length,
    byMarket,
    byProbabilityBucket,
  };
}
