/**
 * Value-bet model: confidence scoring, position/context adjustments, and validation.
 * Does NOT claim 100% accuracy — model outputs are estimates to be validated and calibrated.
 */

import { calculatePer90, probabilityOverLine, probabilityUnderLine } from "./playerPropProbability.js";
import {
  MARKET_ID_PLAYER_SHOTS,
  MARKET_ID_PLAYER_SHOTS_ON_TARGET,
  MARKET_ID_PLAYER_FOULS_COMMITTED,
  MARKET_ID_PLAYER_FOULS_WON,
} from "../constants/marketIds.js";

export type ConfidenceLevel = "low" | "medium" | "high";
/** Same as ConfidenceLevel; used for bet quality to avoid confusion with data confidence. */
export type BetQualityLevel = "low" | "medium" | "high";

/** Bounds for contextual factors so they do not explode. */
const FACTOR_MIN = 0.8;
const FACTOR_MAX = 1.2;

/** Expected minutes clamp (per match). */
const EXPECTED_MINUTES_MIN = 15;
const EXPECTED_MINUTES_MAX = 90;

/** Lambda clamp to avoid ridiculous outliers. */
const LAMBDA_MAX = 6;

/**
 * Sportmonks position_id → position adjustment multiplier.
 * Forward = 1.0, attacking/winger = 0.95, CM = 0.80, FB/WB = 0.72, CB = 0.55, GK = 0.05.
 * Unknown positions default to 0.85.
 */
const POSITION_MULTIPLIERS: Record<number, number> = {
  1: 0.05,   // Goalkeeper
  2: 0.55,   // Centre Back
  3: 0.72,   // Fullback / Wingback
  4: 0.72,   // Wingback
  5: 0.55,   // Defender
  6: 0.8,    // Defensive Midfielder
  7: 0.8,    // Central Midfielder
  8: 0.95,   // Attacking Midfielder / Winger
  9: 1.0,    // Forward / Striker
  10: 1.0,   // Striker
};

const DEFAULT_POSITION_MULTIPLIER = 0.85;

export function getPositionMultiplier(positionId: number | undefined | null): number {
  if (positionId == null || !Number.isFinite(positionId)) return DEFAULT_POSITION_MULTIPLIER;
  return POSITION_MULTIPLIERS[positionId] ?? DEFAULT_POSITION_MULTIPLIER;
}

/**
 * Expected minutes per match from season stats. Clamped to [15, 90].
 */
export function computeExpectedMinutes(minutesPlayed: number, appearances: number): number {
  if (!appearances || appearances <= 0) return EXPECTED_MINUTES_MIN;
  const perMatch = minutesPlayed / appearances;
  return Math.max(EXPECTED_MINUTES_MIN, Math.min(EXPECTED_MINUTES_MAX, perMatch));
}

/**
 * Lambda for Poisson model: rate = per90 * (expectedMinutes / 90). Clamped to [0, LAMBDA_MAX].
 */
export function lambdaFromPer90AndMinutes(per90: number, expectedMinutes: number): number {
  if (!Number.isFinite(per90) || !Number.isFinite(expectedMinutes)) return 0;
  const lambda = per90 * (expectedMinutes / 90);
  return Math.max(0, Math.min(LAMBDA_MAX, lambda));
}

/**
 * Bound a contextual factor to [FACTOR_MIN, FACTOR_MAX].
 */
export function boundFactor(value: number): number {
  return Math.max(FACTOR_MIN, Math.min(FACTOR_MAX, value));
}

/**
 * Home/away factor: home = 1.05, away = 0.95.
 */
export function homeAwayFactor(isHome: boolean): number {
  return isHome ? 1.05 : 0.95;
}

/**
 * Team attack / opponent defence factors. Placeholder when no league/team stats.
 * When data exists: teamAttackFactor = teamAvgShotsFor / leagueAvgShots, etc.
 */
export function getTeamOpponentFactors(_context: {
  teamId?: number;
  opponentId?: number;
  isHome?: boolean;
  leagueAvgShots?: number;
  teamShotsFor?: number;
  opponentShotsAllowed?: number;
}): { teamAttackFactor: number; opponentDefenceFactor: number } {
  // TODO: wire to team/league stats API when available
  return { teamAttackFactor: 1, opponentDefenceFactor: 1 };
}

/**
 * Apply position, team/opponent, and home/away to lambda. All factors bounded.
 */
export function adjustLambda(
  lambda: number,
  positionMultiplier: number,
  teamAttackFactor: number,
  opponentDefenceFactor: number,
  homeAwayFactor: number
): number {
  const t = boundFactor(teamAttackFactor);
  const o = boundFactor(opponentDefenceFactor);
  const h = boundFactor(homeAwayFactor);
  return Math.max(0, Math.min(LAMBDA_MAX, lambda * positionMultiplier * t * o * h));
}

/** Hard filter thresholds: reject rows below these. */
export const VALUE_BET_HARD_FILTER = {
  minAppearances: 5,
  minMinutesPlayed: 300,
  minExpectedMinutes: 35,
} as const;

export function shouldRejectByHardFilter(
  appearances: number,
  minutesPlayed: number,
  expectedMinutes: number
): boolean {
  return (
    appearances < VALUE_BET_HARD_FILTER.minAppearances ||
    minutesPlayed < VALUE_BET_HARD_FILTER.minMinutesPlayed ||
    expectedMinutes < VALUE_BET_HARD_FILTER.minExpectedMinutes
  );
}

/** Bookmaker sanity: min odds, max implied prob. */
export const BOOKMAKER_SANITY = {
  minOdds: 1.01,
  maxImpliedProbability: 0.98,
} as const;

export function isOddsSane(odds: number): boolean {
  return Number.isFinite(odds) && odds >= BOOKMAKER_SANITY.minOdds && odds < 1000;
}

export function bookmakerProbability(odds: number): number {
  if (!isOddsSane(odds)) return 0;
  const p = 1 / odds;
  return p <= BOOKMAKER_SANITY.maxImpliedProbability ? p : 0;
}

/** Data confidence: how trustworthy the model inputs are (appearances, minutes, starter, etc.). */
export function computeDataConfidenceScore(params: {
  appearances: number;
  minutesPlayed: number;
  expectedMinutes: number;
  confirmedStarter: boolean;
  matchedById: boolean;
  lineupConfirmed: boolean;
}): number {
  let score = 0;
  if (params.appearances >= 15) score += 25;
  else if (params.appearances >= 10) score += 15;
  else if (params.appearances >= 5) score += 5;

  if (params.minutesPlayed >= 900) score += 25;
  else if (params.minutesPlayed >= 600) score += 15;
  else if (params.minutesPlayed >= 300) score += 5;

  if (params.confirmedStarter) score += 20;
  else if (params.lineupConfirmed) score += 10;

  if (params.matchedById) score += 15;

  if (params.expectedMinutes >= 60) score += 15;
  else if (params.expectedMinutes >= 45) score += 10;
  else if (params.expectedMinutes >= 35) score += 5;

  return Math.max(0, Math.min(100, score));
}

/** @deprecated Use computeDataConfidenceScore. */
export const computeConfidenceScore = computeDataConfidenceScore;

/**
 * Map data confidence score (0–100) to label. 0–39 low, 40–69 medium, 70–100 high.
 */
export function dataConfidenceBucket(score: number): ConfidenceLevel {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

/** @deprecated Use dataConfidenceBucket. */
export const confidenceBucket = dataConfidenceBucket;

/**
 * Bet quality: how meaningful / usable the betting opportunity is (edge, probability, odds, line).
 * 0–39 low, 40–69 medium, 70–100 high.
 */
export function betQualityBucket(score: number): BetQualityLevel {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

/** Params for bet quality score (from row or built fields). */
export interface BetQualityParams {
  modelEdge?: number | null;
  calibratedProbability?: number | null;
  odds: number;
  line: number;
  marketId: number;
  dataConfidence: ConfidenceLevel;
}

/**
 * Compute bet quality score 0–100 from edge, probability, odds, line, data confidence.
 */
export function computeBetQualityScore(params: BetQualityParams): number {
  let score = 50;
  const edge = params.modelEdge ?? 0;
  const prob = params.calibratedProbability ?? 0;

  if (edge >= 0.05) score += 30;
  else if (edge >= 0.03) score += 20;
  else if (edge < 0) score -= 20;

  if (prob >= 0.08 && prob <= 0.65) score += 20;
  else if (prob < 0.02) score -= 25;

  if (params.odds >= 1.4 && params.odds <= 8) score += 15;
  else if (params.odds > 15) score -= 20;

  const line = params.line;
  const marketId = params.marketId;
  const lineReasonable =
    (marketId === MARKET_ID_PLAYER_SHOTS && line >= 0.5 && line <= 5.5) ||
    (marketId === MARKET_ID_PLAYER_SHOTS_ON_TARGET && line >= 0.5 && line <= 3.5) ||
    (marketId === MARKET_ID_PLAYER_FOULS_COMMITTED && line >= 0.5 && line <= 4.5) ||
    (marketId === MARKET_ID_PLAYER_FOULS_WON && line >= 0.5 && line <= 3.5);
  if (lineReasonable) score += 15;
  else if (
    (marketId === MARKET_ID_PLAYER_SHOTS && line > 6) ||
    (marketId === MARKET_ID_PLAYER_SHOTS_ON_TARGET && line > 4) ||
    (marketId === MARKET_ID_PLAYER_FOULS_COMMITTED && line > 5) ||
    (marketId === MARKET_ID_PLAYER_FOULS_WON && line > 4)
  )
    score -= 20;

  if (params.dataConfidence === "high") score += 10;
  else if (params.dataConfidence === "medium") score += 5;

  return Math.max(0, Math.min(100, score));
}

/** Model inputs for auditability (stored on each row). */
export interface ValueBetModelInputs {
  shots: number;
  shotsOnTarget: number;
  foulsCommitted?: number;
  foulsWon?: number;
  minutesPlayed: number;
  appearances: number;
  expectedMinutes: number;
  per90: number;
  lambda: number;
  positionMultiplier: number;
  adjustedLambda: number;
  impliedProbability: number;
  rawModelProbability: number;
  teamAttackFactor: number;
  opponentDefenceFactor: number;
  homeAwayFactor: number;
}

/** Stats shape required to compute raw model probability (e.g. from season stats). */
export interface StatsForModel {
  shots: number;
  shotsOnTarget: number;
  foulsCommitted?: number;
  foulsWon?: number;
  minutesPlayed: number;
  appearances: number;
}

/**
 * Return the relevant stat value for a given player-prop market ID.
 * Used for per-90 and probability calculation.
 */
export function getRelevantStatForMarket(
  stats: StatsForModel,
  marketId: number,
  _minutesPlayed: number
): number | null {
  switch (marketId) {
    case MARKET_ID_PLAYER_SHOTS:
      return stats.shots;
    case MARKET_ID_PLAYER_SHOTS_ON_TARGET:
      return stats.shotsOnTarget;
    case MARKET_ID_PLAYER_FOULS_COMMITTED:
      return stats.foulsCommitted ?? 0;
    case MARKET_ID_PLAYER_FOULS_WON:
      return stats.foulsWon ?? 0;
    default:
      return null;
  }
}

/**
 * Compute raw model probability (no calibration). Same formula as live UI.
 * Used by backtest and by LineupModal so results are comparable.
 */
export function computeRawModelProbability(
  stats: StatsForModel,
  marketId: number,
  line: number,
  outcome: "Over" | "Under",
  positionId?: number | null,
  isHome?: boolean
): number {
  const { minutesPlayed, appearances } = stats;
  const expectedMinutes = computeExpectedMinutes(minutesPlayed, appearances);
  const statValue = getRelevantStatForMarket(stats, marketId, minutesPlayed);
  const per90 = statValue != null ? calculatePer90(statValue, minutesPlayed) : 0;
  const lambda = lambdaFromPer90AndMinutes(per90, expectedMinutes);
  const positionMultiplier = getPositionMultiplier(positionId);
  const { teamAttackFactor, opponentDefenceFactor } = getTeamOpponentFactors({
    isHome,
  });
  const homeAway = homeAwayFactor(isHome ?? false);
  const adjustedLambda = adjustLambda(
    lambda,
    positionMultiplier,
    teamAttackFactor,
    opponentDefenceFactor,
    homeAway
  );
  return outcome === "Over"
    ? probabilityOverLine(adjustedLambda, line)
    : probabilityUnderLine(adjustedLambda, line);
}

/** Strong-bet criteria: only treat as serious candidate when all hold. */
export const STRONG_BET_EDGE_MIN = 0.03;

/** Minimum sample size in calibration bucket to treat as validated. */
export const CALIBRATION_MIN_BUCKET_SAMPLE = 30;

export function isStrongBetCandidate(row: {
  modelEdge?: number | null;
  dataConfidence?: ConfidenceLevel;
  betQuality?: BetQualityLevel;
  modelInputs?: ValueBetModelInputs;
  calibratedProbability?: number;
  calibrationBucketValid?: boolean;
}): boolean {
  const edge = row.modelEdge ?? 0;
  if (edge < STRONG_BET_EDGE_MIN) return false;
  const bq = row.betQuality ?? "low";
  if (bq === "low") return false;
  if (row.calibrationBucketValid === false) return false;
  const dataConf = row.dataConfidence ?? "low";
  if (dataConf === "low") return false;
  const inputs = row.modelInputs;
  if (inputs) {
    if (inputs.appearances < VALUE_BET_HARD_FILTER.minAppearances) return false;
    if (inputs.expectedMinutes < VALUE_BET_HARD_FILTER.minExpectedMinutes) return false;
  }
  return true;
}
