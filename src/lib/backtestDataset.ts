/**
 * Backtest dataset: types and conversion for pre-match prediction snapshots.
 * Persistence (load/save/append) runs on the server only; this module is client-safe.
 */

import {
  MARKET_ID_PLAYER_SHOTS,
  MARKET_ID_PLAYER_SHOTS_ON_TARGET,
  MARKET_ID_PLAYER_FOULS_COMMITTED,
  MARKET_ID_PLAYER_FOULS_WON,
} from "../constants/marketIds.js";

/** Stored pre-match snapshot row. actualCount / actualOutcome filled at settlement later. */
export interface StoredBacktestRow {
  fixtureId: number;
  kickoffAt: string;
  playerId: number | null;
  playerName: string;
  marketId: number;
  marketName: string;
  line: number;
  bookmaker: string;
  odds: number;
  bookmakerProbability: number;
  rawModelProbability: number | null;
  calibratedProbability: number | null;
  edge: number | null;
  expectedMinutes: number | null;
  baseLambda: number | null;
  adjustedLambda: number | null;
  statValue: number | null;
  actualCount: number | null;
  actualOutcome: "hit" | "miss" | null;
  createdAt: string;
}

export interface BacktestDataset {
  rows: StoredBacktestRow[];
}

/** Map display name to market ID for conversion. */
const MARKET_NAME_TO_ID: Record<string, number> = {
  "Player Shots": MARKET_ID_PLAYER_SHOTS,
  "Player Shots On Target": MARKET_ID_PLAYER_SHOTS_ON_TARGET,
  "Player Fouls Committed": MARKET_ID_PLAYER_FOULS_COMMITTED,
  "Player Fouls Won": MARKET_ID_PLAYER_FOULS_WON,
};

function marketIdFromName(marketName: string): number {
  const id = MARKET_NAME_TO_ID[marketName];
  return typeof id === "number" ? id : 0;
}

function statValueFromModelInputs(
  modelInputs: { shots?: number; shotsOnTarget?: number; foulsCommitted?: number; foulsWon?: number } | undefined,
  marketId: number
): number | null {
  if (!modelInputs) return null;
  switch (marketId) {
    case MARKET_ID_PLAYER_SHOTS:
      return typeof modelInputs.shots === "number" ? modelInputs.shots : null;
    case MARKET_ID_PLAYER_SHOTS_ON_TARGET:
      return typeof modelInputs.shotsOnTarget === "number" ? modelInputs.shotsOnTarget : null;
    case MARKET_ID_PLAYER_FOULS_COMMITTED:
      return modelInputs.foulsCommitted != null ? modelInputs.foulsCommitted : null;
    case MARKET_ID_PLAYER_FOULS_WON:
      return modelInputs.foulsWon != null ? modelInputs.foulsWon : null;
    default:
      return null;
  }
}

/** Row-like shape produced by value-bet generation (minimal for conversion). */
export interface ValueBetRowLike {
  playerName: string;
  marketName: string;
  line: number;
  odds: number;
  bookmakerName: string;
  bookmakerProbability: number;
  rawModelProbability?: number | null;
  calibratedProbability?: number | null;
  modelEdge?: number | null;
  modelInputs?: {
    expectedMinutes?: number;
    lambda?: number;
    adjustedLambda?: number;
    shots?: number;
    shotsOnTarget?: number;
    foulsCommitted?: number;
    foulsWon?: number;
  } | null;
}

export interface ConvertContext {
  fixtureId: number;
  kickoffAt: string;
}

/**
 * Convert value-bet rows to stored snapshot format. Preserves values at snapshot time.
 * Use fixtureId and kickoffAt from the fixture when calling.
 */
export function convertToBacktestRows(
  rows: ValueBetRowLike[],
  context: ConvertContext
): StoredBacktestRow[] {
  const { fixtureId, kickoffAt } = context;
  const createdAt = new Date().toISOString();
  return rows.map((row) => {
    const marketId = marketIdFromName(row.marketName);
    const modelInputs = row.modelInputs ?? undefined;
    return {
      fixtureId,
      kickoffAt,
      playerId: null,
      playerName: row.playerName,
      marketId,
      marketName: row.marketName,
      line: row.line,
      bookmaker: row.bookmakerName ?? "",
      odds: row.odds,
      bookmakerProbability: row.bookmakerProbability,
      rawModelProbability: row.rawModelProbability ?? null,
      calibratedProbability: row.calibratedProbability ?? null,
      edge: row.modelEdge ?? null,
      expectedMinutes: modelInputs?.expectedMinutes ?? null,
      baseLambda: modelInputs?.lambda ?? null,
      adjustedLambda: modelInputs?.adjustedLambda ?? null,
      statValue: statValueFromModelInputs(modelInputs, marketId),
      actualCount: null,
      actualOutcome: null,
      createdAt,
    };
  });
}

/**
 * Stable uniqueness key: fixture + player + market + line + bookmaker.
 */
export function makeBacktestRowKey(row: StoredBacktestRow): string {
  const playerKey = row.playerId != null ? String(row.playerId) : row.playerName;
  return `${row.fixtureId}|${playerKey}|${row.marketId}|${row.line}|${row.bookmaker}`;
}
