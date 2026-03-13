/**
 * Value-bet analysis layer for normalised odds from the backend.
 * Pure helpers: no API calls, no React, no UI.
 */

import {
  CORE_MARKET_IDS,
  MARKET_ID_MATCH_RESULTS,
} from "../constants/marketIds";

export type NormalisedSelection = {
  label: string;
  value: string | number | null;
  odds: number | null;
};

export type NormalisedMarket = {
  marketId: number;
  marketName: string;
  selections: NormalisedSelection[];
};

export type NormalisedBookmaker = {
  bookmakerId: number;
  bookmakerName: string;
  markets: NormalisedMarket[];
};

export type NormalisedOddsResponse = {
  fixtureId: number;
  bookmakers: NormalisedBookmaker[];
};

export function calculateImpliedProbability(odds: number): number {
  if (typeof odds !== "number" || !Number.isFinite(odds) || odds <= 0) return 0;
  return 1 / odds;
}

export function calculateEdge(modelProbability: number, impliedProbability: number): number {
  return modelProbability - impliedProbability;
}

export function decimalToPercentage(value: number, decimals = 2): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const pct = value * 100;
  const factor = 10 ** decimals;
  return Math.round(pct * factor) / factor;
}

/** Compact serialisable summary for console debugging. Does not mutate input. */
export function summariseNormalisedOdds(oddsResponse: NormalisedOddsResponse): {
  fixtureId: number;
  bookmakerCount: number;
  bookmakers: Array<{
    bookmakerId: number;
    bookmakerName: string;
    markets: Array<{
      marketId: number;
      marketName: string;
      selections: Array<{ label: string; odds: number }>;
    }>;
  }>;
} {
  const bookmakers = (oddsResponse.bookmakers ?? []).map((b) => ({
    bookmakerId: b.bookmakerId,
    bookmakerName: b.bookmakerName,
    markets: (b.markets ?? []).map((m) => ({
      marketId: m.marketId,
      marketName: m.marketName,
      selections: (m.selections ?? []).map((s) => ({
        label: s.label,
        odds: typeof s.odds === "number" && Number.isFinite(s.odds) ? s.odds : 0,
      })),
    })),
  }));
  return {
    fixtureId: oddsResponse.fixtureId ?? 0,
    bookmakerCount: bookmakers.length,
    bookmakers,
  };
}

export type BestPrice = {
  bookmakerId: number;
  bookmakerName: string;
  odds: number;
};

export type BestOddsSummary = {
  matchResults: {
    Home?: BestPrice;
    Draw?: BestPrice;
    Away?: BestPrice;
  };
  btts: {
    Yes?: BestPrice;
    No?: BestPrice;
  };
};

/** Market ids this module handles. From constants/marketIds (core markets only). */
function isSupportedMarketId(marketId: number): boolean {
  return (CORE_MARKET_IDS as readonly number[]).includes(marketId);
}

function normaliseOutcomeLabel(label: string): string {
  return (label ?? "").trim().toLowerCase();
}

function isValidOdds(odds: unknown): odds is number {
  return typeof odds === "number" && Number.isFinite(odds) && odds > 0;
}

/** Inspect core markets (Match Results, BTTS, Match Goals); return best (highest) decimal odds per outcome. */
export function findBestOddsByOutcome(oddsResponse: NormalisedOddsResponse): BestOddsSummary {
  const result: BestOddsSummary = { matchResults: {}, btts: {} };

  for (const b of oddsResponse.bookmakers ?? []) {
    for (const m of b.markets ?? []) {
      if (!isSupportedMarketId(m.marketId)) continue;
      const isMR = m.marketId === MARKET_ID_MATCH_RESULTS;
      for (const s of m.selections ?? []) {
        const odds = (s as { odds?: number | null }).odds;
        if (!isValidOdds(odds)) continue;
        const key = normaliseOutcomeLabel(s.label);
        if (isMR) {
          if (key === "home" && (!result.matchResults.Home || result.matchResults.Home.odds < odds)) {
            result.matchResults.Home = { bookmakerId: b.bookmakerId, bookmakerName: b.bookmakerName, odds };
          } else if (key === "draw" && (!result.matchResults.Draw || result.matchResults.Draw.odds < odds)) {
            result.matchResults.Draw = { bookmakerId: b.bookmakerId, bookmakerName: b.bookmakerName, odds };
          } else if (key === "away" && (!result.matchResults.Away || result.matchResults.Away.odds < odds)) {
            result.matchResults.Away = { bookmakerId: b.bookmakerId, bookmakerName: b.bookmakerName, odds };
          }
        } else {
          if (key === "yes" && (!result.btts.Yes || result.btts.Yes.odds < odds)) {
            result.btts.Yes = { bookmakerId: b.bookmakerId, bookmakerName: b.bookmakerName, odds };
          } else if (key === "no" && (!result.btts.No || result.btts.No.odds < odds)) {
            result.btts.No = { bookmakerId: b.bookmakerId, bookmakerName: b.bookmakerName, odds };
          }
        }
      }
    }
  }
  return result;
}

export type MatchResultProbabilities = {
  Home: number;
  Draw: number;
  Away: number;
};

export type BTTSProbabilities = {
  Yes: number;
  No: number;
};

export type ModelProbabilities = {
  matchResults?: MatchResultProbabilities;
  btts?: BTTSProbabilities;
};

export type ValueBet = {
  fixtureId: number;
  bookmakerId: number;
  bookmakerName: string;
  marketId: number;
  marketName: string;
  outcome: string;
  odds: number;
  modelProbability: number;
  impliedProbability: number;
  edge: number;
  modelProbabilityPct: number;
  impliedProbabilityPct: number;
  edgePct: number;
};

/** Only core markets (Match Results, BTTS, Match Goals); edge > threshold. */
export function findValueBets(
  oddsResponse: NormalisedOddsResponse,
  modelProbabilities: ModelProbabilities,
  edgeThreshold = 0.05
): ValueBet[] {
  const out: ValueBet[] = [];
  const fixtureId = oddsResponse.fixtureId ?? 0;

  for (const b of oddsResponse.bookmakers ?? []) {
    for (const m of b.markets ?? []) {
      if (!isSupportedMarketId(m.marketId)) continue;
      const isMR = m.marketId === MARKET_ID_MATCH_RESULTS;
      const modelProbs = isMR ? modelProbabilities.matchResults : modelProbabilities.btts;
      if (!modelProbs) continue;

      for (const s of m.selections ?? []) {
        const odds = (s as { odds?: number | null }).odds;
        if (!isValidOdds(odds)) continue;
        const key = normaliseOutcomeLabel(s.label);
        let modelP = 0;
        let outcomeLabel = s.label;
        if (isMR) {
          if (key === "home") {
            modelP = (modelProbs as MatchResultProbabilities).Home ?? 0;
            outcomeLabel = "Home";
          } else if (key === "draw") {
            modelP = (modelProbs as MatchResultProbabilities).Draw ?? 0;
            outcomeLabel = "Draw";
          } else if (key === "away") {
            modelP = (modelProbs as MatchResultProbabilities).Away ?? 0;
            outcomeLabel = "Away";
          } else continue;
        } else {
          if (key === "yes") {
            modelP = (modelProbs as BTTSProbabilities).Yes ?? 0;
            outcomeLabel = "Yes";
          } else if (key === "no") {
            modelP = (modelProbs as BTTSProbabilities).No ?? 0;
            outcomeLabel = "No";
          } else continue;
        }
        const impliedP = calculateImpliedProbability(odds);
        const edge = calculateEdge(modelP, impliedP);
        if (edge <= edgeThreshold) continue;
        out.push({
          fixtureId,
          bookmakerId: b.bookmakerId,
          bookmakerName: b.bookmakerName,
          marketId: m.marketId,
          marketName: m.marketName ?? (m.marketId === MARKET_ID_MATCH_RESULTS ? "Match Results" : "BTTS"),
          outcome: outcomeLabel,
          odds,
          modelProbability: modelP,
          impliedProbability: impliedP,
          edge,
          modelProbabilityPct: decimalToPercentage(modelP),
          impliedProbabilityPct: decimalToPercentage(impliedP),
          edgePct: decimalToPercentage(edge),
        });
      }
    }
  }
  return out;
}

/** Highest edge first; does not mutate original. */
export function sortValueBetsByEdge(valueBets: ValueBet[]): ValueBet[] {
  return [...valueBets].sort((a, b) => b.edge - a.edge);
}

/*
  Usage examples (dev / tests):

  // After loading odds from /api/fixtures/:id/odds:
  const summary = summariseNormalisedOdds(response);
  console.log("[valueBet] summary", summary);

  const best = findBestOddsByOutcome(response);
  console.log("[valueBet] best odds", best);

  const modelProbs: ModelProbabilities = {
    matchResults: { Home: 0.45, Draw: 0.28, Away: 0.27 },
    btts: { Yes: 0.52, No: 0.48 },
  };
  const valueBets = findValueBets(response, modelProbs, 0.05);
  const sorted = sortValueBetsByEdge(valueBets);
  console.log("[valueBet] value bets", sorted);
*/
