/**
 * Central market capability policy.
 *
 * Intent:
 * - Keep "supported in UI/analysis" separate from "supported for settlement/backtest".
 * - Make fouls-first workflows safe while shots/SOT settlement is not reliable.
 */

import {
  MARKET_ID_PLAYER_SHOTS,
  MARKET_ID_PLAYER_SHOTS_ON_TARGET,
  MARKET_ID_PLAYER_FOULS_COMMITTED,
  MARKET_ID_PLAYER_FOULS_WON,
} from "../constants/marketIds.js";

export type CapabilityArea = "analysis" | "builder" | "backtest" | "settlement" | "optimisation";

export interface MarketCapability {
  marketId: number;
  supportedForAnalysis: boolean;
  supportedForBuilder: boolean;
  supportedForBacktest: boolean;
  supportedForSettlement: boolean;
  supportedForOptimisation: boolean;
  /** Short dev-facing reason when disabled for settlement/backtest. */
  note?: string;
}

const CAPABILITIES: Record<number, MarketCapability> = {
  [MARKET_ID_PLAYER_FOULS_COMMITTED]: {
    marketId: MARKET_ID_PLAYER_FOULS_COMMITTED,
    supportedForAnalysis: true,
    supportedForBuilder: true,
    supportedForBacktest: true,
    supportedForSettlement: true,
    supportedForOptimisation: true,
  },
  [MARKET_ID_PLAYER_FOULS_WON]: {
    marketId: MARKET_ID_PLAYER_FOULS_WON,
    supportedForAnalysis: true,
    supportedForBuilder: true,
    supportedForBacktest: true,
    supportedForSettlement: true,
    supportedForOptimisation: true,
  },
  [MARKET_ID_PLAYER_SHOTS]: {
    marketId: MARKET_ID_PLAYER_SHOTS,
    supportedForAnalysis: true,
    supportedForBuilder: true,
    supportedForBacktest: false,
    supportedForSettlement: false,
    supportedForOptimisation: false,
    note: "Player shots not reliably available in lineup details for settlement yet",
  },
  [MARKET_ID_PLAYER_SHOTS_ON_TARGET]: {
    marketId: MARKET_ID_PLAYER_SHOTS_ON_TARGET,
    supportedForAnalysis: true,
    supportedForBuilder: true,
    supportedForBacktest: false,
    supportedForSettlement: false,
    supportedForOptimisation: false,
    note: "Player shots on target not reliably available in lineup details for settlement yet",
  },
};

export function getMarketCapability(marketId: number): MarketCapability {
  return (
    CAPABILITIES[marketId] ?? {
      marketId,
      supportedForAnalysis: true,
      supportedForBuilder: true,
      supportedForBacktest: true,
      supportedForSettlement: true,
      supportedForOptimisation: true,
    }
  );
}

export function isMarketSupportedForSettlement(marketId: number): boolean {
  return getMarketCapability(marketId).supportedForSettlement;
}

export function isMarketSupportedForBacktest(marketId: number): boolean {
  return getMarketCapability(marketId).supportedForBacktest;
}

export function isMarketSupportedForOptimisation(marketId: number): boolean {
  return getMarketCapability(marketId).supportedForOptimisation;
}

