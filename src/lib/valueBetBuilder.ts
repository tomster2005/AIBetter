/**
 * Build Value Bets: filter candidates, score legs, generate multi-leg combos (2–5 legs) near target odds.
 * Version 1: no correlation; reuses value-bet pipeline outputs and fixture odds team props.
 * Includes market-family overlap protection and model-based Alternative Corners.
 */

import { isOddsSane, isSensiblePlayerPropLine } from "./valueBetModel.js";
import { probabilityOverLine, probabilityUnderLine } from "./playerPropProbability.js";
import {
  MARKET_ID_ALTERNATIVE_CORNERS,
  MARKET_ID_ALTERNATIVE_TOTAL_GOALS,
  MARKET_ID_BTTS,
  MARKET_ID_HOME_TEAM_GOALS,
  MARKET_ID_MATCH_GOALS,
  MARKET_ID_MATCH_RESULTS,
  MARKET_ID_AWAY_TEAM_GOALS,
  MARKET_ID_PLAYER_FOULS_COMMITTED,
  MARKET_ID_PLAYER_FOULS_WON,
  MARKET_ID_PLAYER_SHOTS,
  MARKET_ID_PLAYER_SHOTS_ON_TARGET,
  MARKET_ID_PLAYER_TACKLES,
  MARKET_ID_TEAM_TOTAL_GOALS,
  MARKET_ID_TOTAL_CORNERS,
} from "../constants/marketIds.js";
import type { HeadToHeadFixtureContext } from "../types/headToHeadContext.js";
import type { FixtureTeamFormContext } from "../types/teamRecentFormContext.js";
import type { TeamSeasonGoalLineStats } from "../types/teamSeasonStats.js";
import {
  applyFixtureTeamFormToLegScore,
  applyThinRecentFormPenalty,
  buildTeamPropExplanationLines,
  isFormContextStrong,
  logTeamLegExclusion,
  shouldIncludeNonCornerTeamLegInPool,
} from "./teamPropReasoning.js";
import { getCompressedNormalizedScore } from "./modelScoreNormalization.js";

/** Min expected minutes for player legs (align with value bet hard filter). */
const MIN_EXPECTED_MINUTES = 45;
/** Min edge to include a player leg (positive only). Superseded for builder pool by `isValidBuilderCandidate`. */
const MIN_EDGE = 0.001;

/** Builder pool: drop junk prices unless model edge justifies them. */
const BUILDER_ODDS_HARD_REJECT = 1.15;
const BUILDER_LOW_ODDS_BAND = 1.25;
const BUILDER_LOW_ODDS_MIN_EDGE = 0.05;
const BUILDER_MIN_MODEL_EDGE = 0.02;
/** Selections without a numeric model edge (e.g. some team legs) must meet this minimum odds. */
const BUILDER_ODDS_MIN_WITHOUT_MODEL_EDGE = 1.25;
/** Recursion: do not pad combos that already have 2+ legs with ultra-short prices. */
const BUILDER_FILLER_ODDS_MAX = 1.2;
const BUILDER_RANK_LOW_ODDS_LINE = 1.25;
const BUILDER_RANK_LOW_ODDS_PENALTY_EACH = 0.01;

/**
 * Whether a leg should enter the combo builder pool.
 * Strong edge can justify moderately short odds; without edge data, require clearer prices.
 */
export function isValidBuilderCandidate(odds: number, edge: number | null | undefined): boolean {
  if (!Number.isFinite(odds)) return false;
  if (odds < BUILDER_ODDS_HARD_REJECT) return false;

  const e = Number.isFinite(edge as number) ? (edge as number) : null;
  if (e == null) {
    return odds >= BUILDER_ODDS_MIN_WITHOUT_MODEL_EDGE;
  }
  if (e < BUILDER_MIN_MODEL_EDGE) return false;
  if (odds < BUILDER_LOW_ODDS_BAND && e < BUILDER_LOW_ODDS_MIN_EDGE) return false;
  return true;
}
/** Max odds per leg to avoid longshot junk. */
const MAX_ODDS_PER_LEG = 15;
/** Minimum combo EV (model prob − implied prob) to keep; ~+1% edge. If none qualify, unfiltered list is used. */
const MIN_COMBO_EV = 0.01;
/** Build-combo search: min/max legs (cap avoids combinatorial blow-up). */
const COMBO_MIN_LEGS = 2;
const COMBO_MAX_LEGS_CAP = 5;
/** Drop completed combos whose odds exceed this multiple of target (inefficient vs target). */
const COMBO_MAX_ODDS_MULTIPLIER = 1.2;
/** Cap full Kelly fraction at 5% of bankroll before applying fractional Kelly. */
const KELLY_FULL_CAP = 0.05;
/** Fractional Kelly: half of capped full Kelly. */
const KELLY_FRACTIONAL = 0.5;

/** Fouls + tackles: used for combo ranking boost and team-leg coherence (physical / midfield duels). */
const PHYSICAL_PLAYER_PROP_CATS = ["foulsCommitted", "foulsWon", "tackles"] as const;

function isPhysicalPlayerPropCategory(cat: string | null | undefined): boolean {
  return cat != null && (PHYSICAL_PLAYER_PROP_CATS as readonly string[]).includes(cat);
}

/** One leg in a combo (player or team). */
export interface BuildLeg {
  id: string;
  type: "player" | "team";
  /** Optional identifiers used for lightweight correlation penalties. */
  playerId?: string;
  /** Sportmonks numeric player id when known — persisted to Bet History for settlement. */
  sportmonksPlayerId?: number;
  teamId?: string;
  marketId?: number;
  legRole?: "core" | "supporting" | "filler";
  playerQuality?: {
    playerTier: "weak" | "ok" | "strong" | "elite";
    qualityScore: number;
    sampleReliability: number;
    minutesReliability: number;
    recencyScore: number;
    roleConsistencyScore: number;
    marketSpecificScore: number;
    projectedRateStrength: number;
    weakSignalFlags: {
      lowSample: boolean;
      unstableMinutes: boolean;
      weakRecency: boolean;
    };
    explanationSourceFlags: {
      hasRecentValues: boolean;
      hasSample: boolean;
      stableMinutes: boolean;
    };
    /** Recent-app hit rate vs line (only when sample met builder min games). */
    recentFormHitRate?: number;
    recentHitsCount?: number;
    recentHitsSampleSize?: number;
  };
  /** Used to reject combos with multiple legs from the same family (e.g. same player+market or multiple corner lines). */
  marketFamily: string;
  label: string;
  marketName: string;
  line: number;
  outcome: "Over" | "Under" | "Home" | "Draw" | "Away" | "Yes" | "No";
  odds: number;
  bookmakerName: string;
  score: number;
  dataConfidenceScore?: number;
  betQualityScore?: number;
  edge?: number;
  probability?: number;
  reason?: string;
  playerName?: string;
  h2hContextLine?: string;
  opponentContextLine?: string;
  /** Optional extra stat row in combo explanations only (real data; never fabricated). */
  opponentStatSeries?: { label: string; values: number[] };
}

/** Optional team corner stats per match (for/against). When provided, used to compute fixture expected corners. */
export interface FixtureCornersContext {
  homeCornersFor: number;
  homeCornersAgainst: number;
  awayCornersFor: number;
  awayCornersAgainst: number;
}

/** Minimal starter info for matchup inference (from lineup). */
export interface LineupStarterInfo {
  playerName: string;
  positionId?: number;
}

/** Lineup context for matchup-aware boosts (home/away starters with position). */
export interface LineupContext {
  homeStarters: LineupStarterInfo[];
  awayStarters: LineupStarterInfo[];
}

/** Structured explanation for a combo (factual, stats-based). */
export interface ComboExplanation {
  lines: string[];
}

/** Optional evidence for evidence-style explanations. Only used when available; no placeholders. */
export interface BuildEvidenceContext {
  /** Recent match-by-match stat values per player and market (e.g. last 5 starts). Key: normalized "playerName|marketCategory". */
  playerRecentStats?: Array<{
    playerName: string;
    marketCategory: "shots" | "shotsOnTarget" | "foulsCommitted" | "foulsWon" | "tackles";
    per90: number;
    recentValues: number[];
  }>;
  /** Recent head-to-head total corners (e.g. last 4 meetings). */
  cornersH2hTotals?: number[];
  /** Team names for corners sentence: "X average ... and Y average ...". */
  homeTeamName?: string;
  awayTeamName?: string;
  /** Player H2H stats from last meeting (per-player, per-market). */
  playerH2hStats?: Array<{
    playerName: string;
    marketCategory: "shots" | "shotsOnTarget" | "foulsCommitted" | "foulsWon" | "tackles";
    values: number[];
    startingAt?: string[];
  }>;
}

/** Row shape needed to build evidence (subset of ValueBetRow). */
export interface RowForEvidence {
  playerName: string;
  marketName: string;
  modelInputs?: { per90?: number };
}

/** Per-player recent match values by normalized name (from API or outcomes). Only real values; no placeholders. */
export interface RecentStatsByNormalizedName {
  [normalizedName: string]: {
    shots?: number[];
    shotsOnTarget?: number[];
    foulsCommitted?: number[];
    foulsWon?: number[];
    tackles?: number[];
  };
}

/**
 * Build evidence context from value-bet rows and fixture. Uses per90 from modelInputs.
 * recentValues are filled from recentStatsByNormalizedName when provided (real match-by-match only).
 */
export function buildEvidenceContextFromRows(
  rows: RowForEvidence[],
  fixture: { homeTeam?: { name?: string }; awayTeam?: { name?: string } } | null,
  recentStatsByNormalizedName?: RecentStatsByNormalizedName | null
): BuildEvidenceContext {
  const seen = new Set<string>();
  const playerRecentStats: BuildEvidenceContext["playerRecentStats"] = [];
  for (const r of rows) {
    const cat = getMarketCategory(r.marketName);
    if (cat == null) continue;
    const per90 = r.modelInputs?.per90;
    if (typeof per90 !== "number" || !Number.isFinite(per90)) continue;
    const norm = normalizePlayerNameForMatch(r.playerName);
    const key = `${norm}|${cat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const playerStats = recentStatsByNormalizedName?.[norm];
    const recentValues =
      (cat === "shots" && playerStats?.shots) ||
      (cat === "shotsOnTarget" && playerStats?.shotsOnTarget) ||
      (cat === "foulsCommitted" && playerStats?.foulsCommitted) ||
      (cat === "foulsWon" && playerStats?.foulsWon) ||
      (cat === "tackles" && playerStats?.tackles);
    const useRecent =
      Array.isArray(recentValues) && recentValues.length > 0 && recentValues.every((v) => typeof v === "number" && Number.isFinite(v));
    if (import.meta.env?.DEV) {
      if (useRecent) {
        console.log("[assign recent]", {
          player: r.playerName,
          marketCategory: cat,
          valuesLength: (recentValues as number[]).length,
        });
      } else if (Array.isArray(recentValues) && recentValues.length > 0) {
        console.log("[assign recent skipped]", {
          player: r.playerName,
          marketCategory: cat,
          values: recentValues,
        });
      }
    }
    playerRecentStats.push({
      playerName: r.playerName,
      marketCategory: cat,
      per90,
      recentValues: useRecent ? recentValues : [],
    });
  }
  const out: BuildEvidenceContext = {
    ...(playerRecentStats.length > 0 && { playerRecentStats }),
    ...(fixture?.homeTeam?.name && { homeTeamName: fixture.homeTeam.name }),
    ...(fixture?.awayTeam?.name && { awayTeamName: fixture.awayTeam.name }),
  };
  return out;
}

/** One suggested combo. */
export interface ComboScoreBreakdown {
  multiPlayerBase: number;
  fillerPenalty: number;
  fillerAltGoalsPenalty: number;
  scenarioCohesionBonus: number;
  onePlayerAllFillerPenalty: number;
  supportSignal: number;
  qualitySignals: number;
  playerCoherence: number;
  eliteCoherenceBonus: number;
  tierComboShaping: number;
  total: number;
}

export interface BuildCombo {
  legs: BuildLeg[];
  /** Deterministic content identity for combo-level dedupe/sorting/debug. */
  fingerprint?: string;
  combinedOdds: number;
  distanceFromTarget: number;
  comboScore: number;
  comboEdge: number;
  adjustedComboEdge: number;
  /** comboEdge minus low-odds penalty; used for ranking (prefers fewer junk short prices). */
  rankingComboEdge: number;
  combinedProb: number;
  impliedProb: number;
  comboEV: number;
  comboEVPercent: number;
  /** Suggested stake as fraction of bankroll (½ Kelly after full-Kelly cap). */
  kellyStakePct: number;
  normalizedScore?: number;
  scoreBreakdown?: ComboScoreBreakdown;
  /** Short factual "Why this build" lines derived from stats. */
  explanation?: ComboExplanation;
}

function legFingerprintToken(leg: BuildLeg): string {
  const line = Number.isFinite(leg.line) ? leg.line.toFixed(2) : "na";
  const odds = Number.isFinite(leg.odds) ? leg.odds.toFixed(4) : "na";
  const player = normalizePlayerNameForMatch(leg.playerName ?? "");
  const label = String(leg.label ?? "").trim().toLowerCase();
  return [
    leg.type,
    String(leg.marketId),
    leg.marketFamily,
    String(leg.outcome ?? ""),
    line,
    odds,
    String(leg.playerId ?? ""),
    String(leg.sportmonksPlayerId ?? ""),
    player,
    label,
    String(leg.bookmakerName ?? "").trim().toLowerCase(),
  ].join("|");
}

function comboFingerprintFromLegs(legs: BuildLeg[]): string {
  return legs.map(legFingerprintToken).slice().sort().join("||");
}

/** Player row shape used by the builder (subset of ValueBetRow). modelInputs extended for matchup boost. */
export interface PlayerCandidateInput {
  playerName: string;
  marketName: string;
  line: number;
  outcome: "Over" | "Under";
  odds: number;
  bookmakerName: string;
  modelEdge?: number;
  modelInputs?: {
    expectedMinutes?: number;
    foulsCommitted?: number;
    foulsWon?: number;
    per90?: number;
    [key: string]: unknown;
  };
  betQualityScore?: number;
  dataConfidenceScore?: number;
  isStrongBet?: boolean;
  /** When present, stored on history legs for reliable player stat matching after FT. */
  sportmonksPlayerId?: number;
}

/** Normalised odds bookmaker shape (from fixture odds API). */
export interface OddsBookmakerInput {
  bookmakerId: number;
  bookmakerName: string;
  markets: Array<{
    marketId: number;
    marketName: string;
    selections: Array< { label: string; value: string | number | null; odds: number | null }>;
  }>;
}

/** Team market IDs we allow into the builder (explicit allowlist; small and easy to tune). */
const BUILD_TEAM_MARKET_IDS = new Set<number>([
  MARKET_ID_ALTERNATIVE_CORNERS,      // 69
  MARKET_ID_MATCH_RESULTS,           // 1
  MARKET_ID_BTTS,                    // 14
  MARKET_ID_MATCH_GOALS,             // 80
  MARKET_ID_ALTERNATIVE_TOTAL_GOALS, // 81
]);

/** Only one corner leg per combo; all Alternative Corners lines share this family. */
const CORNERS_MARKET_FAMILY = "team:alternative-corners";

/** Match-level goals O/U lines (excludes team total goals and corners). */
const MATCH_TOTAL_GOALS_LINE_MIN = 0.5;
const MATCH_TOTAL_GOALS_LINE_MAX = 6.5;

function isSensibleMatchTotalGoalsLine(line: number): boolean {
  return Number.isFinite(line) && line >= MATCH_TOTAL_GOALS_LINE_MIN && line <= MATCH_TOTAL_GOALS_LINE_MAX;
}

/**
 * True for Sportmonks 80/81 or any other provider ID whose market name is match goals O/U (not team totals).
 * Reasoning/scoring keys off `marketFamily === "team:match-goals"` for all of these.
 */
function isMatchTotalGoalsOuMarket(marketId: number, marketName: string): boolean {
  if (marketId === MARKET_ID_TEAM_TOTAL_GOALS) return false;
  if (marketId === MARKET_ID_HOME_TEAM_GOALS || marketId === MARKET_ID_AWAY_TEAM_GOALS) return false;
  if (marketId === MARKET_ID_ALTERNATIVE_CORNERS || marketId === MARKET_ID_TOTAL_CORNERS) return false;
  if (marketId === MARKET_ID_MATCH_GOALS || marketId === MARKET_ID_ALTERNATIVE_TOTAL_GOALS) return true;

  const n = (marketName || "").toLowerCase();
  if (!n.includes("goal")) return false;
  if (n.includes("corner")) return false;
  if (/\bteam\s+total\b/.test(n) || /\bteam\s+goals\b/.test(n)) return false;
  if (/\b(home|away)\b.*\b(total\s+)?goals?\b/.test(n)) return false;
  if (/\bgoals?\b.*\b(home|away)\b/.test(n)) return false;
  return true;
}

/** Match total goals team leg (main, alternative, or name-detected). Legacy legs may still use team:alternative-total-goals. */
function isTeamMatchTotalGoalsLeg(leg: BuildLeg): boolean {
  if (leg.type !== "team") return false;
  if (leg.marketFamily === "team:match-goals" || leg.marketFamily === "team:alternative-total-goals") return true;
  return isMatchTotalGoalsOuMarket(leg.marketId, leg.marketName);
}

/** Default fixture total corners when no team stats (league-typical). */
const DEFAULT_FIXTURE_EXPECTED_CORNERS = 10.5;

/** Max corner legs to pass into combo builder (best-rated only). */
const MAX_CORNER_LEGS = 5;
/** Max legs per non-corners team market to consider (best-rated only). */
const MAX_TEAM_LEGS_PER_MARKET = 6;

/** H2H context: minimum sample size to apply scoring. */
const MIN_H2H_SAMPLE_SIZE = 4;

const BUILDER_DEBUG_VERBOSE =
  import.meta.env?.DEV &&
  (import.meta.env?.VITE_BUILDER_DEBUG_VERBOSE === "1" ||
    import.meta.env?.VITE_BUILDER_DEBUG_VERBOSE === "true");

/** Prefer Over corners by default; Under must clear a higher bar to be included. */
const MIN_EDGE_OVER_CORNERS = 0;
/** Under corners: require clearly stronger edge to be eligible (conservative). */
const MIN_EDGE_UNDER_CORNERS = 0.035;
/** Score penalty for Under corners so they only beat Over lines when genuinely stronger. */
const UNDER_CORNERS_SCORE_PENALTY = 18;

/** Matchup boost: max bonus so we don't rescue poor-value legs. */
const FOUL_MATCHUP_MAX_BONUS = 12;
/** Min per90 rate to consider "meaningful" for fouls (matchup support). */
const FOUL_RATE_MIN_PER90 = 0.4;
/** Min expected minutes to apply matchup boost. */
const MATCHUP_MIN_EXPECTED_MINUTES = 45;

/** Position groups for direct matchup (Sportmonks position_id). Flank: FB/WB vs winger; central: DM/CM vs AM. */
const FLANK_DEFENDER_IDS = new Set([2, 3, 4, 5]);
const WINGER_ATTACKER_IDS = new Set([7, 8]);
const CENTRAL_MID_IDS = new Set([6, 7]);
const ATTACKING_MID_IDS = new Set([8]);

/** Shot matchup: attacking roles that support shot volume (striker, winger, AM). */
const ATTACKING_SHOT_ROLE_IDS = new Set([8, 9, 10]); // AM/Winger, Forward, Striker
/** Attacking wing-back (modest shot boost). */
const WINGBACK_IDS = new Set([3, 4]);
/** Shot matchup boost cap (additive, don't rescue poor legs). */
const SHOT_MATCHUP_MAX_BONUS = 10;
/** Min shots per90 to consider "meaningful" for shot boost. */
const SHOTS_MIN_PER90 = 0.8;
/** Min shots on target per90 for SOT boost. */
const SOT_MIN_PER90 = 0.25;

/** Recent-form gate: last N apps used for hit rate / variance (not the Poisson model). */
const PLAYER_PROP_RECENT_WINDOW = 10;
const PLAYER_PROP_MIN_RECENT_GAMES = 6;
const PLAYER_PROP_MIN_HIT_RATE = 0.5;
const PLAYER_PROP_PER90_OVER_MIN_RATIO = 0.7;
const PLAYER_PROP_HIGH_VARIANCE_THRESHOLD = 2.25;
const PLAYER_PROP_SPIKY_HIT_RATE_MAX = 0.7;
const PLAYER_PROP_STRONG_HIT_RATE = 0.7;
const PLAYER_PROP_STRONG_HIT_RATE_SCORE_BONUS = 6;

/** Minimum quality bars for player prop candidates (tighten for reliability). */
const BUILDER_MIN_DATA_CONFIDENCE_SCORE = 45;
const BUILDER_MIN_BET_QUALITY_SCORE = 45;

/**
 * Coarse role for prop-market sanity checks (Sportmonks `position_id`).
 * Unknown / missing → null (do not block on position).
 */
export type PlayerPropFilterPosition = "FWD" | "AM" | "MID" | "DEF" | "GK";

export function positionRoleFromSportmonksId(positionId: number | undefined | null): PlayerPropFilterPosition | null {
  if (positionId == null || !Number.isFinite(positionId)) return null;
  const id = Math.trunc(positionId);
  if (id === 1) return "GK";
  if (id === 9 || id === 10) return "FWD";
  if (id === 8) return "AM";
  if (id === 6 || id === 7) return "MID";
  if (id === 2 || id === 3 || id === 4 || id === 5) return "DEF";
  return null;
}

function positionLabelFromSportmonksId(positionId: number | undefined | null): string {
  if (positionId == null || !Number.isFinite(positionId)) return "";
  const id = Math.trunc(positionId);
  if (id === 1) return "Goalkeeper";
  if (id === 2) return "Centre Back";
  if (id === 3) return "Fullback";
  if (id === 4) return "Wingback";
  if (id === 5) return "Defender";
  if (id === 6) return "Defensive Midfielder";
  if (id === 7) return "Central Midfielder";
  if (id === 8) return "Attacking Midfielder";
  if (id === 9) return "Forward";
  if (id === 10) return "Striker";
  return "";
}

/**
 * Block unrealistic player+market pairs before they enter the builder pool.
 * e.g. forwards / AMs rarely carry tackle or fouls-committed volume vs defenders.
 */
export function isValidMarketForPosition(
  position: PlayerPropFilterPosition | null | undefined,
  marketId: number
): boolean {
  if (position == null) return true;
  if (position === "FWD" || position === "AM") {
    if (marketId === MARKET_ID_PLAYER_TACKLES || marketId === MARKET_ID_PLAYER_FOULS_COMMITTED) return false;
  }
  return true;
}

function positionRoleForPlayerFromLineup(playerName: string, lineupContext: LineupContext | null | undefined): PlayerPropFilterPosition | null {
  if (lineupContext == null) return null;
  const key = normalizePlayerNameForMatch(playerName);
  for (const p of lineupContext.homeStarters) {
    if (normalizePlayerNameForMatch(p.playerName) === key) return positionRoleFromSportmonksId(p.positionId);
  }
  for (const p of lineupContext.awayStarters) {
    if (normalizePlayerNameForMatch(p.playerName) === key) return positionRoleFromSportmonksId(p.positionId);
  }
  return null;
}

function getPlayerRecentGamesWindow(
  playerName: string,
  cat: ValueBetPlayerMarketCategory,
  evidenceStats: BuildEvidenceContext["playerRecentStats"],
  maxGames: number
): number[] {
  if (!evidenceStats?.length) return [];
  const key = `${normalizePlayerNameForMatch(playerName)}|${cat}`;
  const found = evidenceStats.find(
    (e) => `${normalizePlayerNameForMatch(e.playerName)}|${e.marketCategory}` === key
  );
  if (found == null || !Array.isArray(found.recentValues)) return [];
  return found.recentValues
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .slice(-maxGames);
}

function countOutcomeHits(recentGames: number[], line: number, outcome: "Over" | "Under"): number {
  if (outcome === "Over") return recentGames.filter((v) => v >= line).length;
  const maxWhole = Math.floor(line);
  return recentGames.filter((v) => v <= maxWhole).length;
}

function calculateVariance(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
}

function isVeryHighRecentVariance(recentGames: number[]): boolean {
  if (recentGames.length < 2) return false;
  const variance = calculateVariance(recentGames);
  if (variance >= PLAYER_PROP_HIGH_VARIANCE_THRESHOLD) return true;
  const mean = recentGames.reduce((s, v) => s + v, 0) / recentGames.length;
  if (mean >= 0.75 && variance / mean >= 1.8) return true;
  return false;
}

type PlayerPropRecentValidation =
  | { accepted: true; hitRate: number; recentN: number; hits: number }
  | { accepted: false; hitRate: number; recentN: number; reason: string };

function validatePlayerPropRecentEvidence(
  r: PlayerCandidateInput,
  cat: ValueBetPlayerMarketCategory,
  evidenceContext: BuildEvidenceContext | null | undefined,
  per90ForLine: number
): PlayerPropRecentValidation {
  const recentGames = getPlayerRecentGamesWindow(r.playerName, cat, evidenceContext?.playerRecentStats, PLAYER_PROP_RECENT_WINDOW);

  if (recentGames.length < PLAYER_PROP_MIN_RECENT_GAMES) {
    return { accepted: false, hitRate: 0, recentN: recentGames.length, reason: "minSample" };
  }

  const hits = countOutcomeHits(recentGames, r.line, r.outcome);
  const hitRate = hits / recentGames.length;

  if (hitRate < PLAYER_PROP_MIN_HIT_RATE) {
    return { accepted: false, hitRate, recentN: recentGames.length, reason: "hitRate" };
  }

  if (r.outcome === "Over" && per90ForLine < r.line * PLAYER_PROP_PER90_OVER_MIN_RATIO) {
    return { accepted: false, hitRate, recentN: recentGames.length, reason: "per90Floor" };
  }

  if (isVeryHighRecentVariance(recentGames) && hitRate < PLAYER_PROP_SPIKY_HIT_RATE_MAX) {
    return { accepted: false, hitRate, recentN: recentGames.length, reason: "spiky" };
  }

  return { accepted: true, hitRate, recentN: recentGames.length, hits };
}

/** Player-prop market buckets used for scoring, evidence, and line bounds. */
export type ValueBetPlayerMarketCategory = "shots" | "shotsOnTarget" | "foulsCommitted" | "foulsWon" | "tackles";

function getMarketCategory(marketName: string): ValueBetPlayerMarketCategory | null {
  const n = (marketName || "").toLowerCase();
  if (n.includes("shots on target")) return "shotsOnTarget";
  if (n.includes("fouls committed")) return "foulsCommitted";
  if (n.includes("fouls won")) return "foulsWon";
  if (n.includes("player tackles") || (n.includes("tackles") && !n.includes("foul"))) return "tackles";
  if (n.includes("shots") && !n.includes("on target")) return "shots";
  return null;
}

function marketIdFromPlayerCategory(cat: ValueBetPlayerMarketCategory): number {
  switch (cat) {
    case "shotsOnTarget":
      return MARKET_ID_PLAYER_SHOTS_ON_TARGET;
    case "shots":
      return MARKET_ID_PLAYER_SHOTS;
    case "foulsCommitted":
      return MARKET_ID_PLAYER_FOULS_COMMITTED;
    case "foulsWon":
      return MARKET_ID_PLAYER_FOULS_WON;
    case "tackles":
      return MARKET_ID_PLAYER_TACKLES;
    default:
      return 0;
  }
}

/** Parse line from "Over 2.5" / "Under 10.5" style. */
function parseOverUnderLine(label: string): number | null {
  const num = parseFloat((label || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(num) ? num : null;
}

function isOverLabel(label: string): boolean {
  const lower = (label || "").toLowerCase();
  return (lower.includes("over") && !lower.includes("under")) || lower === "over";
}

function parseMatchResultOutcome(label: string): "Home" | "Draw" | "Away" | null {
  const lower = (label || "").trim().toLowerCase();
  if (!lower) return null;
  if (lower === "home" || lower === "1") return "Home";
  if (lower === "draw" || lower === "x") return "Draw";
  if (lower === "away" || lower === "2") return "Away";
  return null;
}

function parseBttsOutcome(label: string): "Yes" | "No" | null {
  const lower = (label || "").trim().toLowerCase();
  if (lower === "yes" || lower === "y") return "Yes";
  if (lower === "no" || lower === "n") return "No";
  return null;
}

function normalizePlayerNameForMatch(name: string): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Diversity tuning (builder-local). Keep small and easy to tweak. */
const DIVERSITY_INTERNAL_MULTIPLIER = 6;
const DIVERSITY_PLAYER_REUSE_PENALTY = 10;
// Encourage variation in combo shape (player-heavy vs player-light) after quality tie-breaking.
const DIVERSITY_PLAYER_LEGCOUNT_REUSE_PENALTY = 6;
const DIVERSITY_CORNERS_REUSE_PENALTY = 8;
const DIVERSITY_TEAM_GOALS_REUSE_PENALTY = 14;
// Diversity should mostly break ties, not promote clearly worse combos.
// Only consider candidates within this raw-score window of the best remaining combo.
const DIVERSITY_TIE_WINDOW_SCORE = 10;
// Soft cap: try not to have corners in nearly every returned combo.
// Applied as a strong penalty once we reach the cap (unless we run out of non-corner options).
const DIVERSITY_MAX_CORNERS_SHARE = 0.6;
const DIVERSITY_OVER_CORNERS_CAP_PENALTY = 40;
// Prefer spreading across player market categories (shots vs SOT vs fouls, etc.) when quality is similar.
const DIVERSITY_MARKET_CATEGORY_REUSE_PENALTY = 4;

/**
 * Central scoring config for tunability/calibration.
 * Intentionally mirrors current behaviour; future optimisation can adjust these values only.
 */
const SCORING_CONFIG = {
  playerTier: {
    weakPenalty: -7,
    okBonus: 1,
    strongBonus: 7,
    eliteBonus: 14,
    thresholds: {
      weak: {
        minQualityScore: 45,
        minSampleReliability: 0.35,
        minMinutesReliability: 0.35,
        minRecencyScore: 0.4,
        minProjectedRateStrength: 0.5,
      },
      strong: {
        minQualityScore: 66,
        minSampleReliability: 0.5,
        minMinutesReliability: 0.55,
        minRecencyScore: 0.5,
        minProjectedRateStrength: 0.62,
      },
      elite: {
        minQualityScore: 82,
        minSampleReliability: 0.7,
        minMinutesReliability: 0.72,
        minRecencyScore: 0.66,
        minProjectedRateStrength: 0.78,
      },
    },
  },
  weakSignalPenalties: {
    lowSample: 4,
    lowMinutes: 4,
    lowRecency: 3,
    lowSampleThreshold: 0.42,
    lowMinutesThreshold: 0.5,
    lowRecencyThreshold: 0.45,
  },
  projectedRateStrength: {
    veryHighThreshold: 0.9,
    highThreshold: 0.78,
    mediumThreshold: 0.65,
    lowThreshold: 0.5,
    veryHighBonus: 8,
    highBonus: 5,
    mediumBonus: 2,
    lowPenalty: 5,
  },
  playerQualityAggregation: {
    qualityScoreMultiplier: 0.7,
    marketSpecificOffsetMultiplier: 22,
    qualityBlend: {
      marketSpecific: 0.4,
      edge: 0.25,
      roleConsistency: 0.15,
      dataConfidence: 0.1,
      betQuality: 0.1,
    },
    marketSpecificWeights: {
      shots: { projectedRate: 0.35, recency: 0.2, minutes: 0.25, sample: 0.2 },
      shotsOnTarget: { projectedRate: 0.3, recency: 0.3, minutes: 0.2, sample: 0.2 },
      foulsCommitted: { projectedRate: 0.25, recency: 0.15, minutes: 0.3, sample: 0.3 },
      foulsWon: { projectedRate: 0.25, recency: 0.25, minutes: 0.25, sample: 0.25 },
      tackles: { projectedRate: 0.25, recency: 0.2, minutes: 0.3, sample: 0.25 },
    },
  },
  comboQuality: {
    onePlayerWithAnyTeamPenalty: 6,
    oneLowMarginalPenalty: 5,
    twoLowMarginalPenalty: 8,
    onePlayerFillerNoAdditivePenalty: 8,
    multiTeamNotAllHighConfidencePenalty: 9,
    multiTeamAllHighConfidencePenalty: 2,
    playerLedNoFillerBonus: 8,
    playerLedAdditiveBonus: 4,
    playerLedNoLowMarginalBonus: 3,
    playerOnlyProtectionBonus: 4,
    mixedSingleTeamLegBonus: 7,
    tokenTeamLegPenalty: 6,
    tokenLowMarginalExtraPenalty: 3,
  },
  playerCoherence: {
    sameTeamBaseBonus: 3,
    sameTeamTripleBonus: 3,
    attackingShotsSotBonus: 4,
    attackingMultiBonus: 2,
    defensiveClusterBonus: 2,
    randomSpreadPenalty: 4,
    bands: {
      veryStrongMin: 11,
      strongMin: 7,
      decentMin: 3,
      negativeMax: -2,
      veryStrongScore: 12,
      strongScore: 8,
      decentScore: 4,
      negativeScore: -3,
    },
  },
  combo: {
    multiPlayerBasePerLeg: 3,
    multiPlayerBaseCap: 8,
    fillerPenaltyOne: 4,
    fillerPenaltyTwoPlus: 8,
    singleCoreTwoPlusFillerPenalty: 10,
    fillerAltGoalsPenalty: 6,
    scenarioCohesionBonus: 7,
    onePlayerAllFillerPenalty: 12,
    supportingTeamPerLegBonus: 3,
    supportingTeamBonusCap: 10,
    unsupportedTeamPerLegPenalty: 3,
    additiveTeamLegBonus: 2,
    lowMarginalTeamLegPenalty: 4,
    eliteComboBonus: 8,
    multiEliteBonus: 6,
    weakLegPenaltyPerLeg: 5,
    flatComboPenalty: 6,
    eliteCoherenceBonus: 6,
    multiEliteCoherenceBonus: 4,
  },
} as const;

function comboMarketFamilySignature(c: BuildCombo): string {
  // Ignore exact line/label differences; marketFamily already collapses alternative corners lines.
  return c.legs
    .map((l) => l.marketFamily)
    .slice()
    .sort()
    .join("||");
}

function comboLegIdentitySignature(c: BuildCombo): string {
  // Strict dedupe: same player/team legs with same line/outcome should collapse to one.
  return c.legs
    .map((l) => [
      l.type,
      l.marketFamily,
      l.playerName ?? "",
      l.playerId ?? "",
      l.teamId ?? "",
      Number.isFinite(l.line) ? l.line.toFixed(3) : "",
      l.outcome,
    ].join("|"))
    .slice()
    .sort()
    .join("||");
}

function comboHasCorners(c: BuildCombo): boolean {
  return c.legs.some((l) => l.marketFamily === CORNERS_MARKET_FAMILY);
}

function comboPlayerKeys(c: BuildCombo): string[] {
  const out: string[] = [];
  for (const l of c.legs) {
    if (l.type !== "player") continue;
    if (!l.playerName) continue;
    out.push(normalizePlayerNameForMatch(l.playerName));
  }
  return out;
}

function comboMarketCategories(c: BuildCombo): string[] {
  const cats: string[] = [];
  for (const l of c.legs) {
    if (l.marketFamily === CORNERS_MARKET_FAMILY) {
      cats.push("corners");
      continue;
    }
    if (l.type === "player") {
      const cat = getMarketCategory(l.marketName);
      cats.push(cat ?? "playerOther");
      continue;
    }
    if (normaliseGoalsTotalLeg(l)) {
      cats.push("teamGoalsTotal");
      continue;
    }
    if (l.marketFamily === "team:btts") {
      cats.push("teamBtts");
      continue;
    }
    if (l.marketFamily === "team:match-results") {
      cats.push("teamResult");
      continue;
    }
    cats.push("teamOther");
  }
  return cats;
}

function selectDiverseTopCombos(
  combos: BuildCombo[],
  maxOut: number
): { selected: BuildCombo[]; nearDuplicatesRemoved: number } {
  if (combos.length <= maxOut) return { selected: combos, nearDuplicatesRemoved: 0 };

  // 1) Remove near-duplicates: keep best per market-family signature.
  // This specifically collapses "same legs except corners line" variants because all Alternative Corners share one marketFamily.
  const bestBySig = new Map<string, BuildCombo>();
  for (const c of combos) {
    const sig = comboMarketFamilySignature(c);
    const prev = bestBySig.get(sig);
    if (
      !prev ||
      c.comboScore > prev.comboScore ||
      (c.comboScore === prev.comboScore && (c.fingerprint ?? "") < (prev.fingerprint ?? ""))
    ) {
      bestBySig.set(sig, c);
    }
  }
  const deduped = Array.from(bestBySig.values()).sort((a, b) => {
    if (a.comboScore !== b.comboScore) return b.comboScore - a.comboScore;
    return (a.fingerprint ?? "").localeCompare(b.fingerprint ?? "");
  });
  const nearDuplicatesRemoved = combos.length - deduped.length;

  // 2) Greedy diversity selection: only use diversity to break ties among similarly strong combos.
  // We pick iteratively from the "best remaining" neighborhood and apply small penalties for repetition.
  const selected: BuildCombo[] = [];
  const playerUse = new Map<string, number>();
  const playerLegCountUse = new Map<number, number>();
  let cornersUsed = 0;
  const marketUse = new Map<string, number>();

  const maxCornersAllowed = Math.max(1, Math.round(maxOut * DIVERSITY_MAX_CORNERS_SHARE));

  while (selected.length < maxOut && deduped.length > 0) {
    const bestRaw = deduped[0]!.comboScore;
    const candidateIdxs: number[] = [];
    for (let i = 0; i < deduped.length; i++) {
      if (bestRaw - deduped[i]!.comboScore > DIVERSITY_TIE_WINDOW_SCORE) break;
      candidateIdxs.push(i);
    }
    // If we're out of tie-window candidates (shouldn't happen), fall back to top raw.
    if (candidateIdxs.length === 0) candidateIdxs.push(0);

    let bestIdx = candidateIdxs[0]!;
    let bestAdjusted = -Infinity;
    for (const i of candidateIdxs) {
      const c = deduped[i]!;
      const players = comboPlayerKeys(c);
      const cats = comboMarketCategories(c);
      let penalty = 0;

      for (const p of players) penalty += (playerUse.get(p) ?? 0) * DIVERSITY_PLAYER_REUSE_PENALTY;
      const playerLegCount = c.legs.filter((l) => l.type === "player").length;
      penalty += (playerLegCountUse.get(playerLegCount) ?? 0) * DIVERSITY_PLAYER_LEGCOUNT_REUSE_PENALTY;
      for (const cat of cats) {
        const reuse = marketUse.get(cat) ?? 0;
        if (cat === "teamGoalsTotal") {
          penalty += reuse * DIVERSITY_TEAM_GOALS_REUSE_PENALTY;
        } else {
          penalty += reuse * DIVERSITY_MARKET_CATEGORY_REUSE_PENALTY;
        }
      }

      if (comboHasCorners(c)) {
        penalty += cornersUsed * DIVERSITY_CORNERS_REUSE_PENALTY;
        // Soft cap corners dominance: once we hit the cap, strongly prefer non-corners options (when available in tie window).
        if (cornersUsed >= maxCornersAllowed) penalty += DIVERSITY_OVER_CORNERS_CAP_PENALTY;
      }

      const adjusted = c.comboScore - penalty;
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIdx = i;
      }
    }

    const pick = deduped.splice(bestIdx, 1)[0]!;
    selected.push(pick);
    for (const p of comboPlayerKeys(pick)) playerUse.set(p, (playerUse.get(p) ?? 0) + 1);
    const pickPlayerLegCount = pick.legs.filter((l) => l.type === "player").length;
    playerLegCountUse.set(pickPlayerLegCount, (playerLegCountUse.get(pickPlayerLegCount) ?? 0) + 1);
    if (comboHasCorners(pick)) cornersUsed += 1;
    for (const cat of comboMarketCategories(pick)) marketUse.set(cat, (marketUse.get(cat) ?? 0) + 1);
  }

  return { selected, nearDuplicatesRemoved };
}

type ComboSanityRejectReason =
  | "multipleGoalsTotals"
  | "narrowGoalWindow"
  | "redundantImpliedMarket"
  | "redundantImpliedMarketUnder"
  | "contradictoryImplication"
  | "duplicateBtts"
  | "duplicateResult";

type TeamLegImplication =
  | { kind: "minGoals"; value: number }
  | { kind: "maxGoals"; value: number }
  | { kind: "btts"; value: boolean }
  | { kind: "result"; value: "home" | "draw" | "away" };

type NormalisedGoalsTotalLeg = { type: "goalsTotal"; direction: "over" | "under"; line: number; label: string };

function normaliseGoalsTotalLeg(leg: BuildLeg): NormalisedGoalsTotalLeg | null {
  // IMPORTANT: do not rely on marketFamily/outcome/line — these can vary.
  // Derive direction + line from label, defensively, for all Sportmonks formats we surface.
  if (leg.type !== "team") return null;
  const label = String(leg.label ?? "").trim();
  if (!label) return null;
  const lower = label.toLowerCase();

  // Heuristic guard so we don't accidentally treat corners as goals.
  // Accept: "Over/Under Goals ...", "Alternative Goals ...", etc.
  if (!lower.includes("goal")) return null;
  if (lower.includes("corner")) return null;

  // Direction: take the LAST standalone "over"/"under" token in the label.
  // This handles "Over/Under Goals 2.5 Over" (contains both words) correctly.
  const dirMatches = Array.from(lower.matchAll(/\b(over|under)\b/g));
  const last = dirMatches.length > 0 ? dirMatches[dirMatches.length - 1] : null;
  const direction = last?.[1] === "over" ? "over" : last?.[1] === "under" ? "under" : null;
  if (!direction) return null;

  // Line: first decimal number (e.g. 2.5) found in label.
  const m = label.match(/(\d+(?:\.\d+)?)/);
  const line = m ? parseFloat(m[1]) : NaN;
  if (!Number.isFinite(line) || line <= 0) return null;

  if (BUILDER_DEBUG_VERBOSE) {
    console.log("[normaliseGoals]", { label, parsedLine: line, parsedDirection: direction });
  }

  return { type: "goalsTotal", direction, line, label };
}

function parseBttsFromLabel(label: string): boolean | null {
  const lower = (label || "").toLowerCase();
  if (!lower.includes("btts") && !lower.includes("both teams to score")) return null;
  const yes = /\b(yes|y)\b/.test(lower);
  const no = /\b(no|n)\b/.test(lower);
  if (yes && !no) return true;
  if (no && !yes) return false;
  return null;
}

function parseResultFromLabel(label: string): "home" | "draw" | "away" | null {
  const lower = (label || "").toLowerCase();
  // Typical builder labels: "Match Results Home" / "Match Results Draw" / "Match Results Away"
  if (/\bhome\b/.test(lower)) return "home";
  if (/\bdraw\b/.test(lower) || /\blevel\b/.test(lower)) return "draw";
  if (/\baway\b/.test(lower)) return "away";
  return null;
}

function getTeamLegImplications(leg: BuildLeg): TeamLegImplication[] {
  if (leg.type !== "team") return [];
  const out: TeamLegImplication[] = [];

  const goals = normaliseGoalsTotalLeg(leg);
  if (goals) {
    if (goals.direction === "over") {
      // Over 0.5 => minGoals 1; Over 1.5 => 2; Over 2.5 => 3...
      out.push({ kind: "minGoals", value: Math.round(goals.line + 0.5) });
    } else {
      // Under 3.5 => maxGoals 3; Under 2.5 => 2...
      out.push({ kind: "maxGoals", value: Math.floor(goals.line) });
    }
    return out;
  }

  // BTTS (Yes/No)
  const btts =
    leg.marketFamily === "team:btts"
      ? leg.outcome === "Yes"
        ? true
        : leg.outcome === "No"
          ? false
          : parseBttsFromLabel(leg.label)
      : parseBttsFromLabel(leg.label);
  if (btts != null) {
    out.push({ kind: "btts", value: btts });
    if (btts === true) {
      // BTTS yes implies at least 2 goals.
      out.push({ kind: "minGoals", value: 2 });
    }
    return out;
  }

  // Result (Home/Draw/Away)
  const res =
    leg.marketFamily === "team:match-results"
      ? leg.outcome === "Home"
        ? "home"
        : leg.outcome === "Draw"
          ? "draw"
          : leg.outcome === "Away"
            ? "away"
            : parseResultFromLabel(leg.label)
      : parseResultFromLabel(leg.label);
  if (res) {
    out.push({ kind: "result", value: res });
  }

  return out;
}

function getComboTeamImplications(combo: BuildCombo): TeamLegImplication[] {
  const out: TeamLegImplication[] = [];
  for (const leg of combo.legs) {
    out.push(...getTeamLegImplications(leg));
  }
  return out;
}

function getComboSanityRejectReason(combo: BuildCombo): ComboSanityRejectReason | null {
  // Rule 0 — Extremely narrow over/under goal windows are almost always padding/artifact.
  if (hasNarrowGoalWindow(combo)) return "narrowGoalWindow";

  // Rule 1 — Multiple goals-total team legs.
  // Keep the guard strict against redundant ladders, but allow coherent Over+Under windows.
  const goalsTotalLegs = combo.legs.map(normaliseGoalsTotalLeg).filter((x): x is NormalisedGoalsTotalLeg => x != null);
  if (goalsTotalLegs.length >= 3) return "multipleGoalsTotals";
  if (goalsTotalLegs.length === 2) {
    const dirCounts = goalsTotalLegs.reduce(
      (acc, g) => {
        acc[g.direction] += 1;
        return acc;
      },
      { over: 0, under: 0 }
    );
    // Over+Over and Under+Under are usually ladder padding => reject.
    if (dirCounts.over === 2 || dirCounts.under === 2) return "multipleGoalsTotals";

    // Over+Under: allow if not a narrow/implied contradiction case.
    const overs = goalsTotalLegs.filter((g) => g.direction === "over").map((g) => g.line);
    const unders = goalsTotalLegs.filter((g) => g.direction === "under").map((g) => g.line);
    const maxOver = Math.max(...overs);
    const minUnder = Math.min(...unders);
    const width = minUnder - maxOver;
    // If the window is narrow (<=1 goal), treat as a redundant/strained stack.
    if (Number.isFinite(width) && width <= 1.0001) return "multipleGoalsTotals";
  }

  const impl = getComboTeamImplications(combo);

  // Rule 4 — Duplicate BTTS
  const bttsCount = impl.filter((i) => i.kind === "btts").length;
  if (bttsCount >= 2) return "duplicateBtts";

  // Rule 5 — Duplicate result
  const resultCount = impl.filter((i) => i.kind === "result").length;
  if (resultCount >= 2) return "duplicateResult";

  // Aggregate goal constraints.
  const minGoals = impl.filter((i): i is Extract<TeamLegImplication, { kind: "minGoals" }> => i.kind === "minGoals").map((i) => i.value);
  const maxGoals = impl.filter((i): i is Extract<TeamLegImplication, { kind: "maxGoals" }> => i.kind === "maxGoals").map((i) => i.value);
  const minGoal = minGoals.length ? Math.max(...minGoals) : null;
  const maxGoal = maxGoals.length ? Math.min(...maxGoals) : null;

  // Rule 3 — Contradictory goal constraints.
  if (minGoal != null && maxGoal != null && minGoal > maxGoal) return "contradictoryImplication";

  // Rule 2 — Redundant implied market: BTTS Yes + low over-goals.
  // "low over-goals" = any explicit minGoals <= 2 from a goals-total leg.
  const hasBttsYes = impl.some((i) => i.kind === "btts" && i.value === true);
  if (hasBttsYes) {
    const goalsNorm = combo.legs.map(normaliseGoalsTotalLeg).filter((x): x is NormalisedGoalsTotalLeg => x != null);
    const overs = goalsNorm.filter((g) => g.direction === "over");
    const unders = goalsNorm.filter((g) => g.direction === "under");

    // Reject low-to-mid Over totals only when it’s the only goals-total direction present.
    // This avoids over-blocking coherent Over+Under windows.
    // BTTS Yes implies at least 2 total goals:
    // - Over 0.5/1.5/2.5 are highly correlated (reject)
    // - Over 3.5+ is less correlated (allow)
    if (overs.length === 1 && unders.length === 0 && overs[0]!.line <= 2.5) return "redundantImpliedMarket";

    // Symmetric redundancy: BTTS Yes correlates with low Under totals.
    // Apply only when Under is the only goals-total direction present.
    const hasLowUnderGoalsTotal = unders.length === 1 && overs.length === 0 && unders[0]!.line <= 3.5;
    if (hasLowUnderGoalsTotal) return "redundantImpliedMarketUnder";
  }

  return null;
}

function isComboSensible(combo: BuildCombo): boolean {
  return getComboSanityRejectReason(combo) == null;
}

function hasNarrowGoalWindow(combo: BuildCombo): boolean {
  const goals = combo.legs.map(normaliseGoalsTotalLeg).filter((x): x is NormalisedGoalsTotalLeg => x != null);
  if (goals.length < 2) return false;
  const overs = goals.filter((g) => g.direction === "over").map((g) => g.line);
  const unders = goals.filter((g) => g.direction === "under").map((g) => g.line);
  if (overs.length === 0 || unders.length === 0) return false;
  const maxOver = Math.max(...overs);
  const minUnder = Math.min(...unders);
  const width = minUnder - maxOver;
  return Number.isFinite(width) && width <= 1.0001;
}

/** Score how well an opponent position matches our player's position (flank vs flank, central vs central). */
function positionMatchScore(ourPositionId: number | undefined, theirPositionId: number | undefined): number {
  if (ourPositionId == null || theirPositionId == null) return 0;
  const usFlank = FLANK_DEFENDER_IDS.has(ourPositionId);
  const themWinger = WINGER_ATTACKER_IDS.has(theirPositionId);
  const usWinger = WINGER_ATTACKER_IDS.has(ourPositionId);
  const themFlank = FLANK_DEFENDER_IDS.has(theirPositionId);
  if (usFlank && themWinger) return 2; // strong flank foul matchup
  if (usWinger && themFlank) return 2;
  const usCentral = CENTRAL_MID_IDS.has(ourPositionId) || ATTACKING_MID_IDS.has(ourPositionId);
  const themCentral = CENTRAL_MID_IDS.has(theirPositionId) || ATTACKING_MID_IDS.has(theirPositionId);
  if (usCentral && themCentral) return 1; // central / role matchup
  return 0;
}

/** Infer likely direct opponent from lineup (by position). Returns opponent starter info or null. */
function getLikelyOpponent(
  playerName: string,
  side: "home" | "away",
  lineup: LineupContext
): LineupStarterInfo | null {
  const ourStarters = side === "home" ? lineup.homeStarters : lineup.awayStarters;
  const oppStarters = side === "home" ? lineup.awayStarters : lineup.homeStarters;
  const key = normalizePlayerNameForMatch(playerName);
  const player = ourStarters.find((p) => normalizePlayerNameForMatch(p.playerName) === key);
  if (!player || oppStarters.length === 0) return null;
  let best: LineupStarterInfo | null = null;
  let bestScore = 0;
  for (const opp of oppStarters) {
    const score = positionMatchScore(player.positionId, opp.positionId);
    if (score > bestScore) {
      bestScore = score;
      best = opp;
    }
  }
  return best;
}

/** Get fouls won per90 for a player from any row that has it (Fouls Won market, modelInputs.per90). */
function getFoulsWonPer90FromRows(playerName: string, rows: PlayerCandidateInput[]): number | null {
  const key = normalizePlayerNameForMatch(playerName);
  for (const r of rows) {
    if (normalizePlayerNameForMatch(r.playerName) !== key) continue;
    const n = r.marketName?.toLowerCase();
    if (n?.includes("fouls won") && r.modelInputs != null) {
      const per90 = (r.modelInputs as { per90?: number }).per90;
      if (typeof per90 === "number" && per90 >= 0) return per90;
    }
  }
  return null;
}

/** Get fouls committed per90 for a player from any row that has it. */
function getFoulsCommittedPer90FromRows(playerName: string, rows: PlayerCandidateInput[]): number | null {
  const key = normalizePlayerNameForMatch(playerName);
  for (const r of rows) {
    if (normalizePlayerNameForMatch(r.playerName) !== key) continue;
    const n = r.marketName?.toLowerCase();
    if (n?.includes("fouls committed") && r.modelInputs != null) {
      const per90 = (r.modelInputs as { per90?: number }).per90;
      if (typeof per90 === "number" && per90 >= 0) return per90;
    }
  }
  return null;
}

/** Get shots per90 for a player from any row that has it (Player Shots market). */
function getShotsPer90FromRows(playerName: string, rows: PlayerCandidateInput[]): number | null {
  const key = normalizePlayerNameForMatch(playerName);
  for (const r of rows) {
    if (normalizePlayerNameForMatch(r.playerName) !== key) continue;
    const n = r.marketName?.toLowerCase();
    if (n?.includes("shots") && !n?.includes("on target") && r.modelInputs != null) {
      const per90 = (r.modelInputs as { per90?: number }).per90;
      if (typeof per90 === "number" && per90 >= 0) return per90;
    }
  }
  return null;
}

/** Get shots on target per90 for a player from any row that has it. */
function getShotsOnTargetPer90FromRows(playerName: string, rows: PlayerCandidateInput[]): number | null {
  const key = normalizePlayerNameForMatch(playerName);
  for (const r of rows) {
    if (normalizePlayerNameForMatch(r.playerName) !== key) continue;
    const n = r.marketName?.toLowerCase();
    if (n?.includes("shots on target") && r.modelInputs != null) {
      const per90 = (r.modelInputs as { per90?: number }).per90;
      if (typeof per90 === "number" && per90 >= 0) return per90;
    }
  }
  return null;
}

/** Get tackles per90 from any row for this player (Player Tackles market). */
function getTacklesPer90FromRows(playerName: string, rows: PlayerCandidateInput[]): number | null {
  const key = normalizePlayerNameForMatch(playerName);
  for (const r of rows) {
    if (normalizePlayerNameForMatch(r.playerName) !== key) continue;
    const n = r.marketName?.toLowerCase();
    if ((n?.includes("player tackles") || (n?.includes("tackles") && !n?.includes("foul"))) && r.modelInputs != null) {
      const per90 = (r.modelInputs as { per90?: number }).per90;
      if (typeof per90 === "number" && per90 >= 0) return per90;
    }
  }
  return null;
}

/** Apply foul matchup boost to player legs (in-place). Only boosts when matchup supports and leg already has solid base. */
function applyFoulMatchupBoost(
  legs: BuildLeg[],
  playerRows: PlayerCandidateInput[],
  lineupContext: LineupContext | null
): void {
  if (lineupContext == null) return;
  const homeNames = new Set(lineupContext.homeStarters.map((p) => normalizePlayerNameForMatch(p.playerName)));
  for (const leg of legs) {
    if (leg.type !== "player" || !leg.playerName) continue;
    const cat = getMarketCategory(leg.marketName);
    if (cat !== "foulsCommitted" && cat !== "foulsWon") continue;
    const side: "home" | "away" = homeNames.has(normalizePlayerNameForMatch(leg.playerName)) ? "home" : "away";
    const opponent = getLikelyOpponent(leg.playerName, side, lineupContext);
    if (opponent == null) continue;
    const ourExpMin =
      (playerRows.find((r) => normalizePlayerNameForMatch(r.playerName) === normalizePlayerNameForMatch(leg.playerName!))?.modelInputs as { expectedMinutes?: number } | undefined)
        ?.expectedMinutes ?? 0;
    if (ourExpMin < MATCHUP_MIN_EXPECTED_MINUTES) continue;

    let bonus = 0;
    let reasonSuffix = "";
    let opponentContextLine = "";
    const opponentRole = positionLabelFromSportmonksId(opponent.positionId);
    const opponentLabel = opponentRole ? `${opponent.playerName} (${opponentRole})` : opponent.playerName;

    if (cat === "foulsCommitted") {
      const ourFoulsCommitted = getFoulsCommittedPer90FromRows(leg.playerName, playerRows);
      const oppFoulsWon = getFoulsWonPer90FromRows(opponent.playerName, playerRows);
      if (
        (ourFoulsCommitted == null || ourFoulsCommitted < FOUL_RATE_MIN_PER90) ||
        (oppFoulsWon == null || oppFoulsWon < FOUL_RATE_MIN_PER90)
      )
        continue;
      bonus = 8;
      reasonSuffix = "strong flank foul matchup";
      if (oppFoulsWon >= 1.2) reasonSuffix = "opponent draws fouls at a high rate";
      opponentContextLine = `${opponentLabel} draws ${oppFoulsWon.toFixed(1)} fouls per 90.`;
    } else {
      const ourFoulsWon = getFoulsWonPer90FromRows(leg.playerName, playerRows);
      const oppFoulsCommitted = getFoulsCommittedPer90FromRows(opponent.playerName, playerRows);
      if (
        (ourFoulsWon == null || ourFoulsWon < FOUL_RATE_MIN_PER90) ||
        (oppFoulsCommitted == null || oppFoulsCommitted < FOUL_RATE_MIN_PER90)
      )
        continue;
      bonus = 8;
      reasonSuffix = "role matchup supports foul volume";
      if (oppFoulsCommitted >= 1.5) reasonSuffix = "opponent commits fouls at high rate";
      opponentContextLine = `${opponentLabel} commits ${oppFoulsCommitted.toFixed(1)} fouls per 90.`;
    }

    const cappedBonus = Math.min(FOUL_MATCHUP_MAX_BONUS, bonus);
    const scoreBefore = leg.score;
    leg.score += cappedBonus;
    const existing = leg.reason ?? "";
    leg.reason = existing ? `${existing}; ${reasonSuffix}` : reasonSuffix;
    if (opponentContextLine) {
      leg.opponentContextLine = opponentContextLine;
    }

    if (import.meta.env?.DEV) {
      console.log("[build-value-bets] foul matchup boost", {
        playerName: leg.playerName,
        market: cat,
        opponent: opponent.playerName,
        scoreBefore,
        scoreAfter: leg.score,
        reason: reasonSuffix,
      });
    }
  }
}

/** Apply shot matchup boost to Player Shots and Shots On Target legs (in-place). Boosts when role and involvement support shot volume. */
function applyShotMatchupBoost(
  legs: BuildLeg[],
  playerRows: PlayerCandidateInput[],
  lineupContext: LineupContext | null
): void {
  if (lineupContext == null) return;
  const homeNames = new Set(lineupContext.homeStarters.map((p) => normalizePlayerNameForMatch(p.playerName)));

  for (const leg of legs) {
    if (leg.type !== "player" || !leg.playerName) continue;
    const cat = getMarketCategory(leg.marketName);
    if (cat !== "shots" && cat !== "shotsOnTarget") continue;

    const key = normalizePlayerNameForMatch(leg.playerName);
    const side: "home" | "away" = homeNames.has(key) ? "home" : "away";
    const starters = side === "home" ? lineupContext.homeStarters : lineupContext.awayStarters;
    const player = starters.find((p) => normalizePlayerNameForMatch(p.playerName) === key);
    if (!player) continue;

    const row = playerRows.find((r) => normalizePlayerNameForMatch(r.playerName) === key);
    const expectedMinutes = (row?.modelInputs as { expectedMinutes?: number } | undefined)?.expectedMinutes ?? 0;
    if (expectedMinutes < MATCHUP_MIN_EXPECTED_MINUTES) continue;

    const positionId = player.positionId;
    const shotsPer90 = getShotsPer90FromRows(leg.playerName, playerRows);
    const sotPer90 = getShotsOnTargetPer90FromRows(leg.playerName, playerRows);

    if (cat === "shots" && (shotsPer90 == null || shotsPer90 < SHOTS_MIN_PER90)) continue;
    if (cat === "shotsOnTarget" && (sotPer90 == null || sotPer90 < SOT_MIN_PER90)) continue;

    let bonus = 0;
    let reasonSuffix = "";

    if (positionId != null && ATTACKING_SHOT_ROLE_IDS.has(positionId)) {
      bonus = 8;
      reasonSuffix = cat === "shotsOnTarget" ? "strong SOT role profile" : "high shot involvement role";
    } else if (positionId != null && WINGBACK_IDS.has(positionId)) {
      bonus = 4;
      reasonSuffix = "attacking wing-back supports shot volume";
    } else if (positionId != null && (positionId === 7 || positionId === 8)) {
      bonus = 5;
      reasonSuffix = "advanced position supports shot volume";
    }

    if (bonus > 0) {
      const opponent = getLikelyOpponent(leg.playerName, side, lineupContext);
      if (opponent != null && opponent.positionId != null && FLANK_DEFENDER_IDS.has(opponent.positionId)) {
        bonus = Math.min(bonus + 2, SHOT_MATCHUP_MAX_BONUS);
        if (reasonSuffix === "") reasonSuffix = "attacking matchup supports shot angle";
        else reasonSuffix = `${reasonSuffix}; attacking matchup supports shot angle`;
      }

      const cappedBonus = Math.min(SHOT_MATCHUP_MAX_BONUS, bonus);
      const scoreBefore = leg.score;
      leg.score += cappedBonus;
      const existing = leg.reason ?? "";
      leg.reason = existing ? `${existing}; ${reasonSuffix}` : reasonSuffix;

      if (import.meta.env?.DEV) {
        console.log("[build-value-bets] shot matchup boost", {
          playerName: leg.playerName,
          market: cat,
          positionId,
          shotsPer90: shotsPer90 ?? undefined,
          sotPer90: sotPer90 ?? undefined,
          scoreBefore,
          scoreAfter: leg.score,
          reason: reasonSuffix,
        });
      }
    }
  }
}

function applyH2hContextToPlayerLegs(
  legs: BuildLeg[],
  headToHeadContext: HeadToHeadFixtureContext | null | undefined
): void {
  if (!headToHeadContext) return;
  const sampleSize = headToHeadContext.sampleSize ?? 0;
  if (sampleSize <= 0) return;
  const avgGoals = headToHeadContext.averageTotalGoals;
  const h2hLine = buildFixtureH2hContextLine(headToHeadContext);
  if (!h2hLine) return;

  const canScore =
    sampleSize >= MIN_H2H_SAMPLE_SIZE && avgGoals != null && Number.isFinite(avgGoals);
  const tempoHigh = canScore && avgGoals >= 2.9;
  const tempoLow = canScore && avgGoals <= 2.1;
  for (const leg of legs) {
    if (leg.type !== "player" || !leg.playerName) continue;
    const cat = getMarketCategory(leg.marketName);
    if (cat == null) continue;

    let delta = 0;
    if (canScore) {
      if (cat === "shots" || cat === "shotsOnTarget") {
        if (tempoHigh) delta = 2;
        if (tempoLow) delta = -2;
      } else if (cat === "foulsCommitted" || cat === "foulsWon" || cat === "tackles") {
        if (tempoHigh) delta = 1;
        if (tempoLow) delta = -1;
      }
    }

    if (delta !== 0) {
      leg.score = Math.max(0, leg.score + delta);
    }

    leg.h2hContextLine = h2hLine;
  }
}

function buildFixtureH2hContextLine(headToHeadContext: HeadToHeadFixtureContext): string | null {
  const bits: string[] = [];
  if (headToHeadContext.averageTotalGoals != null && Number.isFinite(headToHeadContext.averageTotalGoals)) {
    bits.push(`avg goals ~${headToHeadContext.averageTotalGoals.toFixed(1)}`);
  }
  if (headToHeadContext.bttsRate != null && Number.isFinite(headToHeadContext.bttsRate)) {
    bits.push(`BTTS ${(headToHeadContext.bttsRate * 100).toFixed(0)}%`);
  }
  if (bits.length === 0) return null;
  return `Fixture H2H (${headToHeadContext.sampleSize} meetings): ${bits.join(", ")}.`;
}

/** Filter and convert player rows to build legs. */
export function filterPlayerCandidates(
  rows: PlayerCandidateInput[],
  evidenceContext?: BuildEvidenceContext | null,
  lineupContext?: LineupContext | null
): BuildLeg[] {
  const legs: BuildLeg[] = [];
  const seen = new Set<string>();
  // Dev-only fouls tracing.
  let foulsRawCount = 0;
  let foulsKeptCount = 0;
  const foulsRejectedReasons: Record<string, number> = {};
  const foulsRejectedSamples: Array<{
    reason: string;
    playerName: string;
    marketName: string;
    line: number;
    odds: number;
    edge: number | undefined;
    expectedMinutes: number | undefined;
  }> = [];
  let sensibleLineVerboseLogs = 0;
  let builderOddsGateVerboseLogs = 0;

  for (const r of rows) {
    const cat = getMarketCategory(r.marketName);
    if (cat == null) continue; // only supported player-prop markets
    const isFoulsCat = cat === "foulsCommitted" || cat === "foulsWon";
    if (isFoulsCat) foulsRawCount += 1;

    if (!isOddsSane(r.odds) || r.odds > MAX_ODDS_PER_LEG) {
      if (isFoulsCat) {
        foulsRejectedReasons["odds"] = (foulsRejectedReasons["odds"] ?? 0) + 1;
        if (foulsRejectedSamples.length < 5) {
          foulsRejectedSamples.push({
            reason: "odds",
            playerName: r.playerName,
            marketName: r.marketName,
            line: r.line,
            odds: r.odds,
            edge: r.modelEdge,
            expectedMinutes: r.modelInputs?.expectedMinutes,
          });
        }
      }
      continue;
    }
    if (!isValidBuilderCandidate(r.odds, r.modelEdge)) {
      if (isFoulsCat) {
        foulsRejectedReasons["edge"] = (foulsRejectedReasons["edge"] ?? 0) + 1;
        if (foulsRejectedSamples.length < 5) {
          foulsRejectedSamples.push({
            reason: "edge",
            playerName: r.playerName,
            marketName: r.marketName,
            line: r.line,
            odds: r.odds,
            edge: r.modelEdge,
            expectedMinutes: r.modelInputs?.expectedMinutes,
          });
        }
      }
      if (BUILDER_DEBUG_VERBOSE && builderOddsGateVerboseLogs < 40) {
        builderOddsGateVerboseLogs += 1;
        console.log("[build-value-bets] builder candidate gate", {
          odds: r.odds,
          edge: r.modelEdge,
          accepted: false,
        });
      }
      continue;
    }
    const expectedMinutes = r.modelInputs?.expectedMinutes ?? 0;
    if (expectedMinutes < MIN_EXPECTED_MINUTES) {
      if (isFoulsCat) {
        foulsRejectedReasons["minutes"] = (foulsRejectedReasons["minutes"] ?? 0) + 1;
        if (foulsRejectedSamples.length < 5) {
          foulsRejectedSamples.push({
            reason: "minutes",
            playerName: r.playerName,
            marketName: r.marketName,
            line: r.line,
            odds: r.odds,
            edge: r.modelEdge,
            expectedMinutes: r.modelInputs?.expectedMinutes,
          });
        }
      }
      continue;
    }
    const dataConfidenceScore = r.dataConfidenceScore ?? 0;
    if (!Number.isFinite(dataConfidenceScore) || dataConfidenceScore < BUILDER_MIN_DATA_CONFIDENCE_SCORE) {
      if (isFoulsCat) {
        foulsRejectedReasons["dataConfidence"] = (foulsRejectedReasons["dataConfidence"] ?? 0) + 1;
      }
      continue;
    }
    const betQualityScore = r.betQualityScore ?? 0;
    if (!Number.isFinite(betQualityScore) || betQualityScore < BUILDER_MIN_BET_QUALITY_SCORE) {
      if (isFoulsCat) {
        foulsRejectedReasons["betQuality"] = (foulsRejectedReasons["betQuality"] ?? 0) + 1;
      }
      continue;
    }
    const marketIdForLine = marketIdFromPlayerCategory(cat);
    const positionRole = positionRoleForPlayerFromLineup(r.playerName, lineupContext ?? null);
    if (!isValidMarketForPosition(positionRole, marketIdForLine)) {
      if (isFoulsCat) {
        foulsRejectedReasons["positionMarket"] = (foulsRejectedReasons["positionMarket"] ?? 0) + 1;
      }
      continue;
    }
    const per90ForLine = getModelInputNumber(r, "per90") ?? 0;
    if (!isSensiblePlayerPropLine(r.line, per90ForLine, marketIdForLine, r.outcome)) {
      if (isFoulsCat) {
        foulsRejectedReasons["line"] = (foulsRejectedReasons["line"] ?? 0) + 1;
        if (foulsRejectedSamples.length < 5) {
          foulsRejectedSamples.push({
            reason: "line",
            playerName: r.playerName,
            marketName: r.marketName,
            line: r.line,
            odds: r.odds,
            edge: r.modelEdge,
            expectedMinutes: r.modelInputs?.expectedMinutes,
          });
        }
      }
      if (BUILDER_DEBUG_VERBOSE && sensibleLineVerboseLogs < 30) {
        sensibleLineVerboseLogs += 1;
        console.log("[build-value-bets] player line filtered", {
          player: r.playerName,
          line: r.line,
          per90: per90ForLine,
          marketId: marketIdForLine,
          edge: r.modelEdge,
        });
      }
      continue;
    }

    const recentCheck = validatePlayerPropRecentEvidence(r, cat, evidenceContext, per90ForLine);
    if (!recentCheck.accepted) {
      if (import.meta.env.DEV) {
        console.log({
          player: r.playerName,
          line: r.line,
          hitRate: recentCheck.hitRate,
          per90: per90ForLine,
          accepted: false,
          reason: recentCheck.reason,
          recentN: recentCheck.recentN,
        });
      }
      if (isFoulsCat) {
        foulsRejectedReasons["recentEvidence"] = (foulsRejectedReasons["recentEvidence"] ?? 0) + 1;
      }
      continue;
    }

    const key = `${r.playerName}|${r.marketName}|${r.line}|${r.outcome}|${r.bookmakerName}`;
    if (seen.has(key)) {
      if (isFoulsCat) {
        foulsRejectedReasons["duplicate"] = (foulsRejectedReasons["duplicate"] ?? 0) + 1;
      }
      continue;
    }
    seen.add(key);

    const quality = computePlayerLegQualitySignals(r, evidenceContext, {
      hitRate: recentCheck.hitRate,
      hits: recentCheck.hits,
      recentN: recentCheck.recentN,
    });
    if (quality.playerTier === "weak") {
      if (isFoulsCat) {
        foulsRejectedReasons["weakTier"] = (foulsRejectedReasons["weakTier"] ?? 0) + 1;
      }
      continue;
    }
    const score = scorePlayerLeg(r, quality);
    const implied = 1 / r.odds;
    const probability = clamp01(implied + (r.modelEdge ?? 0));
    const id = `player-${legs.length}-${key.slice(0, 40)}`;
    const reason = buildLegReason(r, quality);
    // One player per combo: overlap rule uses marketFamily; same player → same family (any market/line).
    const marketFamily = `player:${String(r.playerName).trim().toLowerCase()}`;
    const smPid = r.sportmonksPlayerId;
    legs.push({
      id,
      type: "player",
      playerId: String(r.playerName).trim().toLowerCase(),
      sportmonksPlayerId:
        typeof smPid === "number" && Number.isFinite(smPid) && smPid > 0 ? smPid : undefined,
      playerQuality: quality,
      marketFamily,
      marketId: marketIdForLine,
      label: `${r.playerName} ${r.marketName} ${r.line} ${r.outcome}`,
      marketName: r.marketName,
      line: r.line,
      outcome: r.outcome,
      odds: r.odds,
      bookmakerName: r.bookmakerName,
      score,
      dataConfidenceScore,
      betQualityScore,
      edge: r.modelEdge,
      probability,
      reason,
      playerName: r.playerName,
    });
    if (isFoulsCat) foulsKeptCount += 1;
  }

  if (import.meta.env?.DEV) {
    const foulsRawExist = foulsRawCount > 0;
    if (!foulsRawExist) {
      console.log("[builder-debug] fouls filter stats", {
        foulsRawCount,
        foulsKeptCount,
        note: "NO FOULS ROWS IN INPUT",
      });
    } else {
      console.log("[builder-debug] fouls filter stats", {
        foulsRawCount,
        foulsKeptCount,
        foulsRejectedReasons,
        foulsRejectedSampleCount: foulsRejectedSamples.length,
        foulsRejectedSamples,
      });
    }
  }

  return legs;
}

/** Builder-only market priority: fouls get a strong bonus, others lower. */
function getBuilderMarketPriority(cat: string | null): number {
  if (!cat) return 0;
  if (cat === "foulsCommitted") return 20;
  if (cat === "foulsWon") return 18;
  if (cat === "tackles") return 16;
  if (cat === "shotsOnTarget") return 6;
  if (cat === "shots") return 4;
  return 0;
}

type PlayerLegQualitySignals = NonNullable<BuildLeg["playerQuality"]>;
type PlayerLegTier = PlayerLegQualitySignals["playerTier"];

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function getModelInputNumber(r: PlayerCandidateInput, key: string): number | null {
  const v = r.modelInputs?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function computeProjectedRateStrength(r: PlayerCandidateInput): number {
  const per90 = getModelInputNumber(r, "per90");
  const expectedMinutes = r.modelInputs?.expectedMinutes ?? 0;
  if (per90 == null || expectedMinutes <= 0) return 0.5;
  const expectedCount = (per90 * expectedMinutes) / 90;
  const threshold = r.outcome === "Over" ? Math.round(r.line + 0.5) : Math.max(0, Math.floor(r.line));
  if (threshold <= 0) return clamp01(expectedCount / 1.25);
  if (r.outcome === "Over") return clamp01(expectedCount / threshold);
  return clamp01((threshold - expectedCount + threshold) / (threshold * 2));
}

function classifyPlayerLegTier(quality: Omit<PlayerLegQualitySignals, "playerTier" | "weakSignalFlags">): PlayerLegTier {
  const weakCfg = SCORING_CONFIG.playerTier.thresholds.weak;
  const weakByReliability =
    quality.sampleReliability < weakCfg.minSampleReliability || quality.minutesReliability < weakCfg.minMinutesReliability;
  const weakBySignal =
    quality.projectedRateStrength < weakCfg.minProjectedRateStrength || quality.recencyScore < weakCfg.minRecencyScore;
  if (weakByReliability || weakBySignal || quality.qualityScore < weakCfg.minQualityScore) return "weak";

  const eliteCfg = SCORING_CONFIG.playerTier.thresholds.elite;
  const eliteAllAround =
    quality.qualityScore >= eliteCfg.minQualityScore &&
    quality.sampleReliability >= eliteCfg.minSampleReliability &&
    quality.minutesReliability >= eliteCfg.minMinutesReliability &&
    quality.recencyScore >= eliteCfg.minRecencyScore &&
    quality.projectedRateStrength >= eliteCfg.minProjectedRateStrength;
  if (eliteAllAround) return "elite";

  const strongCfg = SCORING_CONFIG.playerTier.thresholds.strong;
  const strongOverall =
    quality.qualityScore >= strongCfg.minQualityScore &&
    quality.sampleReliability >= strongCfg.minSampleReliability &&
    quality.minutesReliability >= strongCfg.minMinutesReliability &&
    quality.recencyScore >= strongCfg.minRecencyScore &&
    quality.projectedRateStrength >= strongCfg.minProjectedRateStrength;
  if (strongOverall) return "strong";

  return "ok";
}

function computeRecencyScore(r: PlayerCandidateInput, evidenceContext?: BuildEvidenceContext | null): number {
  const cat = getMarketCategory(r.marketName);
  if (!cat || !evidenceContext?.playerRecentStats?.length) return 0.5;
  const evidence = getPlayerEvidence(r.playerName, cat, evidenceContext.playerRecentStats);
  if (!evidence?.recentValues?.length) return 0.5;
  const values = evidence.recentValues.slice(-8);
  const weights = values.map((_, i) => i + 1); // recent matches weighted more
  const weightedMean = values.reduce((s, v, i) => s + v * weights[i]!, 0) / weights.reduce((a, b) => a + b, 0);
  const threshold = r.outcome === "Over" ? Math.round(r.line + 0.5) : Math.max(0, Math.floor(r.line));
  if (threshold <= 0) return clamp01(weightedMean / 1.25);
  if (r.outcome === "Over") return clamp01(weightedMean / threshold);
  return clamp01((threshold - weightedMean + threshold) / (threshold * 2));
}

function computePlayerLegQualitySignals(
  r: PlayerCandidateInput,
  evidenceContext?: BuildEvidenceContext | null,
  recentFormGate?: { hitRate: number; hits: number; recentN: number } | null
): PlayerLegQualitySignals {
  const cat = getMarketCategory(r.marketName);
  const appearances = getModelInputNumber(r, "appearances") ?? 0;
  const minutesPlayed = getModelInputNumber(r, "minutesPlayed") ?? 0;
  const expectedMinutes = r.modelInputs?.expectedMinutes ?? 0;
  const dataConfidence = clamp01((r.dataConfidenceScore ?? 0) / 100);
  const betQualityNorm = clamp01((r.betQualityScore ?? 0) / 100);
  const edgeNorm = clamp01(((r.modelEdge ?? 0) + 0.01) / 0.12);

  const sampleReliability = clamp01(Math.min(1, appearances / 12) * 0.7 + Math.min(1, minutesPlayed / 900) * 0.3);
  const minutesReliability = clamp01(expectedMinutes / 80);
  const recencyScore = computeRecencyScore(r, evidenceContext);
  const projectedRateStrength = computeProjectedRateStrength(r);
  const roleConsistencyScore = clamp01(minutesReliability * 0.6 + sampleReliability * 0.3 + dataConfidence * 0.1);

  let marketSpecificScore = 0.5;
  if (cat === "shots") {
    const w = SCORING_CONFIG.playerQualityAggregation.marketSpecificWeights.shots;
    marketSpecificScore = clamp01(
      projectedRateStrength * w.projectedRate + recencyScore * w.recency + minutesReliability * w.minutes + sampleReliability * w.sample
    );
  } else if (cat === "shotsOnTarget") {
    const w = SCORING_CONFIG.playerQualityAggregation.marketSpecificWeights.shotsOnTarget;
    marketSpecificScore = clamp01(
      projectedRateStrength * w.projectedRate + recencyScore * w.recency + minutesReliability * w.minutes + sampleReliability * w.sample
    );
  } else if (cat === "foulsCommitted") {
    const w = SCORING_CONFIG.playerQualityAggregation.marketSpecificWeights.foulsCommitted;
    marketSpecificScore = clamp01(
      projectedRateStrength * w.projectedRate + recencyScore * w.recency + minutesReliability * w.minutes + sampleReliability * w.sample
    );
  } else if (cat === "foulsWon") {
    const w = SCORING_CONFIG.playerQualityAggregation.marketSpecificWeights.foulsWon;
    marketSpecificScore = clamp01(
      projectedRateStrength * w.projectedRate + recencyScore * w.recency + minutesReliability * w.minutes + sampleReliability * w.sample
    );
  } else if (cat === "tackles") {
    const w = SCORING_CONFIG.playerQualityAggregation.marketSpecificWeights.tackles;
    marketSpecificScore = clamp01(
      projectedRateStrength * w.projectedRate + recencyScore * w.recency + minutesReliability * w.minutes + sampleReliability * w.sample
    );
  }

  const qb = SCORING_CONFIG.playerQualityAggregation.qualityBlend;
  const qualityScore = Math.round(
    clamp01(
      marketSpecificScore * qb.marketSpecific +
        edgeNorm * qb.edge +
        roleConsistencyScore * qb.roleConsistency +
        dataConfidence * qb.dataConfidence +
        betQualityNorm * qb.betQuality
    ) * 100
  );

  const evidence = cat && evidenceContext?.playerRecentStats?.length ? getPlayerEvidence(r.playerName, cat, evidenceContext.playerRecentStats) : null;
  const hasRecentValues = Boolean(evidence?.recentValues?.length);
  const lowSample = sampleReliability < SCORING_CONFIG.weakSignalPenalties.lowSampleThreshold;
  const unstableMinutes = minutesReliability < SCORING_CONFIG.weakSignalPenalties.lowMinutesThreshold;
  const weakRecency = recencyScore < SCORING_CONFIG.weakSignalPenalties.lowRecencyThreshold;
  const playerTier = classifyPlayerLegTier({
    qualityScore,
    sampleReliability,
    minutesReliability,
    recencyScore,
    roleConsistencyScore,
    marketSpecificScore,
    projectedRateStrength,
    explanationSourceFlags: {
      hasRecentValues,
      hasSample: appearances >= 6 || minutesPlayed >= 500,
      stableMinutes: expectedMinutes >= 60,
    },
  });

  return {
    playerTier,
    qualityScore,
    sampleReliability,
    minutesReliability,
    recencyScore,
    roleConsistencyScore,
    marketSpecificScore,
    projectedRateStrength,
    weakSignalFlags: {
      lowSample,
      unstableMinutes,
      weakRecency,
    },
    explanationSourceFlags: {
      hasRecentValues,
      hasSample: appearances >= 6 || minutesPlayed >= 500,
      stableMinutes: expectedMinutes >= 60,
    },
    ...(recentFormGate != null
      ? {
          recentFormHitRate: recentFormGate.hitRate,
          recentHitsCount: recentFormGate.hits,
          recentHitsSampleSize: recentFormGate.recentN,
        }
      : {}),
  };
}

/** Score a player leg for combo ranking (higher = better). */
function scorePlayerLeg(r: PlayerCandidateInput, quality: PlayerLegQualitySignals): number {
  let score = 0;
  const edge = r.modelEdge ?? 0;
  score += Math.min(50, Math.max(0, edge * 200)); // edge contribution cap
  const expMin = r.modelInputs?.expectedMinutes ?? 0;
  if (expMin >= 70) score += 15;
  else if (expMin >= 55) score += 10;
  else if (expMin >= 45) score += 5;
  const bq = r.betQualityScore ?? 0;
  score += Math.min(15, bq / 5);
  const conf = r.dataConfidenceScore ?? 0;
  score += Math.min(10, conf / 10);
  if (r.isStrongBet) score += 10;
  {
    const catLeg = getMarketCategory(r.marketName);
    const midLeg = catLeg ? marketIdFromPlayerCategory(catLeg) : 0;
    const per90Leg = getModelInputNumber(r, "per90") ?? 0;
    if (catLeg == null || !isSensiblePlayerPropLine(r.line, per90Leg, midLeg, r.outcome)) score -= 20;
  }
  if (r.odds > 8) score -= 5;
  if (r.odds > 12) score -= 10;
  score += getBuilderMarketPriority(getMarketCategory(r.marketName));

  // Non-linear tier impact: elite legs separate clearly from average ones.
  if (quality.playerTier === "weak") score += SCORING_CONFIG.playerTier.weakPenalty;
  else if (quality.playerTier === "ok") score += SCORING_CONFIG.playerTier.okBonus;
  else if (quality.playerTier === "strong") score += SCORING_CONFIG.playerTier.strongBonus;
  else if (quality.playerTier === "elite") score += SCORING_CONFIG.playerTier.eliteBonus;

  // Sharper projected-rate-vs-line contribution.
  if (quality.projectedRateStrength >= SCORING_CONFIG.projectedRateStrength.veryHighThreshold) {
    score += SCORING_CONFIG.projectedRateStrength.veryHighBonus;
  } else if (quality.projectedRateStrength >= SCORING_CONFIG.projectedRateStrength.highThreshold) {
    score += SCORING_CONFIG.projectedRateStrength.highBonus;
  } else if (quality.projectedRateStrength >= SCORING_CONFIG.projectedRateStrength.mediumThreshold) {
    score += SCORING_CONFIG.projectedRateStrength.mediumBonus;
  } else if (quality.projectedRateStrength < SCORING_CONFIG.projectedRateStrength.lowThreshold) {
    score -= SCORING_CONFIG.projectedRateStrength.lowPenalty;
  }

  // Weak-signal drag: low reliability stacks should pull leg scores down.
  if (quality.weakSignalFlags.lowSample) score -= SCORING_CONFIG.weakSignalPenalties.lowSample;
  if (quality.weakSignalFlags.unstableMinutes) score -= SCORING_CONFIG.weakSignalPenalties.lowMinutes;
  if (quality.weakSignalFlags.weakRecency) score -= SCORING_CONFIG.weakSignalPenalties.lowRecency;

  score += (quality.qualityScore - 50) * SCORING_CONFIG.playerQualityAggregation.qualityScoreMultiplier;
  score += (quality.marketSpecificScore - 0.5) * SCORING_CONFIG.playerQualityAggregation.marketSpecificOffsetMultiplier;
  if (
    quality.recentFormHitRate != null &&
    quality.recentFormHitRate > PLAYER_PROP_STRONG_HIT_RATE
  ) {
    score += PLAYER_PROP_STRONG_HIT_RATE_SCORE_BONUS;
  }
  return Math.max(0, score);
}

function buildLegReason(r: PlayerCandidateInput, quality: PlayerLegQualitySignals): string {
  const edge = r.modelEdge;
  const pct = edge != null ? `${(edge * 100).toFixed(1)}% edge` : "";
  const strong = r.isStrongBet ? " strong" : "";
  const reasons: string[] = [];
  if (pct) reasons.push(`${pct}${strong}`.trim());
  if (quality.playerTier === "elite") reasons.push("strong underlying rate; consistent involvement");
  if (quality.playerTier === "strong") reasons.push("solid underlying rate");
  if (quality.sampleReliability >= 0.7) reasons.push("reliable sample");
  if (quality.minutesReliability >= 0.75) reasons.push("stable minutes");
  if (quality.recencyScore >= 0.65) reasons.push("recent form supports line");
  if (
    quality.recentHitsCount != null &&
    quality.recentHitsSampleSize != null &&
    quality.recentHitsSampleSize >= PLAYER_PROP_MIN_RECENT_GAMES
  ) {
    reasons.push(`Hits: ${quality.recentHitsCount}/${quality.recentHitsSampleSize} recent apps vs line`);
  }
  if (quality.playerTier === "weak") reasons.push("limited signal reliability");
  return reasons.length > 0 ? reasons.join("; ") : "value";
}

/** Compute fixture expected total corners from team stats (for/against per match). */
export function getFixtureExpectedCorners(ctx: FixtureCornersContext | null): number {
  if (ctx == null) return DEFAULT_FIXTURE_EXPECTED_CORNERS;
  const homeExpected = (ctx.homeCornersFor + ctx.awayCornersAgainst) / 2;
  const awayExpected = (ctx.awayCornersFor + ctx.homeCornersAgainst) / 2;
  return homeExpected + awayExpected;
}

/** Evaluate one corner line: model prob (Poisson), implied, edge, raw score, reason. No directional preference applied here. */
function evaluateCornerLine(
  line: number,
  outcome: "Over" | "Under",
  odds: number,
  fixtureExpectedCorners: number
): { modelProb: number; implied: number; edge: number; score: number; reason: string } {
  const modelProb =
    outcome === "Over"
      ? probabilityOverLine(fixtureExpectedCorners, line)
      : probabilityUnderLine(fixtureExpectedCorners, line);
  const implied = 1 / odds;
  const edge = modelProb - implied;
  const distFromExp = Math.abs(line - fixtureExpectedCorners);
  let score = Math.min(50, Math.max(-20, edge * 200));
  if (distFromExp <= 1) score += 15; // line sits close to model expectation
  else if (distFromExp <= 2) score += 5;
  if (edge > 0.02) score += 10; // fixture corners projection supports this line
  const reason =
    edge > 0.03
      ? "fixture corners projection supports this line"
      : distFromExp <= 1
        ? "line sits close to model expectation"
        : "best-rated corners line for this fixture";
  return { modelProb, implied, edge, score: Math.max(0, score), reason };
}

/** Build model-based Alternative Corners legs: evaluate each line, keep top N by score. */
export function getCornerLegsFromOdds(
  bookmakers: OddsBookmakerInput[],
  fixtureCornersContext: FixtureCornersContext | null,
  headToHeadContext?: HeadToHeadFixtureContext | null
): BuildLeg[] {
  const fixtureExpected = getFixtureExpectedCorners(fixtureCornersContext);
  if (import.meta.env?.DEV) {
    console.log("[build-value-bets] fixtureExpectedCorners", fixtureExpected, fixtureCornersContext == null ? "(default)" : "(from team stats)");
  }

  const candidates: Array<{
    line: number;
    outcome: "Over" | "Under";
    odds: number;
    bookmakerName: string;
    marketName: string;
    score: number;
    reason: string;
    edge: number;
    probability: number;
  }> = [];
  const seen = new Set<string>();
  let underRejectedByPreference = 0;

  for (const b of bookmakers) {
    for (const m of b.markets) {
      if (!BUILD_TEAM_MARKET_IDS.has(m.marketId)) continue;
      for (const sel of m.selections) {
        const odds = sel.odds;
        if (odds == null || !isOddsSane(odds) || odds > MAX_ODDS_PER_LEG) continue;
        const line = parseOverUnderLine(sel.label);
        if (line == null) continue;
        const outcome = (isOverLabel(sel.label) ? "Over" : "Under") as "Over" | "Under";
        const key = `${line}|${outcome}|${b.bookmakerId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const evaluated = evaluateCornerLine(line, outcome, odds, fixtureExpected);
        let { score, reason, edge, modelProb } = evaluated;

        if (outcome === "Under") {
          if (edge < MIN_EDGE_UNDER_CORNERS) {
            underRejectedByPreference += 1;
            if (import.meta.env?.DEV) {
              console.log("[build-value-bets] corner Under rejected (below min edge)", {
                line,
                edge: edge.toFixed(3),
                minRequired: MIN_EDGE_UNDER_CORNERS,
              });
            }
            continue;
          }
          score = Math.max(0, score - UNDER_CORNERS_SCORE_PENALTY);
          reason = "strong Under value vs model — included on merit";
        } else {
          if (edge < MIN_EDGE_OVER_CORNERS) continue;
        }

        // Optional H2H context adjustment: modestly align corners direction with historical average when sample is strong.
        if (headToHeadContext && headToHeadContext.sampleSize >= MIN_H2H_SAMPLE_SIZE && headToHeadContext.averageTotalCorners != null) {
          const diff = headToHeadContext.averageTotalCorners - fixtureExpected;
          if (diff >= 1.0) {
            if (outcome === "Over") {
              score += 3;
              reason = `${reason}; H2H corners lean high`;
            } else {
              score = Math.max(0, score - 2);
            }
          } else if (diff <= -1.0) {
            if (outcome === "Under") {
              score += 3;
              reason = `${reason}; H2H corners lean low`;
            } else {
              score = Math.max(0, score - 2);
            }
          }
        }

        if (import.meta.env?.DEV) {
          const modelProb =
            outcome === "Over"
              ? probabilityOverLine(fixtureExpected, line)
              : probabilityUnderLine(fixtureExpected, line);
          const implied = 1 / odds;
          console.log("[build-value-bets] corner line", {
            line,
            outcome,
            odds,
            modelProb: modelProb.toFixed(3),
            implied: implied.toFixed(3),
            edge: edge.toFixed(3),
            score,
          });
        }
        candidates.push({
          line,
          outcome,
          odds,
          bookmakerName: b.bookmakerName,
          marketName: m.marketName,
          score,
          reason,
          edge,
          probability: modelProb,
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const kept = candidates.slice(0, MAX_CORNER_LEGS);
  const overKept = kept.filter((c) => c.outcome === "Over").length;
  const underKept = kept.filter((c) => c.outcome === "Under").length;

  if (import.meta.env?.DEV) {
    console.log("[build-value-bets] corner lines considered", candidates.length, "kept", kept.length, "Over", overKept, "Under", underKept);
    console.log("[build-value-bets] Under corners rejected by preference rule (min edge)", underRejectedByPreference);
    console.log("[build-value-bets] final corner legs", kept.map((c) => ({ outcome: c.outcome, line: c.line, edge: c.edge.toFixed(3), score: c.score })));
  }

  return kept.map((c, i) => ({
    id: `team-corners-${i}`,
    type: "team" as const,
    marketId: MARKET_ID_ALTERNATIVE_CORNERS,
    marketFamily: CORNERS_MARKET_FAMILY,
    label: `${c.marketName} ${c.line} ${c.outcome}`,
    marketName: c.marketName,
    line: c.line,
    outcome: c.outcome,
    odds: c.odds,
    bookmakerName: c.bookmakerName,
    score: c.score,
    edge: c.edge,
    probability: c.probability,
    reason: c.reason,
  }));
}

function applyH2HAdjustmentsToTeamLeg(
  leg: BuildLeg,
  headToHeadContext: HeadToHeadFixtureContext | null | undefined
): { delta: number; note: string | null } {
  if (!headToHeadContext) return { delta: 0, note: null };
  if (headToHeadContext.sampleSize < MIN_H2H_SAMPLE_SIZE) return { delta: 0, note: null };

  let delta = 0;
  const notes: string[] = [];

  const avgGoals = headToHeadContext.averageTotalGoals;
  const avgCorners = headToHeadContext.averageTotalCorners;
  const bttsRate = headToHeadContext.bttsRate;
  const drawRate = headToHeadContext.drawRate;
  const homeWin = headToHeadContext.team1WinRate;
  const awayWin = headToHeadContext.team2WinRate;

  // Goals lean (team totals markets only).
  if (isTeamMatchTotalGoalsLeg(leg) && avgGoals != null) {
    const high = avgGoals >= 3.0;
    const low = avgGoals <= 2.2;
    if (high) {
      if (leg.outcome === "Over") {
        delta += 5;
        notes.push("H2H avg goals leans high");
      } else if (leg.outcome === "Under") {
        delta -= 3;
      }
    } else if (low) {
      if (leg.outcome === "Under") {
        delta += 5;
        notes.push("H2H avg goals leans low");
      } else if (leg.outcome === "Over") {
        delta -= 3;
      }
    }
    // Small extra nudge if line is clearly below/above avg goals.
    if (typeof leg.line === "number" && Number.isFinite(leg.line)) {
      if (leg.outcome === "Over" && avgGoals >= leg.line + 0.6) delta += 2;
      if (leg.outcome === "Under" && avgGoals <= leg.line - 0.6) delta += 2;
    }
  }

  // Team-specific goals lean (home/away team goals markets).
  if (leg.marketFamily === "team:home-goals" || leg.marketFamily === "team:away-goals") {
    const teamAvgGoals =
      leg.marketFamily === "team:home-goals"
        ? headToHeadContext.team1AvgGoalsScored
        : headToHeadContext.team2AvgGoalsScored;
    if (teamAvgGoals != null && Number.isFinite(leg.line)) {
      if (leg.outcome === "Over" && teamAvgGoals >= leg.line + 0.25) {
        delta += 4;
        notes.push("H2H team goals lean Over");
      } else if (leg.outcome === "Under" && teamAvgGoals <= leg.line - 0.25) {
        delta += 4;
        notes.push("H2H team goals lean Under");
      }
    }
  }

  // BTTS lean.
  if (leg.marketFamily === "team:btts" && bttsRate != null) {
    if (bttsRate >= 0.6) {
      if (leg.outcome === "Yes") {
        delta += 4;
        notes.push("H2H BTTS rate supports Yes");
      } else if (leg.outcome === "No") {
        delta -= 3;
      }
    } else if (bttsRate <= 0.45) {
      if (leg.outcome === "No") {
        delta += 4;
        notes.push("H2H BTTS rate supports No");
      } else if (leg.outcome === "Yes") {
        delta -= 3;
      }
    }
  }

  // Match result lean (assumes team1=Home, team2=Away in our request order).
  if (leg.marketFamily === "team:match-results") {
    if (drawRate != null && drawRate >= 0.33 && leg.outcome === "Draw") {
      delta += 3;
      notes.push("H2H draw rate is elevated");
    }
    if (homeWin != null && awayWin != null) {
      const diff = homeWin - awayWin;
      if (diff >= 0.22) {
        if (leg.outcome === "Home") {
          delta += 4;
          notes.push("H2H results lean Home");
        } else if (leg.outcome === "Away") {
          delta -= 2;
        }
      } else if (diff <= -0.22) {
        if (leg.outcome === "Away") {
          delta += 4;
          notes.push("H2H results lean Away");
        } else if (leg.outcome === "Home") {
          delta -= 2;
        }
      }
    }
  }

  // Corners lean already applied in `getCornerLegsFromOdds` (model-based), but allow a tiny note passthrough here for non-corners legs.
  if (leg.marketFamily !== CORNERS_MARKET_FAMILY && avgCorners != null) {
    // no-op; reserved for future use if we introduce other corners markets
  }

  return { delta, note: notes.length > 0 ? notes.join("; ") : null };
}

function scoreTeamLegNoModel(opts: {
  marketId: number;
  odds: number;
  line: number | null;
  outcomeLabel: string;
  /** When marketId is not 80/81, used to detect match goals O/U for line scoring. */
  marketName?: string;
}): { score: number; reason: string } {
  // Conservative: these legs are "available alternatives" vs corners, not meant to dominate without a model.
  const { marketId, odds, line, outcomeLabel, marketName } = opts;
  let score = 8;
  // Avoid generic filler; evidence-style explanations are added later (H2H counts, etc.).
  let reason = "";

  // Prefer plausible odds bands; penalise longshots.
  if (odds >= 1.45 && odds <= 3.8) score += 10;
  else if (odds >= 1.25 && odds <= 6.5) score += 4;
  if (odds > 8) score -= 8;
  if (odds > 12) score -= 14;

  // Prefer common goal lines for O/U totals (any match-goals market id / name).
  const isGoalsOu =
    marketId === MARKET_ID_MATCH_GOALS ||
    marketId === MARKET_ID_ALTERNATIVE_TOTAL_GOALS ||
    (typeof marketName === "string" && isMatchTotalGoalsOuMarket(marketId, marketName));
  if (isGoalsOu && line != null) {
    if (line >= 0.5 && line <= 6.5) score += 4;
    const common = [0.5, 1.5, 2.5, 3.5, 4.5];
    const dist = Math.min(...common.map((x) => Math.abs(x - line)));
    if (dist <= 0.01) {
      score += 6;
    }
  } else if (marketId === MARKET_ID_MATCH_RESULTS) {
    reason = "";
  } else if (marketId === MARKET_ID_BTTS) {
    reason = "";
  }

  return { score: Math.max(0, score), reason };
}

/** Build team legs from normalised fixture odds markets (explicit allowlist; no rewrite). */
export function getTeamLegsFromOdds(
  bookmakers: OddsBookmakerInput[],
  fixtureCornersContext: FixtureCornersContext | null,
  headToHeadContext?: HeadToHeadFixtureContext | null,
  teamFormContext?: FixtureTeamFormContext | null,
  teamNames: { home: string; away: string } = { home: "Home", away: "Away" },
  teamIds: { home: number | null; away: number | null } = { home: null, away: null }
): BuildLeg[] {
  const byMarketIdRaw = new Map<number, number>();
  const allowedRaw: Array<{ marketId: number; marketName: string; selectionLabel: string }> = [];

  // Candidates bucketed by marketId so we can cap per-market.
  const candidatesByMarketId = new Map<number, BuildLeg[]>();

  // Corners (69) remains model-scored and capped separately.
  const cornersLegs = getCornerLegsFromOdds(bookmakers, fixtureCornersContext, headToHeadContext);

  const h2hApplied =
    Boolean(headToHeadContext) &&
    (headToHeadContext?.sampleSize ?? 0) >= MIN_H2H_SAMPLE_SIZE;
  let h2hBoosted = 0;
  let h2hPenalised = 0;
  const h2hSamples: Array<{ delta: number; label: string; family: string; note: string | null }> = [];

  for (const b of bookmakers) {
    for (const m of b.markets) {
      byMarketIdRaw.set(m.marketId, (byMarketIdRaw.get(m.marketId) ?? 0) + 1);
      if (!BUILD_TEAM_MARKET_IDS.has(m.marketId) && !isMatchTotalGoalsOuMarket(m.marketId, m.marketName)) continue;
      if (m.marketId === MARKET_ID_ALTERNATIVE_CORNERS) continue; // already handled above

      for (const sel of m.selections) {
        const odds = sel.odds;
        if (odds == null || !isOddsSane(odds) || odds > MAX_ODDS_PER_LEG) continue;
        const rawLabel = String(sel.label ?? "").trim();
        if (!rawLabel) continue;
        allowedRaw.push({ marketId: m.marketId, marketName: m.marketName, selectionLabel: rawLabel });

        if (m.marketId === MARKET_ID_MATCH_RESULTS) {
          const out = parseMatchResultOutcome(rawLabel);
          if (!out) continue;
          const base = scoreTeamLegNoModel({ marketId: m.marketId, odds, line: null, outcomeLabel: out });
          const leg: BuildLeg = {
            id: `team-mr-${b.bookmakerId}-${out}-${odds}`,
            type: "team",
            marketId: m.marketId,
            marketFamily: "team:match-results",
            label: `${m.marketName} ${out}`,
            marketName: m.marketName,
            line: 0,
            outcome: out,
            odds,
            bookmakerName: b.bookmakerName,
            score: base.score,
            reason: base.reason,
          };
          if (h2hApplied) {
            const adj = applyH2HAdjustmentsToTeamLeg(leg, headToHeadContext);
            if (adj.delta !== 0) {
              leg.score = Math.max(0, leg.score + adj.delta);
              if (adj.note) leg.reason = leg.reason ? `${leg.reason}; ${adj.note}` : adj.note;
              if (adj.delta > 0) h2hBoosted += 1;
              if (adj.delta < 0) h2hPenalised += 1;
              if (import.meta.env?.DEV && h2hSamples.length < 6) h2hSamples.push({ delta: adj.delta, label: leg.label, family: leg.marketFamily, note: adj.note });
            }
          }
          applyThinRecentFormPenalty(leg, teamFormContext ?? null, h2hApplied);
          if (!shouldIncludeNonCornerTeamLegInPool(leg, headToHeadContext, teamFormContext ?? null)) {
            logTeamLegExclusion(leg, "needs 3+ recent league games per side or H2H sample ≥4");
            continue;
          }
          applyFixtureTeamFormToLegScore(leg, teamFormContext ?? null, headToHeadContext, teamNames);
          const arr = candidatesByMarketId.get(m.marketId) ?? [];
          arr.push(leg);
          candidatesByMarketId.set(m.marketId, arr);
          continue;
        }

        if (m.marketId === MARKET_ID_BTTS) {
          const out = parseBttsOutcome(rawLabel);
          if (!out) continue;
          const base = scoreTeamLegNoModel({ marketId: m.marketId, odds, line: null, outcomeLabel: out });
          const leg: BuildLeg = {
            id: `team-btts-${b.bookmakerId}-${out}-${odds}`,
            type: "team",
            marketId: m.marketId,
            marketFamily: "team:btts",
            label: `${m.marketName} ${out}`,
            marketName: m.marketName,
            line: 0,
            outcome: out,
            odds,
            bookmakerName: b.bookmakerName,
            score: base.score,
            reason: base.reason,
          };
          if (h2hApplied) {
            const adj = applyH2HAdjustmentsToTeamLeg(leg, headToHeadContext);
            if (adj.delta !== 0) {
              leg.score = Math.max(0, leg.score + adj.delta);
              if (adj.note) leg.reason = leg.reason ? `${leg.reason}; ${adj.note}` : adj.note;
              if (adj.delta > 0) h2hBoosted += 1;
              if (adj.delta < 0) h2hPenalised += 1;
              if (import.meta.env?.DEV && h2hSamples.length < 6) h2hSamples.push({ delta: adj.delta, label: leg.label, family: leg.marketFamily, note: adj.note });
            }
          }
          applyThinRecentFormPenalty(leg, teamFormContext ?? null, h2hApplied);
          if (!shouldIncludeNonCornerTeamLegInPool(leg, headToHeadContext, teamFormContext ?? null)) {
            logTeamLegExclusion(leg, "needs 3+ recent league games per side or H2H sample ≥4");
            continue;
          }
          applyFixtureTeamFormToLegScore(leg, teamFormContext ?? null, headToHeadContext, teamNames);
          const arr = candidatesByMarketId.get(m.marketId) ?? [];
          arr.push(leg);
          candidatesByMarketId.set(m.marketId, arr);
          continue;
        }

        if (m.marketId === MARKET_ID_HOME_TEAM_GOALS || m.marketId === MARKET_ID_AWAY_TEAM_GOALS || m.marketId === MARKET_ID_TEAM_TOTAL_GOALS) {
          const line = parseOverUnderLine(rawLabel);
          if (line == null) continue;
          const outcome: "Over" | "Under" = isOverLabel(rawLabel) ? "Over" : "Under";
          const base = scoreTeamLegNoModel({
            marketId: m.marketId,
            odds,
            line,
            outcomeLabel: `${outcome} ${line}`,
            marketName: m.marketName,
          });
          const isHome = m.marketId === MARKET_ID_HOME_TEAM_GOALS;
          const isAway = m.marketId === MARKET_ID_AWAY_TEAM_GOALS;
          const teamName = isHome ? teamNames.home : isAway ? teamNames.away : "Team";
          const teamId = isHome ? teamIds.home : isAway ? teamIds.away : null;
          const marketFamily = isHome ? "team:home-goals" : isAway ? "team:away-goals" : "team:team-goals";
          const leg: BuildLeg = {
            id: `team-tg-${m.marketId}-${b.bookmakerId}-${outcome}-${line}-${odds}`,
            type: "team",
            marketId: m.marketId,
            marketFamily,
            label: `${teamName} ${m.marketName} ${line} ${outcome}`,
            marketName: m.marketName,
            line,
            outcome,
            odds,
            bookmakerName: b.bookmakerName,
            score: base.score,
            reason: base.reason,
            ...(teamId != null ? { teamId: String(teamId) } : {}),
          };
          if (h2hApplied) {
            const adj = applyH2HAdjustmentsToTeamLeg(leg, headToHeadContext);
            if (adj.delta !== 0) {
              leg.score = Math.max(0, leg.score + adj.delta);
              if (adj.note) leg.reason = leg.reason ? `${leg.reason}; ${adj.note}` : adj.note;
              if (adj.delta > 0) h2hBoosted += 1;
              if (adj.delta < 0) h2hPenalised += 1;
              if (import.meta.env?.DEV && h2hSamples.length < 6) h2hSamples.push({ delta: adj.delta, label: leg.label, family: leg.marketFamily, note: adj.note });
            }
          }
          applyThinRecentFormPenalty(leg, teamFormContext ?? null, h2hApplied);
          if (!shouldIncludeNonCornerTeamLegInPool(leg, headToHeadContext, teamFormContext ?? null)) {
            logTeamLegExclusion(leg, "needs 3+ recent league games per side or H2H sample ≥4");
            continue;
          }
          applyFixtureTeamFormToLegScore(leg, teamFormContext ?? null, headToHeadContext, teamNames);
          const arr = candidatesByMarketId.get(m.marketId) ?? [];
          arr.push(leg);
          candidatesByMarketId.set(m.marketId, arr);
          continue;
        }

        if (isMatchTotalGoalsOuMarket(m.marketId, m.marketName)) {
          const line = parseOverUnderLine(rawLabel);
          if (line == null) continue;
          if (
            m.marketId !== MARKET_ID_MATCH_GOALS &&
            m.marketId !== MARKET_ID_ALTERNATIVE_TOTAL_GOALS &&
            !isSensibleMatchTotalGoalsLine(line)
          ) {
            continue;
          }
          const outcome: "Over" | "Under" = isOverLabel(rawLabel) ? "Over" : "Under";
          const base = scoreTeamLegNoModel({
            marketId: m.marketId,
            odds,
            line,
            outcomeLabel: `${outcome} ${line}`,
            marketName: m.marketName,
          });
          const leg: BuildLeg = {
            id: `team-ou-${m.marketId}-${b.bookmakerId}-${outcome}-${line}-${odds}`,
            type: "team",
            marketId: m.marketId,
            marketFamily: "team:match-goals",
            label: `${m.marketName} ${line} ${outcome}`,
            marketName: m.marketName,
            line,
            outcome,
            odds,
            bookmakerName: b.bookmakerName,
            score: base.score,
            reason: base.reason,
          };
          if (h2hApplied) {
            const adj = applyH2HAdjustmentsToTeamLeg(leg, headToHeadContext);
            if (adj.delta !== 0) {
              leg.score = Math.max(0, leg.score + adj.delta);
              if (adj.note) leg.reason = leg.reason ? `${leg.reason}; ${adj.note}` : adj.note;
              if (adj.delta > 0) h2hBoosted += 1;
              if (adj.delta < 0) h2hPenalised += 1;
              if (import.meta.env?.DEV && h2hSamples.length < 6) h2hSamples.push({ delta: adj.delta, label: leg.label, family: leg.marketFamily, note: adj.note });
            }
          }
          applyThinRecentFormPenalty(leg, teamFormContext ?? null, h2hApplied);
          if (!shouldIncludeNonCornerTeamLegInPool(leg, headToHeadContext, teamFormContext ?? null)) {
            logTeamLegExclusion(leg, "needs 3+ recent league games per side or H2H sample ≥4");
            continue;
          }
          applyFixtureTeamFormToLegScore(leg, teamFormContext ?? null, headToHeadContext, teamNames);
          const arr = candidatesByMarketId.get(m.marketId) ?? [];
          arr.push(leg);
          candidatesByMarketId.set(m.marketId, arr);
          continue;
        }
      }
    }
  }

  const nonCornerTeamLegs: BuildLeg[] = [];
  for (const [marketId, legs] of candidatesByMarketId.entries()) {
    legs.sort((a, b) => b.score - a.score);
    // Light dedupe by label+bookmaker to avoid noisy repeats.
    const seen = new Set<string>();
    const kept: BuildLeg[] = [];
    for (const l of legs) {
      const key = `${l.marketFamily}|${l.label}|${l.bookmakerName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(l);
      if (kept.length >= MAX_TEAM_LEGS_PER_MARKET) break;
    }
    nonCornerTeamLegs.push(...kept);
  }

  const allTeamLegs = [...nonCornerTeamLegs, ...cornersLegs];

  if (import.meta.env?.DEV) {
    const allowedCounts = new Map<number, number>();
    for (const x of allowedRaw) allowedCounts.set(x.marketId, (allowedCounts.get(x.marketId) ?? 0) + 1);
    const legsByFamily = new Map<string, number>();
    for (const l of allTeamLegs) legsByFamily.set(l.marketFamily, (legsByFamily.get(l.marketFamily) ?? 0) + 1);
    console.log("[build-value-bets] team markets intake", {
      rawMarketsSeenById: Array.from(byMarketIdRaw.entries()).sort((a, b) => a[0] - b[0]),
      allowedTeamMarketIds: Array.from(BUILD_TEAM_MARKET_IDS.values()).sort((a, b) => a - b),
      allowedSelectionCountByMarketId: Array.from(allowedCounts.entries()).sort((a, b) => a[0] - b[0]),
      finalTeamLegCount: allTeamLegs.length,
      finalTeamLegsByFamily: Array.from(legsByFamily.entries()).sort((a, b) => b[1] - a[1]),
      finalTeamLegSamples: allTeamLegs.slice(0, 10).map((l) => ({
        marketName: l.marketName,
        label: l.label,
        odds: l.odds,
        score: l.score,
        family: l.marketFamily,
      })),
    });
    console.log("[build-value-bets] H2H team-leg scoring", {
      applied: h2hApplied,
      sampleSize: headToHeadContext?.sampleSize ?? 0,
      averageTotalGoals: headToHeadContext?.averageTotalGoals ?? null,
      averageTotalCorners: headToHeadContext?.averageTotalCorners ?? null,
      bttsRate: headToHeadContext?.bttsRate ?? null,
      drawRate: headToHeadContext?.drawRate ?? null,
      boostedLegs: h2hBoosted,
      penalisedLegs: h2hPenalised,
      samples: h2hSamples,
      note: h2hApplied ? "H2H adjustments applied to team legs only" : "H2H missing/weak; team-leg scoring unchanged",
    });
  }

  const teamFiltered = allTeamLegs.filter((l) => isValidBuilderCandidate(l.odds, l.edge));
  if (import.meta.env?.DEV && teamFiltered.length !== allTeamLegs.length) {
    console.log("[build-value-bets] team legs filtered by odds/edge gate", {
      before: allTeamLegs.length,
      after: teamFiltered.length,
    });
  }
  return teamFiltered;
}

/** Get per90 and stat label for a player leg from rows (for explanation). */
function getPer90AndLabelForLeg(
  leg: BuildLeg,
  rows: PlayerCandidateInput[]
): { per90: number; statLabel: string } | null {
  if (leg.type !== "player" || !leg.playerName) return null;
  const cat = getMarketCategory(leg.marketName);
  if (cat == null) return null;
  let per90: number | null = null;
  let statLabel = "";
  if (cat === "shots") {
    per90 = getShotsPer90FromRows(leg.playerName, rows);
    statLabel = "shots";
  } else if (cat === "shotsOnTarget") {
    per90 = getShotsOnTargetPer90FromRows(leg.playerName, rows);
    statLabel = "shots on target";
  } else if (cat === "foulsCommitted") {
    per90 = getFoulsCommittedPer90FromRows(leg.playerName, rows);
    statLabel = "fouls committed";
  } else if (cat === "foulsWon") {
    per90 = getFoulsWonPer90FromRows(leg.playerName, rows);
    statLabel = "fouls won";
  } else if (cat === "tackles") {
    per90 = getTacklesPer90FromRows(leg.playerName, rows);
    statLabel = "tackles";
  }
  if (per90 == null || statLabel === "") return null;
  return { per90, statLabel };
}

/** Look up player recent evidence by normalized player name and market category. */
function getPlayerEvidence(
  playerName: string,
  marketCategory: string,
  evidence: BuildEvidenceContext["playerRecentStats"]
): { per90: number; recentValues: number[] } | null {
  if (!evidence?.length) return null;
  const key = `${normalizePlayerNameForMatch(playerName)}|${marketCategory}`;
  const found = evidence.find(
    (e) => `${normalizePlayerNameForMatch(e.playerName)}|${e.marketCategory}` === key && Array.isArray(e.recentValues) && e.recentValues.length > 0
  );
  return found ? { per90: found.per90, recentValues: found.recentValues } : null;
}

/** Evidence row for this player+market (even if recentValues empty) — for explanations. */
function lookupPlayerEvidenceForExplanation(
  playerName: string,
  marketCategory: string,
  evidence: BuildEvidenceContext["playerRecentStats"]
): { per90: number; recentValues: number[] } | null {
  if (!evidence?.length) return null;
  const key = `${normalizePlayerNameForMatch(playerName)}|${marketCategory}`;
  const found = evidence.find((e) => `${normalizePlayerNameForMatch(e.playerName)}|${e.marketCategory}` === key);
  if (!found) return null;
  const rv = Array.isArray(found.recentValues) ? found.recentValues : [];
  return { per90: found.per90, recentValues: rv };
}

function lookupPlayerH2hStatForExplanation(
  playerName: string,
  marketCategory: string,
  evidence: BuildEvidenceContext["playerH2hStats"]
): { values: number[]; startingAt?: string[] } | null {
  if (!evidence?.length) return null;
  const key = `${normalizePlayerNameForMatch(playerName)}|${marketCategory}`;
  for (const row of evidence) {
    const rowKey = `${normalizePlayerNameForMatch(row.playerName)}|${row.marketCategory}`;
    if (rowKey !== key) continue;
    if (!Array.isArray(row.values) || row.values.length === 0) continue;
    return {
      values: row.values.filter((v) => typeof v === "number" && Number.isFinite(v)),
      startingAt: Array.isArray(row.startingAt) ? row.startingAt : undefined,
    };
  }
  return null;
}

function formatPlayerH2hLine(values: number[], statLabel: string): string {
  const trimmed = values.filter((v) => typeof v === "number" && Number.isFinite(v)).slice(0, 5);
  if (trimmed.length === 0) return "";
  return `Last H2H (${trimmed.length}): ${trimmed.join(", ")} ${statLabel}.`;
}

function getExpectedMinutesForPlayer(playerName: string, rows: PlayerCandidateInput[]): number | null {
  const key = normalizePlayerNameForMatch(playerName);
  for (const r of rows) {
    if (normalizePlayerNameForMatch(r.playerName) !== key) continue;
    const m = r.modelInputs?.expectedMinutes;
    if (typeof m === "number" && Number.isFinite(m)) return m;
  }
  return null;
}

type MarketCat = NonNullable<ReturnType<typeof getMarketCategory>>;

function statLabelForCategory(cat: MarketCat | null): string {
  if (cat === "shots") return "shots";
  if (cat === "shotsOnTarget") return "shots on target";
  if (cat === "foulsCommitted") return "fouls committed";
  if (cat === "foulsWon") return "fouls won";
  if (cat === "tackles") return "tackles";
  return "";
}

function selectionTitleForPlayerLeg(leg: BuildLeg, cat: MarketCat | null, statLabel: string): string {
  if (typeof leg.line !== "number" || !Number.isFinite(leg.line)) return leg.label;
  if (cat === "shotsOnTarget") {
    if (leg.outcome === "Over") return `${Math.round(leg.line + 0.5)}+ Shot on Target`;
    return `Under ${leg.line % 1 === 0 ? `${leg.line}.0` : leg.line.toFixed(1)} Shot on Target`;
  }
  if (cat === "shots") {
    if (leg.outcome === "Over") return `${Math.round(leg.line + 0.5)}+ Shots`;
    return `Under ${leg.line % 1 === 0 ? `${leg.line}.0` : leg.line.toFixed(1)} Shots`;
  }
  if (cat === "foulsCommitted") {
    if (leg.outcome === "Over") return `${Math.round(leg.line + 0.5)}+ Fouls Committed`;
    return `Under ${leg.line % 1 === 0 ? `${leg.line}.0` : leg.line.toFixed(1)} Fouls Committed`;
  }
  if (cat === "foulsWon") {
    if (leg.outcome === "Over") return "to be fouled";
    return `Under ${leg.line % 1 === 0 ? `${leg.line}.0` : leg.line.toFixed(1)} Fouls Won`;
  }
  if (cat === "tackles") {
    if (leg.outcome === "Over") return `${Math.round(leg.line + 0.5)}+ Tackles`;
    return `Under ${leg.line % 1 === 0 ? `${leg.line}.0` : leg.line.toFixed(1)} Tackles`;
  }
  if (statLabel && (leg.outcome === "Over" || leg.outcome === "Under")) {
    const st = statLabel
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    if (leg.outcome === "Over") return `${Math.round(leg.line + 0.5)}+ ${st}`;
    return `Under ${leg.line % 1 === 0 ? `${leg.line}.0` : leg.line.toFixed(1)} ${st}`;
  }
  return leg.label;
}

const TIPSTER_BANNED_REASON_FRAG = /\b(underlying rate|stable minutes|reliable sample|recent form|consistent involvement|limited signal|solid underlying|open football|physical opposition)\b/i;

function shortFallbackContextLine(cat: MarketCat | null): string {
  // One sentence only: tight, market-specific, and betting-style.
  if (cat === "foulsCommitted") return "Recent foul counts support this line.";
  if (cat === "foulsWon") return "Recent drawn-foul numbers support this line.";
  if (cat === "tackles") return "Recent tackle volumes support this line.";
  if (cat === "shotsOnTarget") return "Recent SOT volume supports this line.";
  if (cat === "shots") return "Recent shot volume supports this line.";
  return "Recent involvement supports this angle.";
}

/**
 * Use leg.reason segments that mention opponent / fouls / matchup / shot angle; drop generic filler.
 */
function extractTipsterContextFromReason(reason: string | null | undefined): string | null {
  if (!reason?.trim()) return null;
  const parts = reason
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const p of parts) {
    if (TIPSTER_BANNED_REASON_FRAG.test(p)) continue;
    if (/^\d+\.?\d*\s*%\s*edge\b/i.test(p)) continue;
    const low = p.toLowerCase();
    if (
      low.includes("opponent") ||
      low.includes("matchup") ||
      low.includes("foul") ||
      (low.includes("attacking") && (low.includes("shot") || low.includes("wing") || low.includes("angle"))) ||
      (low.includes("draws") && low.includes("foul")) ||
      (low.includes("commit") && low.includes("foul")) ||
      low.includes("flank") ||
      low.includes("tackle") ||
      low.includes("role") && (low.includes("foul") || low.includes("shot"))
    ) {
      const t = p.endsWith(".") ? p : `${p}.`;
      return t.charAt(0).toUpperCase() + t.slice(1);
    }
  }
  return null;
}

function trimTrailingBlankLines(block: string[]): string[] {
  const out = [...block];
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * Tipster-style block: ✍️ header, optional recent series (>=3 games, full join without spaces), context, optional opponentStatSeries.
 */
function buildPlayerLegTipsterExplanation(
  leg: BuildLeg,
  cat: MarketCat | null,
  statLabel: string,
  evidenceEntry: { per90: number; recentValues: number[] } | null,
  h2hEntry: { values: number[]; startingAt?: string[] } | null,
  playerRows: PlayerCandidateInput[]
): string[] {
  if (!leg.playerName) return [];

  const title = selectionTitleForPlayerLeg(leg, cat, statLabel);
  const out: string[] = [];
  out.push(`✍️ ${leg.playerName} ${title}`);
  out.push("");

  const rawSeries =
    evidenceEntry?.recentValues?.filter((v) => typeof v === "number" && Number.isFinite(v)) ?? [];
  const hasRecentBlock = rawSeries.length >= 3;

  if (import.meta.env?.DEV) {
    console.log("[explanation-debug]", {
      playerName: leg.playerName,
      hasEvidenceEntry: Boolean(evidenceEntry),
      hasRecent: hasRecentBlock,
      seriesLength: rawSeries.length,
    });
  }

  if (hasRecentBlock) {
    const expMin = getExpectedMinutesForPlayer(leg.playerName, playerRows);
    if (expMin != null && expMin >= 30) {
      const displayValues = [...rawSeries].reverse();
      out.push(`Recent apps (30+ mins): Recent:${displayValues.join(",")}`);
    } else {
      // Keep legacy "Recent starts:" two-line format.
      out.push("Recent starts:");
      out.push(rawSeries.join(","));
    }
    out.push("");
  }

  if (
    rawSeries.length >= PLAYER_PROP_MIN_RECENT_GAMES &&
    cat != null &&
    (leg.outcome === "Over" || leg.outcome === "Under")
  ) {
    const recentGames = rawSeries.slice(-PLAYER_PROP_RECENT_WINDOW);
    const hits = countOutcomeHits(recentGames, leg.line, leg.outcome);
    const rate = hits / recentGames.length;
    const note =
      rate >= PLAYER_PROP_STRONG_HIT_RATE
        ? "strong signal"
        : rate >= 0.5
          ? "solid signal"
          : "above builder floor";
    out.push(`Hits: ${hits}/${recentGames.length} (${leg.outcome} line ${leg.line}) — ${note}`);
    out.push("");
  }

  if (rawSeries.length >= 3) {
    const recentGames = rawSeries.slice(-PLAYER_PROP_RECENT_WINDOW);
    const avg = recentGames.reduce((s, v) => s + v, 0) / recentGames.length;
    out.push(`Recent avg (last ${recentGames.length}): ${avg.toFixed(2)} ${statLabel}.`);
  }
  if (evidenceEntry?.per90 != null && Number.isFinite(evidenceEntry.per90)) {
    const expMin = getExpectedMinutesForPlayer(leg.playerName, playerRows);
    if (expMin != null && expMin >= 30) {
      const expectedCount = (evidenceEntry.per90 * expMin) / 90;
      out.push(
        `Season rate: ${evidenceEntry.per90.toFixed(2)} ${statLabel} per90; ~${expectedCount.toFixed(2)} at ${Math.round(expMin)} mins.`
      );
    } else {
      out.push(`Season rate: ${evidenceEntry.per90.toFixed(2)} ${statLabel} per90.`);
    }
  }

  const fromReason = extractTipsterContextFromReason(leg.reason);
  out.push(fromReason ?? shortFallbackContextLine(cat));
  if (h2hEntry && Array.isArray(h2hEntry.values) && h2hEntry.values.length > 0) {
    const line = formatPlayerH2hLine(h2hEntry.values, statLabel);
    if (line) out.push(line);
  }
  if (leg.opponentContextLine) out.push(leg.opponentContextLine);
  if (leg.h2hContextLine) out.push(leg.h2hContextLine);

  const opp = leg.opponentStatSeries;
  if (
    opp &&
    typeof opp.label === "string" &&
    opp.label.trim() !== "" &&
    Array.isArray(opp.values) &&
    opp.values.length > 0 &&
    opp.values.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    out.push("");
    out.push(opp.label.trim());
    out.push(opp.values.join(","));
  }

  return trimTrailingBlankLines(out);
}

/** Build factual explanation lines for a combo from available stats. Uses evidence context when provided for evidence-style lines. */
function buildComboExplanation(
  combo: BuildCombo,
  playerRows: PlayerCandidateInput[],
  fixtureCornersContext: FixtureCornersContext | null,
  evidenceContext: BuildEvidenceContext | null,
  headToHeadContext?: HeadToHeadFixtureContext | null,
  teamFormContext?: FixtureTeamFormContext | null,
  teamGoalLineStats?: Record<number, TeamSeasonGoalLineStats | null | undefined>
): ComboExplanation {
  const lines: string[] = [];

  const homeName = evidenceContext?.homeTeamName?.trim() || "Home";
  const awayName = evidenceContext?.awayTeamName?.trim() || "Away";

  function isWeakGenericReason(reason: string): boolean {
    const r = (reason ?? "").toLowerCase();
    if (!r.trim()) return true;
    return (
      r.includes("common total-goals line") ||
      r.includes("reasonable total-goals line") ||
      r.includes("less common total-goals line") ||
      r.includes("best-rated corners line") ||
      r.includes("fixture corners projection supports this line") ||
      r.includes("line sits close to model expectation") ||
      r.includes("team market leg")
    );
  }

  for (const leg of combo.legs) {
    if (leg.type === "player") {
      const cat = getMarketCategory(leg.marketName);
      const evidenceEntry =
        evidenceContext?.playerRecentStats?.length && cat != null
          ? lookupPlayerEvidenceForExplanation(leg.playerName!, cat, evidenceContext.playerRecentStats)
          : null;
      const h2hEntry =
        evidenceContext?.playerH2hStats?.length && cat != null
          ? lookupPlayerH2hStatForExplanation(leg.playerName!, cat, evidenceContext.playerH2hStats)
          : null;
      const data = getPer90AndLabelForLeg(leg, playerRows);
      const statLabel = data?.statLabel || statLabelForCategory(cat);

      if (!leg.playerName) continue;
      const legLines = buildPlayerLegTipsterExplanation(leg, cat, statLabel, evidenceEntry, h2hEntry, playerRows);
      if (legLines.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push(...legLines);
      }
    } else if (leg.type === "team" && leg.marketName?.toLowerCase().includes("corner")) {
      // Prefer concrete H2H corners sequences when available; otherwise keep quiet (avoid filler).
      const cornerBits: string[] = [];
      if (leg.legRole !== "filler") {
        cornerBits.push(`✍️ ${leg.label}`);
        cornerBits.push("");
        if (evidenceContext?.cornersH2hTotals?.length) {
          const recent = evidenceContext.cornersH2hTotals.slice(-6);
          cornerBits.push("Recent H2H totals:");
          cornerBits.push(recent.join(","));
        }
      }
      if (leg.legRole !== "filler" && leg.reason && leg.reason.trim()) {
        const rr = leg.reason.trim();
        if (!isWeakGenericReason(rr) && rr.toLowerCase().includes("h2h")) cornerBits.push(rr);
      }
      while (cornerBits.length > 0 && cornerBits[cornerBits.length - 1] === "") {
        cornerBits.pop();
      }
      if (cornerBits.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push(...cornerBits);
      }
    } else if (leg.type === "team") {
      if (leg.legRole === "filler") {
        // Avoid attaching high-confidence support language to filler legs.
        continue;
      }
      const teamLines = buildTeamPropExplanationLines(leg, teamFormContext ?? null, headToHeadContext ?? null, {
        home: homeName,
        away: awayName,
      }, teamGoalLineStats);
      const structuredTeamWhy =
        isTeamMatchTotalGoalsLeg(leg) ||
        leg.marketFamily === "team:btts" ||
        leg.marketFamily === "team:match-results";
      if (
        leg.reason &&
        leg.reason.trim() &&
        !isWeakGenericReason(leg.reason) &&
        !(structuredTeamWhy && teamLines.length > 0)
      ) {
        const rr = leg.reason.trim();
        if (!teamLines.some((x) => x.includes(rr.slice(0, Math.min(40, rr.length))))) {
          teamLines.push(rr);
        }
      }
      if (teamLines.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push(`✍️ ${leg.label}`);
        lines.push("");
        lines.push(...teamLines);
      }
    }
  }

  const out = lines.some((s) => s.length > 0) ? lines : [];
  if (BUILDER_DEBUG_VERBOSE && combo.legs.length > 0 && out.length > 0) {
    const playerEvidenceUsed = combo.legs
      .filter((l) => l.type === "player")
      .map((l) => {
        const cat = getMarketCategory(l.marketName);
        const ent =
          cat != null && evidenceContext?.playerRecentStats?.length
            ? lookupPlayerEvidenceForExplanation(l.playerName!, cat, evidenceContext.playerRecentStats)
            : null;
        const rv = ent?.recentValues?.filter((v) => typeof v === "number" && Number.isFinite(v)) ?? [];
        return {
          player: l.playerName,
          market: cat,
          hasRecent: rv.length >= 3,
          seriesLength: rv.length,
        };
      });
    console.log("[build-value-bets][verbose] explanation payload", {
      legCount: combo.legs.length,
      lines: out,
      playerEvidenceUsed,
      cornersH2h: evidenceContext?.cornersH2hTotals?.length ?? 0,
    });
  }
  return { lines: out };
}

/** Reject combos that contain more than one leg from the same market family (overlap). */
function hasSameFamilyOverlap(legs: BuildLeg[]): boolean {
  const families = new Set(legs.map((l) => l.marketFamily));
  return families.size < legs.length;
}

function getCorrelationPenalty(a: BuildLeg, b: BuildLeg): number {
  // SAME PLAYER (strong correlation)
  if (a.playerId && b.playerId && a.playerId === b.playerId) return 0.15;

  // SAME TEAM + similar team-goals markets (medium correlation)
  if (
    a.type === "team" &&
    b.type === "team" &&
    ((a.teamId && b.teamId && a.teamId === b.teamId) || (isTeamMatchTotalGoalsLeg(a) && isTeamMatchTotalGoalsLeg(b)))
  ) {
    return 0.08;
  }

  // GOALS + BTTS overlap
  const aIsGoals = isTeamMatchTotalGoalsLeg(a);
  const bIsGoals = isTeamMatchTotalGoalsLeg(b);
  const aIsBtts = a.marketId === MARKET_ID_BTTS;
  const bIsBtts = b.marketId === MARKET_ID_BTTS;
  if ((aIsGoals && bIsBtts) || (aIsBtts && bIsGoals)) return 0.1;

  return 0;
}

/**
 * Kelly stake fraction (½ Kelly): b = odds − 1, p = win prob, q = 1 − p,
 * full Kelly = (b·p − q) / b. Non-positive or invalid → 0; full Kelly capped at 5%; then × ½.
 */
function computeKellyStakePct(combinedOdds: number, combinedProb: number): number {
  const b = combinedOdds - 1;
  if (!Number.isFinite(combinedOdds) || !Number.isFinite(combinedProb) || b <= 1e-12) return 0;
  const p = Math.max(0, Math.min(1, combinedProb));
  const q = 1 - p;
  const kelly = (b * p - q) / b;
  if (!Number.isFinite(kelly) || kelly <= 0) return 0;
  const capped = Math.min(kelly, KELLY_FULL_CAP);
  return capped * KELLY_FRACTIONAL;
}

/**
 * Max product of exactly `k` legs from legs[i..] with strictly increasing indices (for optimistic pruning).
 */
function buildSuffixMaxLegProducts(legs: BuildLeg[], maxK: number): number[][] {
  const n = legs.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(maxK + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i]![0] = 1;

  for (let i = n - 1; i >= 0; i--) {
    for (let k = 1; k <= maxK; k++) {
      let best = 0;
      const maxJ = n - k;
      for (let j = i; j <= maxJ; j++) {
        const v = legs[j]!.odds * dp[j + 1]![k - 1]!;
        if (v > best) best = v;
      }
      dp[i]![k] = best;
    }
  }
  return dp;
}

/** Prefer stronger model edges, then longer prices, then leg score (reliability proxy). */
function compareBuilderLegsForSearch(a: BuildLeg, b: BuildLeg): number {
  const ea = Number.isFinite(a.edge as number) ? (a.edge as number) : -Infinity;
  const eb = Number.isFinite(b.edge as number) ? (b.edge as number) : -Infinity;
  if (ea !== eb) return eb - ea;
  if (a.odds !== b.odds) return b.odds - a.odds;
  const sa = a.score ?? 0;
  const sb = b.score ?? 0;
  if (sa !== sb) return sb - sa;
  return (a.id ?? "").localeCompare(b.id ?? "");
}

/** Generate multi-leg combos (2–maxLegs) near target odds: stop each branch once odds ≥ target; cap overshoot; prune dead ends. */
export function generateCombos(
  legs: BuildLeg[],
  targetOdds: number,
  options: { maxCombos?: number; maxLegs?: number; sortMode?: "target" | "ev"; allowBelowTarget?: boolean } = {}
): BuildCombo[] {
  const { maxCombos = 50, maxLegs: maxLegsOpt, sortMode = "target", allowBelowTarget = false } = options;
  const MAX_LEGS = Math.max(COMBO_MIN_LEGS, Math.min(maxLegsOpt ?? COMBO_MAX_LEGS_CAP, COMBO_MAX_LEGS_CAP));
  const MIN_LEGS = COMBO_MIN_LEGS;
  const combos: BuildCombo[] = [];
  const used = new Set<string>();
  let rejectedOverlap = 0;
  const n = legs.length;

  if (n < MIN_LEGS || !Number.isFinite(targetOdds) || targetOdds < 1.001) {
    return [];
  }

  const suffixDp = buildSuffixMaxLegProducts(legs, MAX_LEGS);
  const targetCap = sortMode === "target" ? targetOdds * COMBO_MAX_ODDS_MULTIPLIER : Number.POSITIVE_INFINITY;
  const pruneEps = 1e-9;
  let verboseComboLogCount = 0;

  function pushCombo(selected: BuildLeg[], indices: number[]) {
    if (hasSameFamilyOverlap(selected)) {
      rejectedOverlap += 1;
      return;
    }
    const combinedOdds = selected.reduce((acc, leg) => acc * leg.odds, 1);
    const distanceFromTarget = Math.abs(combinedOdds - targetOdds);
    const comboScore = selected.reduce((s, leg) => s + leg.score, 0);
    const comboEdge = selected.reduce((s, leg) => s + (Number.isFinite(leg.edge as number) ? (leg.edge as number) : 0), 0);
    const combinedProbRaw = selected.reduce((acc, leg) => {
      const fallbackProb = leg.odds > 0 ? 1 / leg.odds : 0;
      const legProb = Number.isFinite(leg.probability as number) ? (leg.probability as number) : fallbackProb;
      return acc * clamp01(legProb);
    }, 1);
    let correlationPenalty = 0;
    for (let i = 0; i < selected.length; i++) {
      for (let j = i + 1; j < selected.length; j++) {
        correlationPenalty += getCorrelationPenalty(selected[i]!, selected[j]!);
      }
    }
    const boundedPenalty = Math.max(0, Math.min(0.9, correlationPenalty));
    const combinedProb = clamp01(combinedProbRaw * (1 - boundedPenalty));
    const impliedProb = combinedOdds > 0 ? 1 / combinedOdds : 0;
    const comboEV = combinedProb - impliedProb;
    const comboEVPercent = combinedProb * combinedOdds - 1;
    const kellyStakePct = computeKellyStakePct(combinedOdds, combinedProb);
    const adjustedComboEdge = comboEdge * (1 - boundedPenalty);
    const lowOddsPenalty = selected.filter((l) => l.odds < BUILDER_RANK_LOW_ODDS_LINE).length * BUILDER_RANK_LOW_ODDS_PENALTY_EACH;
    const rankingComboEdge = comboEdge - lowOddsPenalty;
    const key = indices.slice().sort((a, b) => a - b).join(",");
    if (!used.has(key)) {
      used.add(key);
      const fingerprint = comboFingerprintFromLegs(selected);
      combos.push({
        legs: selected,
        fingerprint,
        combinedOdds,
        distanceFromTarget,
        comboScore,
        comboEdge,
        adjustedComboEdge,
        rankingComboEdge,
        combinedProb,
        impliedProb,
        comboEV,
        comboEVPercent,
        kellyStakePct,
      });
      if (BUILDER_DEBUG_VERBOSE && verboseComboLogCount < 40) {
        verboseComboLogCount += 1;
        console.log("[build-value-bets] combo branch", { legs: selected.length, odds: combinedOdds });
      }
    }
  }

  function recurse(start: number, indices: number[]) {
    const L = indices.length;
    const P = L === 0 ? 1 : indices.reduce((acc, i) => acc * legs[i]!.odds, 1);

    if (L >= MIN_LEGS && P > targetCap) return;

    if (L >= MIN_LEGS && P >= targetOdds) {
      pushCombo(
        indices.map((i) => legs[i]!),
        indices
      );
      return;
    }

    if (allowBelowTarget && L >= MAX_LEGS) {
      pushCombo(
        indices.map((i) => legs[i]!),
        indices
      );
      return;
    }

    if (L >= MAX_LEGS) return;

    if (L + (n - start) < MIN_LEGS) return;

    const slotsLeft = MAX_LEGS - L;
    const canPick = Math.min(slotsLeft, n - start);
    if (canPick <= 0) return;

    const minExtra = L >= MIN_LEGS ? 1 : MIN_LEGS - L;
    if (minExtra > canPick) return;

    let maxAchievable = 0;
    for (let t = minExtra; t <= canPick; t++) {
      const ext = suffixDp[start]![t] ?? 0;
      const cand = P * ext;
      if (cand > maxAchievable) maxAchievable = cand;
    }
    if (!allowBelowTarget && maxAchievable < targetOdds - pruneEps) return;

    for (let i = start; i < n; i++) {
      const cand = legs[i]!;
      if (L >= 2 && cand.odds < BUILDER_FILLER_ODDS_MAX) continue;
      indices.push(i);
      recurse(i + 1, indices);
      indices.pop();
    }
  }

  recurse(0, []);

  if (import.meta.env?.DEV && rejectedOverlap > 0) {
    console.log("[build-value-bets] combos rejected for same-family overlap", rejectedOverlap);
  }

  const evFiltered = combos.filter((c) => c.comboEV >= MIN_COMBO_EV);
  const baseCombos = evFiltered.length > 0 ? evFiltered : combos;

  // If a nearby positive-edge combo exists (within +/-0.1 distance), deprioritize negative-edge alternatives.
  const DISTANCE_EDGE_WINDOW = 0.1;
  const nearbyPositiveExists = baseCombos.some(
    (c) =>
      c.comboEV > 0 &&
      baseCombos.some(
        (other) =>
          other !== c &&
          other.comboEV < 0 &&
          Math.abs(other.distanceFromTarget - c.distanceFromTarget) <= DISTANCE_EDGE_WINDOW
      )
  );
  const rankedSource = nearbyPositiveExists ? baseCombos.filter((c) => c.comboEV >= 0) : baseCombos;

  rankedSource.sort((a, b) => {
    if (sortMode === "ev") {
      if (a.comboEV !== b.comboEV) return b.comboEV - a.comboEV;
      if (a.rankingComboEdge !== b.rankingComboEdge) return b.rankingComboEdge - a.rankingComboEdge;
      if (a.legs.length !== b.legs.length) return a.legs.length - b.legs.length;
      if (a.distanceFromTarget !== b.distanceFromTarget) return a.distanceFromTarget - b.distanceFromTarget;
      return (a.fingerprint ?? "").localeCompare(b.fingerprint ?? "");
    }
    if (a.distanceFromTarget !== b.distanceFromTarget) return a.distanceFromTarget - b.distanceFromTarget;
    if (a.rankingComboEdge !== b.rankingComboEdge) return b.rankingComboEdge - a.rankingComboEdge;
    if (a.legs.length !== b.legs.length) return a.legs.length - b.legs.length;
    if (a.comboScore !== b.comboScore) return b.comboScore - a.comboScore;
    if (a.comboEV !== b.comboEV) return b.comboEV - a.comboEV;
    return (a.fingerprint ?? "").localeCompare(b.fingerprint ?? "");
  });

  return rankedSource.slice(0, maxCombos);
}

/** Full pipeline: filter player candidates, add model-based corner legs, apply matchup boost, generate and rank combos (no same-family overlap). */
export function buildValueBetCombos(
  playerRows: PlayerCandidateInput[],
  fixtureOddsBookmakers: OddsBookmakerInput[] | null,
  targetOdds: number,
  options: {
    maxCombos?: number;
    fixtureCornersContext?: FixtureCornersContext | null;
    lineupContext?: LineupContext | null;
    evidenceContext?: BuildEvidenceContext | null;
    headToHeadContext?: HeadToHeadFixtureContext | null;
    teamFormContext?: FixtureTeamFormContext | null;
    teamGoalLineStats?: Record<number, TeamSeasonGoalLineStats | null | undefined>;
    teamIds?: { home: number | null; away: number | null };
    sortMode?: "target" | "ev";
  } = {}
): { combos: BuildCombo[]; candidateCount: number; legCount: number } {
  const {
    fixtureCornersContext = null,
    lineupContext = null,
    evidenceContext = null,
    headToHeadContext = null,
    teamFormContext = null,
    teamGoalLineStats = undefined,
    teamIds = { home: null, away: null },
  } = options;
  const playerLegs = filterPlayerCandidates(playerRows, evidenceContext, lineupContext);
  applyFoulMatchupBoost(playerLegs, playerRows, lineupContext);
  applyShotMatchupBoost(playerLegs, playerRows, lineupContext);
  applyH2hContextToPlayerLegs(playerLegs, headToHeadContext);
  const teamLegs =
    fixtureOddsBookmakers != null
      ? getTeamLegsFromOdds(
          fixtureOddsBookmakers,
          fixtureCornersContext,
          headToHeadContext,
          teamFormContext,
          {
            home: evidenceContext?.homeTeamName?.trim() || "Home",
            away: evidenceContext?.awayTeamName?.trim() || "Away",
          },
          teamIds
        )
      : [];
  const sortMode = options.sortMode ?? "target";
  const playerOnlyLegs = [...playerLegs];
  playerOnlyLegs.sort(compareBuilderLegsForSearch);
  const allLegs = [...playerLegs, ...teamLegs];
  allLegs.sort(compareBuilderLegsForSearch);

  type PlayerCat = "shots" | "shotsOnTarget" | "foulsWon" | "foulsCommitted" | "tackles";
  const playerCats: PlayerCat[] = ["shots", "shotsOnTarget", "foulsWon", "foulsCommitted", "tackles"];
  const countByPlayerCat = (legs: Array<BuildLeg>): Record<PlayerCat, number> => {
    const out = { shots: 0, shotsOnTarget: 0, foulsWon: 0, foulsCommitted: 0, tackles: 0 };
    for (const l of legs) {
      if (l.type !== "player") continue;
      const cat = getMarketCategory(l.marketName);
      if (cat && (playerCats as string[]).includes(cat)) out[cat as PlayerCat] += 1;
    }
    return out;
  };
  const countCombosByPlayerCatPresence = (combosArr: BuildCombo[]): Record<PlayerCat, number> => {
    const out = { shots: 0, shotsOnTarget: 0, foulsWon: 0, foulsCommitted: 0, tackles: 0 };
    for (const c of combosArr) {
      const catsInCombo = new Set<PlayerCat>();
      for (const l of c.legs) {
        if (l.type !== "player") continue;
        const cat = getMarketCategory(l.marketName);
        if (cat && (playerCats as string[]).includes(cat)) catsInCombo.add(cat as PlayerCat);
      }
      for (const cat of catsInCombo) out[cat] += 1;
    }
    return out;
  };
  const rawRowsByPlayerCat: Record<PlayerCat, number> = { shots: 0, shotsOnTarget: 0, foulsWon: 0, foulsCommitted: 0, tackles: 0 };
  for (const r of playerRows) {
    const cat = getMarketCategory(r.marketName);
    if (cat && (playerCats as string[]).includes(cat)) rawRowsByPlayerCat[cat as PlayerCat] += 1;
  }

  if (import.meta.env?.DEV) {
    const byMarket = new Map<string, number>();
    for (const r of playerRows) {
      const cat = getMarketCategory(r.marketName) ?? "other";
      byMarket.set(cat, (byMarket.get(cat) ?? 0) + 1);
    }
    const byMarketAfter = new Map<string, number>();
    for (const l of playerLegs) {
      const cat = getMarketCategory(l.marketName) ?? "other";
      byMarketAfter.set(cat, (byMarketAfter.get(cat) ?? 0) + 1);
    }
    const sortedByScore = [...allLegs].sort((a, b) => b.score - a.score);
    console.log("[build-value-bets] candidates", {
      playerRows: playerRows.length,
      playerLegsAfterFilter: playerLegs.length,
      teamLegs: teamLegs.length,
      totalLegs: allLegs.length,
      playerRowsByMarket: Array.from(byMarket.entries()),
      playerLegsByMarketAfterFilter: Array.from(byMarketAfter.entries()),
      topLegsByScore: sortedByScore.slice(0, 8).map((l) => ({
        label: l.label,
        score: l.score,
        marketCategory: getMarketCategory(l.marketName) ?? "other",
        playerTier: l.playerQuality?.playerTier,
        playerLegQualityScore: l.playerQuality?.qualityScore,
        sampleReliability: l.playerQuality?.sampleReliability,
        minutesReliability: l.playerQuality?.minutesReliability,
        recencyScore: l.playerQuality?.recencyScore,
        roleConsistencyScore: l.playerQuality?.roleConsistencyScore,
        marketSpecificScore: l.playerQuality?.marketSpecificScore,
        weakSignalFlags: l.playerQuality?.weakSignalFlags,
        explanationSourceFlags: l.playerQuality?.explanationSourceFlags,
      })),
    });
    if (playerLegs.length > 0) {
      console.log("[build-value-bets] top player legs", playerLegs.slice(0, 5).map((l) => ({ label: l.label, odds: l.odds, score: l.score })));
      console.log(
        "[player-tiering]",
        playerLegs.slice(0, 5).map((l) => ({
          player: l.playerName,
          market: getMarketCategory(l.marketName),
          line: l.line,
          tier: l.playerQuality?.playerTier,
          qualityScore: l.playerQuality?.qualityScore,
          sampleReliability: l.playerQuality?.sampleReliability,
          minutesReliability: l.playerQuality?.minutesReliability,
          recencyScore: l.playerQuality?.recencyScore,
        }))
      );
    }
  }

  const finalMaxRequested = options.maxCombos ?? 30;
  const finalMax = Math.min(6, finalMaxRequested);
  const internalMax = Math.max(finalMax, finalMax * DIVERSITY_INTERNAL_MULTIPLIER);
  let combos = generateCombos(playerOnlyLegs, targetOdds, { maxCombos: internalMax, maxLegs: COMBO_MAX_LEGS_CAP, sortMode });
  if (combos.length === 0) {
    combos = generateCombos(playerOnlyLegs, targetOdds, {
      maxCombos: internalMax,
      maxLegs: COMBO_MAX_LEGS_CAP,
      sortMode,
      allowBelowTarget: true,
    });
  }
  if (combos.length === 0 && teamLegs.length > 0) {
    combos = generateCombos(allLegs, targetOdds, { maxCombos: internalMax, maxLegs: COMBO_MAX_LEGS_CAP, sortMode });
    if (combos.length === 0) {
      combos = generateCombos(allLegs, targetOdds, {
        maxCombos: internalMax,
        maxLegs: COMBO_MAX_LEGS_CAP,
        sortMode,
        allowBelowTarget: true,
      });
    }
    const playerCounts = combos.map((c) => c.legs.filter((l) => l.type === "player").length);
    const maxPlayerLegs = Math.max(0, ...playerCounts);
    if (maxPlayerLegs > 0) {
      combos = combos.filter((c) => c.legs.filter((l) => l.type === "player").length === maxPlayerLegs);
    }
  }
  const generatedCount = combos.length;

  const h2hOkForCounts = headToHeadContext?.sampleSize != null && headToHeadContext?.sampleSize >= MIN_H2H_SAMPLE_SIZE;
  const roundLine = (x: number) => Number(x.toFixed(1));
  const h2hGoalsLineCountsByRoundedLine = new Map<number, { over: number; under: number; sampleSize: number }>();
  if (h2hOkForCounts && Array.isArray(headToHeadContext?.goalsLineCounts)) {
    for (const row of headToHeadContext!.goalsLineCounts!) {
      if (typeof row?.line === "number" && Number.isFinite(row.line)) {
        h2hGoalsLineCountsByRoundedLine.set(roundLine(row.line), {
          over: row.over,
          under: row.under,
          sampleSize: row.sampleSize,
        });
      }
    }
  }

  function isSupportedTeamLeg(leg: BuildLeg): boolean {
    if (leg.type !== "team") return true;

    const formStrong = isFormContextStrong(teamFormContext);
    if (formStrong) {
      if (isTeamMatchTotalGoalsLeg(leg)) return true;
      if (leg.marketFamily === "team:btts") return true;
      if (leg.marketFamily === "team:match-results") return true;
    }

    // H2H-supported when we have enough sample for the specific market family.
    if (h2hOkForCounts) {
      if (leg.marketFamily === "team:match-results") {
        const n = headToHeadContext?.resultSampleSize ?? headToHeadContext?.sampleSize ?? 0;
        if (n >= MIN_H2H_SAMPLE_SIZE) {
          if (leg.outcome === "Home") return (headToHeadContext?.team1WinCount ?? 0) > 0;
          if (leg.outcome === "Away") return (headToHeadContext?.team2WinCount ?? 0) > 0;
          if (leg.outcome === "Draw") return (headToHeadContext?.drawCount ?? 0) > 0;
        }
      }
      if (leg.marketFamily === "team:btts") {
        const n = headToHeadContext?.bttsSampleSize ?? headToHeadContext?.sampleSize ?? 0;
        if (n >= MIN_H2H_SAMPLE_SIZE) {
          if (leg.outcome === "Yes") return (headToHeadContext?.bttsYesCount ?? 0) > 0;
          if (leg.outcome === "No") return (n - (headToHeadContext?.bttsYesCount ?? 0)) > 0;
        }
      }
      if (isTeamMatchTotalGoalsLeg(leg)) {
        const row = h2hGoalsLineCountsByRoundedLine.get(roundLine(leg.line));
        if (row && row.sampleSize >= MIN_H2H_SAMPLE_SIZE) {
          if (leg.outcome === "Over") return row.over > 0;
          if (leg.outcome === "Under") return row.under > 0;
        }
      }
    }

    // Fallback: treat legs with meaningful internal plausibility score as "supported".
    if (leg.marketFamily === CORNERS_MARKET_FAMILY) {
      return Boolean(fixtureCornersContext) || Boolean(evidenceContext?.cornersH2hTotals?.length);
    }
    // If we have enough head-to-head sample, do not "guess" support using odds band alone.
    if (h2hOkForCounts) return false;
    return leg.score >= 14;
  }

  function getLegRole(leg: BuildLeg): "core" | "supporting" | "filler" {
    if (leg.type === "player") return "core";
    return isSupportedTeamLeg(leg) ? "supporting" : "filler";
  }

  // Central role classification used by scoring and explanation alignment.
  for (const leg of allLegs) {
    leg.legRole = getLegRole(leg);
  }

  function computeSupportedTeamCounts(combo: BuildCombo): { supported: number; unsupported: number } {
    const teamLegs = combo.legs.filter((l) => l.type === "team");
    let supported = 0;
    for (const l of teamLegs) {
      const role = l.legRole ?? getLegRole(l);
      if (role === "supporting") supported += 1;
    }
    return { supported, unsupported: teamLegs.length - supported };
  }

  function computeLegRoleBreakdown(combo: BuildCombo): { core: number; supporting: number; filler: number } {
    const out = { core: 0, supporting: 0, filler: 0 };
    for (const l of combo.legs) {
      const role = l.legRole ?? getLegRole(l);
      out[role] += 1;
    }
    return out;
  }

  type TeamLegMarginalValue = "additive" | "weaklyAdditive" | "lowMarginalValue";

  function isBroadAlternativeGoalsLeg(leg: BuildLeg): boolean {
    if (leg.marketId !== MARKET_ID_ALTERNATIVE_TOTAL_GOALS || !isTeamMatchTotalGoalsLeg(leg)) return false;
    if (leg.outcome === "Over") return leg.line <= 1.5;
    if (leg.outcome === "Under") return leg.line >= 4.5;
    return false;
  }

  function getPlayerMarketCategories(combo: BuildCombo): Set<string> {
    const out = new Set<string>();
    for (const l of combo.legs) {
      if (l.type !== "player") continue;
      const cat = getMarketCategory(l.marketName);
      if (cat) out.add(cat);
    }
    return out;
  }

  function isTeamLegReinforcingPlayerStory(combo: BuildCombo, leg: BuildLeg): boolean {
    if (leg.type !== "team") return false;
    const playerCats = getPlayerMarketCategories(combo);
    if (playerCats.size === 0) return false;
    const impl = getTeamLegImplications(leg);
    const hasShotsLike = playerCats.has("shots") || playerCats.has("shotsOnTarget");
    const hasFoulsLike =
      playerCats.has("foulsCommitted") || playerCats.has("foulsWon") || playerCats.has("tackles");

    if (hasShotsLike) {
      if (impl.some((i) => i.kind === "btts" && i.value === true)) return true;
      if (impl.some((i) => i.kind === "minGoals" && i.value >= 2)) return true;
      if (impl.some((i) => i.kind === "result" && (i.value === "home" || i.value === "away"))) return true;
    }
    if (hasFoulsLike) {
      if (impl.some((i) => i.kind === "result" && i.value === "draw")) return true;
      if (impl.some((i) => i.kind === "maxGoals" && i.value <= 3)) return true;
    }
    return false;
  }

  function classifyTeamLegMarginalValue(combo: BuildCombo, leg: BuildLeg): TeamLegMarginalValue {
    if (leg.type !== "team") return "additive";
    const role = leg.legRole ?? getLegRole(leg);
    const ownImpl = getTeamLegImplications(leg);
    const otherImplKinds = new Set<string>();
    for (const other of combo.legs) {
      if (other === leg || other.type !== "team") continue;
      for (const i of getTeamLegImplications(other)) otherImplKinds.add(i.kind);
    }
    const addsNewKind = ownImpl.some((i) => !otherImplKinds.has(i.kind));
    const reinforces = isTeamLegReinforcingPlayerStory(combo, leg);
    const broadAlt = isBroadAlternativeGoalsLeg(leg);

    if (role === "filler") {
      if (broadAlt || !reinforces) return "lowMarginalValue";
      return "weaklyAdditive";
    }

    if (role === "supporting") {
      if (addsNewKind || reinforces) return broadAlt && !reinforces ? "weaklyAdditive" : "additive";
      return broadAlt ? "lowMarginalValue" : "weaklyAdditive";
    }

    return addsNewKind || reinforces ? "additive" : "weaklyAdditive";
  }

  function getTeamLegConfidenceScore(combo: BuildCombo, leg: BuildLeg): number {
    if (leg.type !== "team") return 0;
    const role = leg.legRole ?? getLegRole(leg);
    if (role !== "supporting") return 0;

    let score = 0;
    const reinforces = isTeamLegReinforcingPlayerStory(combo, leg);
    if (reinforces) score += 2;
    if (classifyTeamLegMarginalValue(combo, leg) === "additive") score += 2;

    // Stronger H2H confidence only when sample is available and signal is meaningfully one-sided.
    if (h2hOkForCounts) {
      if (leg.marketFamily === "team:btts") {
        const n = headToHeadContext?.bttsSampleSize ?? headToHeadContext?.sampleSize ?? 0;
        const yes = headToHeadContext?.bttsYesCount ?? 0;
        if (n >= MIN_H2H_SAMPLE_SIZE) {
          const rate = leg.outcome === "Yes" ? yes / n : (n - yes) / n;
          if (rate >= 0.6) score += 2;
          if (rate >= 0.75) score += 1;
        }
      } else if (leg.marketFamily === "team:match-results") {
        const n = headToHeadContext?.resultSampleSize ?? headToHeadContext?.sampleSize ?? 0;
        if (n >= MIN_H2H_SAMPLE_SIZE) {
          let rate = 0;
          if (leg.outcome === "Home") rate = (headToHeadContext?.team1WinCount ?? 0) / n;
          else if (leg.outcome === "Away") rate = (headToHeadContext?.team2WinCount ?? 0) / n;
          else if (leg.outcome === "Draw") rate = (headToHeadContext?.drawCount ?? 0) / n;
          if (rate >= 0.5) score += 2;
          if (rate >= 0.65) score += 1;
        }
      } else if (isTeamMatchTotalGoalsLeg(leg)) {
        const row = h2hGoalsLineCountsByRoundedLine.get(roundLine(leg.line));
        if (row && row.sampleSize >= MIN_H2H_SAMPLE_SIZE) {
          const rate = leg.outcome === "Over" ? row.over / row.sampleSize : row.under / row.sampleSize;
          if (rate >= 0.6) score += 2;
          if (rate >= 0.75) score += 1;
        }
      }
    }

    if (isFormContextStrong(teamFormContext)) score += 2;

    return score;
  }

  function isHighConfidenceSupportingTeamLeg(combo: BuildCombo, leg: BuildLeg): boolean {
    if (leg.type !== "team") return false;
    const role = leg.legRole ?? getLegRole(leg);
    if (role !== "supporting") return false;
    return getTeamLegConfidenceScore(combo, leg) >= 5;
  }

  function computeComboQualitySignals(c: BuildCombo): {
    lowMarginalValueTeamLegCount: number;
    additiveTeamLegCount: number;
    weaklyAdditiveTeamLegCount: number;
    highConfidenceTeamLegCount: number;
    teamLegQualityScore: number;
    oddsFittingPenalty: number;
    playerLedQualityBonus: number;
    mixedComboBonusApplied: number;
    tokenTeamLegPenalty: number;
    shapePreferenceScore: number;
    isPlayerOnly: boolean;
  } {
    const teamLegs = c.legs.filter((l) => l.type === "team");
    const roleCounts = computeLegRoleBreakdown(c);
    const playerLegCount = c.legs.filter((l) => l.type === "player").length;
    const isPlayerOnly = teamLegs.length === 0;
    let low = 0;
    let additive = 0;
    let weak = 0;
    let highConfidence = 0;
    let qualityScore = 0;
    let reinforcingTeamLegCount = 0;
    for (const t of teamLegs) {
      const mv = classifyTeamLegMarginalValue(c, t);
      if (mv === "lowMarginalValue") low += 1;
      else if (mv === "additive") additive += 1;
      else weak += 1;
      const legQuality = getTeamLegConfidenceScore(c, t);
      qualityScore += legQuality;
      if (isHighConfidenceSupportingTeamLeg(c, t)) highConfidence += 1;
      if (isTeamLegReinforcingPlayerStory(c, t)) reinforcingTeamLegCount += 1;
    }

    let oddsFittingPenalty = 0;
    if (playerLegCount === 1 && roleCounts.supporting + roleCounts.filler >= 1) oddsFittingPenalty += SCORING_CONFIG.comboQuality.onePlayerWithAnyTeamPenalty;
    if (low >= 1) oddsFittingPenalty += SCORING_CONFIG.comboQuality.oneLowMarginalPenalty;
    if (low >= 2) oddsFittingPenalty += SCORING_CONFIG.comboQuality.twoLowMarginalPenalty;
    if (playerLegCount === 1 && roleCounts.filler >= 1 && additive === 0) oddsFittingPenalty += SCORING_CONFIG.comboQuality.onePlayerFillerNoAdditivePenalty;
    // Soft max-1 team leg preference: 2+ team legs are expensive unless both are high-confidence.
    if (teamLegs.length >= 2 && highConfidence < 2) oddsFittingPenalty += SCORING_CONFIG.comboQuality.multiTeamNotAllHighConfidencePenalty;
    if (teamLegs.length >= 2 && highConfidence >= 2) oddsFittingPenalty += SCORING_CONFIG.comboQuality.multiTeamAllHighConfidencePenalty;

    let playerLedQualityBonus = 0;
    if (playerLegCount >= 2 && roleCounts.filler === 0) playerLedQualityBonus += SCORING_CONFIG.comboQuality.playerLedNoFillerBonus;
    if (playerLegCount >= 2 && additive >= 1) playerLedQualityBonus += SCORING_CONFIG.comboQuality.playerLedAdditiveBonus;
    if (playerLegCount >= 2 && low === 0) playerLedQualityBonus += SCORING_CONFIG.comboQuality.playerLedNoLowMarginalBonus;
    // Explicit protection for clean player-only builds.
    if (isPlayerOnly && playerLegCount >= 2 && roleCounts.filler === 0) playerLedQualityBonus += SCORING_CONFIG.comboQuality.playerOnlyProtectionBonus;

    // Mixed-combo bonus is conditional, not structural.
    // Only apply when the single team leg is truly high-confidence, additive, and story-reinforcing.
    let mixedComboBonusApplied = 0;
    if (playerLegCount >= 1 && teamLegs.length === 1 && highConfidence >= 1 && additive >= 1 && reinforcingTeamLegCount >= 1 && low === 0) {
      mixedComboBonusApplied = SCORING_CONFIG.comboQuality.mixedSingleTeamLegBonus;
    }

    // Token team-leg penalty: team leg present but contributes little scenario value.
    let tokenTeamLegPenalty = 0;
    if (teamLegs.length > 0 && (additive === 0 || highConfidence === 0 || reinforcingTeamLegCount === 0)) {
      tokenTeamLegPenalty += SCORING_CONFIG.comboQuality.tokenTeamLegPenalty;
    }
    if (teamLegs.length > 0 && low >= 1) tokenTeamLegPenalty += SCORING_CONFIG.comboQuality.tokenLowMarginalExtraPenalty;

    const shapePreferenceScore = playerLedQualityBonus + mixedComboBonusApplied - tokenTeamLegPenalty;

    return {
      lowMarginalValueTeamLegCount: low,
      additiveTeamLegCount: additive,
      weaklyAdditiveTeamLegCount: weak,
      highConfidenceTeamLegCount: highConfidence,
      teamLegQualityScore: qualityScore,
      oddsFittingPenalty,
      playerLedQualityBonus,
      mixedComboBonusApplied,
      tokenTeamLegPenalty,
      shapePreferenceScore,
      isPlayerOnly,
    };
  }

  function computeComboScoreBreakdown(c: BuildCombo): ComboScoreBreakdown {
    const playerLegs = c.legs.filter((l) => l.type === "player");
    const playerCount = playerLegs.length;
    if (playerCount === 0) {
      return {
        multiPlayerBase: 0,
        fillerPenalty: 0,
        fillerAltGoalsPenalty: 0,
        scenarioCohesionBonus: 0,
        onePlayerAllFillerPenalty: 0,
        supportSignal: 0,
        qualitySignals: 0,
        playerCoherence: 0,
        eliteCoherenceBonus: 0,
        tierComboShaping: 0,
        total: -20,
      };
    }
    const eliteLegCount = playerLegs.filter((l) => l.playerQuality?.playerTier === "elite").length;
    const weakLegCount = playerLegs.filter((l) => l.playerQuality?.playerTier === "weak").length;
    const okLegCount = playerLegs.filter((l) => l.playerQuality?.playerTier === "ok").length;

    const { supported, unsupported } = computeSupportedTeamCounts(c);
    const roleCounts = computeLegRoleBreakdown(c);
    const fillerLegCount = roleCounts.filler;
    const coreLegCount = roleCounts.core;
    const supportingTeamLegCount = supported;
    const allTeamLegsAreFiller = c.legs.filter((l) => l.type === "team").every((l) => (l.legRole ?? getLegRole(l)) === "filler");
    const quality = computeComboQualitySignals(c);
    const playerCoherence = computePlayerLegCoherenceSignals(c);

    let multiPlayerBase = 0;
    let fillerPenalty = 0;
    let fillerAltGoalsPenalty = 0;
    let scenarioCohesionBonus = 0;
    let onePlayerAllFillerPenalty = 0;
    let supportSignal = 0;
    let qualitySignals = 0;
    let eliteCoherenceBonus = 0;
    let tierComboShaping = 0;

    // Existing signal: reward multi-player structure without forcing it.
    if (playerCount >= 2) {
      multiPlayerBase += Math.min(
        SCORING_CONFIG.combo.multiPlayerBaseCap,
        (playerCount - 1) * SCORING_CONFIG.combo.multiPlayerBasePerLeg
      );
    }

    // Filler dependence penalty (scaled).
    if (fillerLegCount >= 1) fillerPenalty -= SCORING_CONFIG.combo.fillerPenaltyOne;
    if (fillerLegCount >= 2) fillerPenalty -= SCORING_CONFIG.combo.fillerPenaltyTwoPlus;
    if (coreLegCount === 1 && fillerLegCount >= 2) fillerPenalty -= SCORING_CONFIG.combo.singleCoreTwoPlusFillerPenalty; // directly targets 1 core + 2 padding legs.

    // Specific filler padding hotspot: alternative goals totals used without evidence support.
    const fillerAltGoalsCount = c.legs.filter(
      (l) => l.type === "team" && l.marketId === MARKET_ID_ALTERNATIVE_TOTAL_GOALS && isTeamMatchTotalGoalsLeg(l)
    )
      .filter((l) => classifyTeamLegMarginalValue(c, l) === "lowMarginalValue").length;
    fillerAltGoalsPenalty -= fillerAltGoalsCount * SCORING_CONFIG.combo.fillerAltGoalsPenalty;

    // Scenario cohesion bonus: >=2 core legs plus at least one supporting team leg.
    if (coreLegCount >= 2 && supportingTeamLegCount >= 1) scenarioCohesionBonus += SCORING_CONFIG.combo.scenarioCohesionBonus;

    // Weak shape penalty: one player prop + random filler team legs.
    if (playerCount === 1 && allTeamLegsAreFiller) onePlayerAllFillerPenalty -= SCORING_CONFIG.combo.onePlayerAllFillerPenalty;

    // Keep support-aware signal as soft ranking (not hard gate).
    supportSignal += Math.min(SCORING_CONFIG.combo.supportingTeamBonusCap, supportingTeamLegCount * SCORING_CONFIG.combo.supportingTeamPerLegBonus);
    supportSignal -= unsupported * SCORING_CONFIG.combo.unsupportedTeamPerLegPenalty;

    // Marginal-value and odds-fitting quality layer.
    qualitySignals += quality.playerLedQualityBonus;
    qualitySignals += quality.mixedComboBonusApplied;
    qualitySignals -= quality.tokenTeamLegPenalty;
    qualitySignals -= quality.oddsFittingPenalty;
    qualitySignals += quality.additiveTeamLegCount * SCORING_CONFIG.combo.additiveTeamLegBonus;
    qualitySignals -= quality.lowMarginalValueTeamLegCount * SCORING_CONFIG.combo.lowMarginalTeamLegPenalty;

    // Player-leg coherence layer (story over collection).
    const playerCoherenceComponent = playerCoherence.coherenceScore;
    if (eliteLegCount >= 1 && playerCoherence.coherenceScore >= 8) eliteCoherenceBonus += SCORING_CONFIG.combo.eliteCoherenceBonus;
    if (eliteLegCount >= 2 && playerCoherence.coherenceScore >= 12) eliteCoherenceBonus += SCORING_CONFIG.combo.multiEliteCoherenceBonus;

    // Tier-based combo shaping: elite legs should separate top combos; weak/flat clusters should sink.
    if (playerCount >= 2 && eliteLegCount >= 1) tierComboShaping += SCORING_CONFIG.combo.eliteComboBonus;
    if (eliteLegCount >= 2) tierComboShaping += SCORING_CONFIG.combo.multiEliteBonus;
    if (weakLegCount >= 1) tierComboShaping -= weakLegCount * SCORING_CONFIG.combo.weakLegPenaltyPerLeg;
    if (playerCount >= 2 && weakLegCount + okLegCount >= 2) tierComboShaping -= SCORING_CONFIG.combo.flatComboPenalty;

    const total =
      multiPlayerBase +
      fillerPenalty +
      fillerAltGoalsPenalty +
      scenarioCohesionBonus +
      onePlayerAllFillerPenalty +
      supportSignal +
      qualitySignals +
      playerCoherenceComponent +
      eliteCoherenceBonus +
      tierComboShaping;

    return {
      multiPlayerBase,
      fillerPenalty,
      fillerAltGoalsPenalty,
      scenarioCohesionBonus,
      onePlayerAllFillerPenalty,
      supportSignal,
      qualitySignals,
      playerCoherence: playerCoherenceComponent,
      eliteCoherenceBonus,
      tierComboShaping,
      total,
    };
  }

  function computeComboCoherenceDelta(c: BuildCombo): number {
    return computeComboScoreBreakdown(c).total;
  }

  function computePlayerLegCoherenceSignals(combo: BuildCombo): {
    sameTeamClusterCount: number;
    attackingClusterCount: number;
    defensiveClusterCount: number;
    mixedTeamSpread: number;
    coherenceScore: number;
  } {
    const playerLegs = combo.legs.filter((l) => l.type === "player");
    if (playerLegs.length <= 1) {
      return { sameTeamClusterCount: 0, attackingClusterCount: 0, defensiveClusterCount: 0, mixedTeamSpread: 0, coherenceScore: 0 };
    }

    const byTeam = new Map<string, BuildLeg[]>();
    for (const l of playerLegs) {
      const teamKey = l.marketFamily.split("|")[0] ?? "unknown-team";
      const arr = byTeam.get(teamKey) ?? [];
      arr.push(l);
      byTeam.set(teamKey, arr);
    }

    let sameTeamClusterCount = 0;
    let attackingClusterCount = 0;
    let defensiveClusterCount = 0;
    let coherenceScore = 0;

    for (const legs of byTeam.values()) {
      if (legs.length >= 2) {
        sameTeamClusterCount += 1;
        coherenceScore += SCORING_CONFIG.playerCoherence.sameTeamBaseBonus;
      }
      if (legs.length >= 3) coherenceScore += SCORING_CONFIG.playerCoherence.sameTeamTripleBonus;

      const cats = legs.map((l) => getMarketCategory(l.marketName) ?? "other");
      const shotsCount = cats.filter((c) => c === "shots").length;
      const sotCount = cats.filter((c) => c === "shotsOnTarget").length;
      const foulsCommittedCount = cats.filter((c) => c === "foulsCommitted").length;
      const foulsWonCount = cats.filter((c) => c === "foulsWon").length;
      const tacklesCount = cats.filter((c) => c === "tackles").length;

      if (shotsCount >= 1 && sotCount >= 1) {
        attackingClusterCount += 1;
        coherenceScore += SCORING_CONFIG.playerCoherence.attackingShotsSotBonus;
      }
      if (shotsCount + sotCount >= 2) {
        attackingClusterCount += 1;
        coherenceScore += SCORING_CONFIG.playerCoherence.attackingMultiBonus;
      }
      if (
        foulsCommittedCount >= 2 ||
        foulsWonCount >= 2 ||
        (foulsCommittedCount >= 1 && foulsWonCount >= 1) ||
        tacklesCount >= 2 ||
        (tacklesCount >= 1 && (foulsCommittedCount >= 1 || foulsWonCount >= 1))
      ) {
        defensiveClusterCount += 1;
        coherenceScore += SCORING_CONFIG.playerCoherence.defensiveClusterBonus;
      }
    }

    const mixedTeamSpread = byTeam.size >= playerLegs.length ? 1 : 0;
    if (mixedTeamSpread && attackingClusterCount === 0 && defensiveClusterCount === 0 && sameTeamClusterCount === 0) {
      coherenceScore -= SCORING_CONFIG.playerCoherence.randomSpreadPenalty;
    }

    // Compress into practical bands (0/4/8/12 style) while preserving small negatives.
    let banded = 0;
    if (coherenceScore >= SCORING_CONFIG.playerCoherence.bands.veryStrongMin) banded = SCORING_CONFIG.playerCoherence.bands.veryStrongScore;
    else if (coherenceScore >= SCORING_CONFIG.playerCoherence.bands.strongMin) banded = SCORING_CONFIG.playerCoherence.bands.strongScore;
    else if (coherenceScore >= SCORING_CONFIG.playerCoherence.bands.decentMin) banded = SCORING_CONFIG.playerCoherence.bands.decentScore;
    else if (coherenceScore <= SCORING_CONFIG.playerCoherence.bands.negativeMax) banded = SCORING_CONFIG.playerCoherence.bands.negativeScore;

    return {
      sameTeamClusterCount,
      attackingClusterCount,
      defensiveClusterCount,
      mixedTeamSpread,
      coherenceScore: banded,
    };
  }

  // Physical props preference: boost combos that contain fouls / tackles legs when available.
  const hasAnyFoulsLegs = allLegs.some((l) => l.type === "player" && isPhysicalPlayerPropCategory(getMarketCategory(l.marketName)));
  if (hasAnyFoulsLegs) {
    combos = combos.map((c) => {
      const foulsLegCount = c.legs.filter(
        (l) => l.type === "player" && isPhysicalPlayerPropCategory(getMarketCategory(l.marketName))
      ).length;
      let bonus = 0;
      if (foulsLegCount >= 1) bonus += 18;
      if (foulsLegCount >= 2) bonus += 6;
      return {
        ...c,
        comboScore: c.comboScore + bonus,
      };
    });
    combos.sort((a, b) => b.comboScore - a.comboScore);
  }

  // Coherence tuning: shift comboScore towards more meaningful multi-player builds.
  // This is a soft ranking adjustment only; it does not change generation, and all sanity/diversity protections still apply.
  combos = combos.map((c) => {
    const delta = computeComboCoherenceDelta(c);
    return { ...c, comboScore: c.comboScore + delta };
  });
  // Re-order for ranking after score adjustment.
  combos.sort((a, b) => {
    if (a.comboScore !== b.comboScore) return b.comboScore - a.comboScore;
    if (a.distanceFromTarget !== b.distanceFromTarget) return a.distanceFromTarget - b.distanceFromTarget;
    return (a.fingerprint ?? "").localeCompare(b.fingerprint ?? "");
  });

  const generatedCombosByPlayerCatPresence = countCombosByPlayerCatPresence(combos);

  // Sanity filter: remove unrealistic/overly narrow or redundant market stacks (post-generation, pre-diversity).
  const sanityBefore = combos.length;
  const sanityReasons: Record<ComboSanityRejectReason, number> = {
    multipleGoalsTotals: 0,
    narrowGoalWindow: 0,
    redundantImpliedMarket: 0,
    redundantImpliedMarketUnder: 0,
    contradictoryImplication: 0,
    duplicateBtts: 0,
    duplicateResult: 0,
  };
  const sanitySamples: Array<{ reason: ComboSanityRejectReason; score: number; legs: string[] }> = [];
  combos = combos.filter((c) => {
    const reason = getComboSanityRejectReason(c);
    if (!reason) return true;
    sanityReasons[reason] += 1;
    if (BUILDER_DEBUG_VERBOSE && sanitySamples.length < 3) {
      const goalsNorm = c.legs.map(normaliseGoalsTotalLeg).filter((x): x is NormalisedGoalsTotalLeg => x != null);
      sanitySamples.push({
        reason,
        score: c.comboScore,
        legs: [
          ...c.legs.map((l) => `${l.label} [${l.marketFamily} | ${String(l.outcome)} | ${String(l.line)}]`),
          ...(goalsNorm.length > 0
            ? [`goalsNormalised=${goalsNorm.map((g) => `${g.direction}:${g.line}`).join(",")}`]
            : []),
        ],
      });
    }
    return false;
  });
  const sanityRejected = sanityBefore - combos.length;
  const postSanityCombosByPlayerCatPresence = countCombosByPlayerCatPresence(combos);
  const postSanityCombosSnapshot = combos;
  const postSanityCount = combos.length;

  // Diversity pass: remove near-duplicates (same market families) and select a varied final top N.
  const preDiversityCount = combos.length;
  const { selected, nearDuplicatesRemoved } = selectDiverseTopCombos(combos, finalMax);
  combos = selected;
  const postDiversityCombosByPlayerCatPresence = countCombosByPlayerCatPresence(combos);
  const postDiversityCombosSnapshot = combos;
  const postDiversityCount = combos.length;

  // Final guard: ensure *returned* combos are sensible even if any upstream step changes.
  // (This should be a no-op when the pipeline is correct, but guarantees the UI never sees invalid combos.)
  const postDiversityBefore = combos.length;
  combos = combos.filter(isComboSensible);
  const finalGuardRemoved = postDiversityBefore - combos.length;
  const postFinalGuardCountStrict = combos.length;

  let postFinalGuardCombosByPlayerCatPresence = countCombosByPlayerCatPresence(combos);

  // Guarded fallback: if strict filtering collapses to 0 combos,
  // recover from the best earlier stage while still respecting sanity.
  let fallbackActivated = false;
  let fallbackSourceStage: "postDiversity" | "postSanity" | null = null;
  if (combos.length === 0 && generatedCount > 0) {
    fallbackActivated = true;
    if (postDiversityCombosSnapshot.length > 0) {
      fallbackSourceStage = "postDiversity";
      combos = postDiversityCombosSnapshot;
    } else if (postSanityCombosSnapshot.length > 0) {
      fallbackSourceStage = "postSanity";
      combos = [...postSanityCombosSnapshot]
        .sort((a, b) => {
          if (a.distanceFromTarget !== b.distanceFromTarget) return a.distanceFromTarget - b.distanceFromTarget;
          if (a.rankingComboEdge !== b.rankingComboEdge) return b.rankingComboEdge - a.rankingComboEdge;
          if (a.legs.length !== b.legs.length) return a.legs.length - b.legs.length;
          return b.comboScore - a.comboScore;
        })
        .slice(0, finalMax);
    }
  }

  // Keep stage counters consistent when fallback rehydrates the combo set.
  postFinalGuardCombosByPlayerCatPresence = countCombosByPlayerCatPresence(combos);

  // Final output cap: keep only the best 2–3 combos.
  // We already capped with `finalMax` (<=3) and diversity, but do a conservative quality cut for the 3rd-best combo.
  if (combos.length > 1) {
    const bestByLegs = new Map<string, BuildCombo>();
    for (const c of combos) {
      const sig = comboLegIdentitySignature(c);
      const prev = bestByLegs.get(sig);
      if (!prev || c.comboScore > prev.comboScore) {
        bestByLegs.set(sig, c);
      }
    }
    combos = Array.from(bestByLegs.values());
  }
  combos = [...combos].sort((a, b) => {
    if (a.comboScore !== b.comboScore) return b.comboScore - a.comboScore;
    if (a.distanceFromTarget !== b.distanceFromTarget) return a.distanceFromTarget - b.distanceFromTarget;
    return (a.fingerprint ?? "").localeCompare(b.fingerprint ?? "");
  });
  if (combos.length === 3) {
    const top = combos[0]!;
    const third = combos[2]!;
    const qualityGap = top.comboScore - third.comboScore;
    const distanceGap = third.distanceFromTarget - top.distanceFromTarget;
    if (qualityGap > 8 || distanceGap > 0.25) {
      combos = combos.slice(0, 2);
    }
  }
  const finalReturnedCombosByPlayerCatPresence = countCombosByPlayerCatPresence(combos);

  const scoreMinFinal = combos.length > 0 ? Math.min(...combos.map((c) => c.comboScore)) : 0;
  const scoreMaxFinal = combos.length > 0 ? Math.max(...combos.map((c) => c.comboScore)) : 0;
  const getNormalizedFinal = (score: number): number => {
    return getCompressedNormalizedScore(score, scoreMinFinal, scoreMaxFinal);
  };

  combos = combos.map((c) => ({
    ...c,
    fingerprint: c.fingerprint ?? comboFingerprintFromLegs(c.legs),
    normalizedScore: getNormalizedFinal(c.comboScore),
    scoreBreakdown: computeComboScoreBreakdown(c),
    explanation: buildComboExplanation(
      c,
      playerRows,
      fixtureCornersContext,
      evidenceContext,
      headToHeadContext,
      teamFormContext,
      teamGoalLineStats
    ),
  }));

  // Deterministic exact-content dedupe and invariant checks for EV/stake.
  {
    const byFp = new Map<string, BuildCombo[]>();
    for (const c of combos) {
      const fp = c.fingerprint ?? comboFingerprintFromLegs(c.legs);
      const arr = byFp.get(fp);
      if (arr) arr.push(c);
      else byFp.set(fp, [c]);
    }
    if (import.meta.env?.DEV) {
      for (const [fp, arr] of byFp.entries()) {
        if (arr.length <= 1) continue;
        const base = arr[0]!;
        for (let i = 1; i < arr.length; i++) {
          const other = arr[i]!;
          const evMismatch = Math.abs(base.comboEVPercent - other.comboEVPercent) > 1e-9;
          const stakeMismatch = Math.abs((base.kellyStakePct ?? 0) - (other.kellyStakePct ?? 0)) > 1e-9;
          if (evMismatch || stakeMismatch) {
            console.error("[build-bet invariant violation] same fingerprint with mismatched EV/stake", {
              fingerprint: fp,
              base: {
                comboEVPercent: base.comboEVPercent,
                kellyStakePct: base.kellyStakePct,
                combinedOdds: base.combinedOdds,
              },
              other: {
                comboEVPercent: other.comboEVPercent,
                kellyStakePct: other.kellyStakePct,
                combinedOdds: other.combinedOdds,
              },
            });
          }
        }
      }
    }
    combos = [...byFp.entries()]
      .map(([, arr]) =>
        arr.sort((a, b) => {
          if (a.comboScore !== b.comboScore) return b.comboScore - a.comboScore;
          if (a.comboEVPercent !== b.comboEVPercent) return b.comboEVPercent - a.comboEVPercent;
          if (a.distanceFromTarget !== b.distanceFromTarget) return a.distanceFromTarget - b.distanceFromTarget;
          return (a.fingerprint ?? "").localeCompare(b.fingerprint ?? "");
        })[0]!
      )
      .sort((a, b) => {
        if (a.comboScore !== b.comboScore) return b.comboScore - a.comboScore;
        if (a.distanceFromTarget !== b.distanceFromTarget) return a.distanceFromTarget - b.distanceFromTarget;
        return (a.fingerprint ?? "").localeCompare(b.fingerprint ?? "");
      });
  }

  // HARD ASSERT (dev only): ensure nothing with narrow goal-window slips through to UI.
  if (import.meta.env?.DEV) {
    for (const c of combos) {
      if (hasNarrowGoalWindow(c)) {
        console.error("[FATAL] invalid combo passed filter (narrowGoalWindow)", {
          combinedOdds: c.combinedOdds,
          distanceFromTarget: c.distanceFromTarget,
          comboScore: c.comboScore,
          legs: c.legs.map((l) => ({
            label: l.label,
            marketFamily: l.marketFamily,
            outcome: l.outcome,
            line: l.line,
          })),
          goalsNormalised: c.legs
            .map(normaliseGoalsTotalLeg)
            .filter((x): x is NormalisedGoalsTotalLeg => x != null)
            .map((g) => ({ direction: g.direction, line: g.line, label: g.label })),
        });
      }
    }
  }

  if (BUILDER_DEBUG_VERBOSE && combos.length > 0) {
    const combosWithFouls = combos.filter((c) =>
      c.legs.some((l) => l.type === "player" && isPhysicalPlayerPropCategory(getMarketCategory(l.marketName)))
    );
    console.log("[build-value-bets] combo fouls stats", {
      totalCombos: combos.length,
      combosWithFouls: combosWithFouls.length,
      combosWithoutFouls: combos.length - combosWithFouls.length,
    });
    const cornersCount = combos.filter((c) => comboHasCorners(c)).length;
    const playerCounts = new Map<string, number>();
    const marketCounts = new Map<string, number>();
    const marketFamilyCounts = new Map<string, number>();
    for (const c of combos) {
      for (const p of comboPlayerKeys(c)) playerCounts.set(p, (playerCounts.get(p) ?? 0) + 1);
      for (const l of c.legs) {
        const cat =
          l.marketFamily === CORNERS_MARKET_FAMILY
            ? "corners"
            : l.type === "player"
              ? getMarketCategory(l.marketName) ?? "playerOther"
              : "teamOther";
        marketCounts.set(cat, (marketCounts.get(cat) ?? 0) + 1);
        marketFamilyCounts.set(l.marketFamily, (marketFamilyCounts.get(l.marketFamily) ?? 0) + 1);
      }
    }
    const topRepeatedPlayers = Array.from(playerCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([player, count]) => ({ player, count }));
    const topMarketFamilies = Array.from(marketFamilyCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([marketFamily, count]) => ({ marketFamily, count }));
    console.log("[build-value-bets] diversity stats", {
      generatedBeforeDiversity: preDiversityCount,
      returnedAfterDiversity: combos.length,
      nearDuplicatesRemoved,
      returnedCombosWithCorners: cornersCount,
      returnedCombosWithoutCorners: combos.length - cornersCount,
      returnedLegsByMarketCategory: Array.from(marketCounts.entries()).sort((a, b) => b[1] - a[1]),
      topRepeatedPlayers,
      topMarketFamilies,
    });
    console.log(
      "[build-value-bets] combos",
      combos.length,
      "top",
      combos.slice(0, 3).map((c) => ({
        combinedOdds: c.combinedOdds.toFixed(2),
        distance: c.distanceFromTarget.toFixed(2),
        score: c.comboScore,
        playerLegCount: c.legs.filter((l) => l.type === "player").length,
        legs: c.legs.map((l) => l.label),
        hasFoulsLeg: c.legs.some((l) => l.type === "player" && isPhysicalPlayerPropCategory(getMarketCategory(l.marketName))),
        explanationLines: c.explanation?.lines.length ?? 0,
      }))
    );
  }

  if (import.meta.env?.DEV) {
    const scoreMin = combos.length > 0 ? Math.min(...combos.map((c) => c.comboScore)) : 0;
    const scoreMax = combos.length > 0 ? Math.max(...combos.map((c) => c.comboScore)) : 0;
    const scoreRange = scoreMax - scoreMin;
    const getNormalizedScore = (score: number): number => {
      return getCompressedNormalizedScore(score, scoreMin, scoreMax);
    };

    const returnedPlayerLegStats = {
      byCategory: {} as Record<string, number>,
      byMarketFamily: {} as Record<string, number>,
      foulsLegCount: 0,
    };
    for (const c of combos) {
      for (const p of c.legs) {
        if (p.type !== "player") continue;
        const cat = getMarketCategory(p.marketName) ?? "other";
        returnedPlayerLegStats.byCategory[cat] = (returnedPlayerLegStats.byCategory[cat] ?? 0) + 1;
        returnedPlayerLegStats.byMarketFamily[p.marketFamily] = (returnedPlayerLegStats.byMarketFamily[p.marketFamily] ?? 0) + 1;
        if (isPhysicalPlayerPropCategory(cat)) returnedPlayerLegStats.foulsLegCount += 1;
      }
    }

    console.log("[build-value-bets] summary", {
      generated: generatedCount,
      rejectedBySanity: sanityRejected,
      finalGuardRemoved,
      nearDuplicatesRemoved,
      returned: combos.length,
      sanityReasonsBreakdown: sanityReasons,
      returnedPlayerLegsByCategory: returnedPlayerLegStats.byCategory,
      returnedFoulsPlayerLegCount: returnedPlayerLegStats.foulsLegCount,
      pipelineSummary: {
        rowsByFamily: rawRowsByPlayerCat,
        candidateLegsByFamily: countByPlayerCat(playerLegs),
        generatedCombosByFamilyPresence: generatedCombosByPlayerCatPresence,
        postSanityCombosByFamilyPresence: postSanityCombosByPlayerCatPresence,
        postSanityCount,
        postDiversityCombosByFamilyPresence: postDiversityCombosByPlayerCatPresence,
        postDiversityCount,
        postFinalGuardCombosByFamilyPresence: postFinalGuardCombosByPlayerCatPresence,
        postFinalGuardCountStrict: postFinalGuardCountStrict,
        finalReturnedCombosByFamilyPresence: finalReturnedCombosByPlayerCatPresence,
        finalReturnedCount: combos.length,
        rejectedForContradiction: sanityReasons.contradictoryImplication,
        rejectedForNarrowGoalWindow: sanityReasons.narrowGoalWindow,
        rejectedForRedundancy: sanityReasons.redundantImpliedMarket + sanityReasons.redundantImpliedMarketUnder,
        downrankedForUnsupportedTeamLeg: combos.filter((c) => computeSupportedTeamCounts(c).unsupported > 0).length,
        fallbackActivated,
        fallbackSourceStage,
        fallbackReturnedCount: fallbackActivated ? combos.length : 0,
        finalComboEvidence: combos.map((c) => {
          const playerLegCount = c.legs.filter((l) => l.type === "player").length;
          const eliteLegCount = c.legs.filter((l) => l.type === "player" && l.playerQuality?.playerTier === "elite").length;
          const weakLegCount = c.legs.filter((l) => l.type === "player" && l.playerQuality?.playerTier === "weak").length;
          const { supported, unsupported } = computeSupportedTeamCounts(c);
          const roleBreakdown = computeLegRoleBreakdown(c);
          const quality = computeComboQualitySignals(c);
          const scoreBreakdown = computeComboScoreBreakdown(c);
          const playerCoherence = computePlayerLegCoherenceSignals(c);
          const families = Array.from(new Set(c.legs.map((l) => l.marketFamily)));
          return {
            odds: c.combinedOdds,
            totalScore: c.comboScore,
            normalizedScore: getNormalizedScore(c.comboScore),
            playerLegCount,
            supportedTeamLegCount: supported,
            unsupportedTeamLegCount: unsupported,
            teamLegUsed: (supported + unsupported) > 0,
            fillerLegCount: roleBreakdown.filler,
            legRoles: roleBreakdown,
            lowMarginalValueTeamLegCount: quality.lowMarginalValueTeamLegCount,
            additiveTeamLegCount: quality.additiveTeamLegCount,
            highConfidenceTeamLegCount: quality.highConfidenceTeamLegCount,
            teamLegQualityScore: quality.teamLegQualityScore,
            eliteLegCount,
            weakLegCount,
            playerCoherenceScore: playerCoherence.coherenceScore,
            sameTeamClusterCount: playerCoherence.sameTeamClusterCount,
            attackingClusterCount: playerCoherence.attackingClusterCount,
            defensiveClusterCount: playerCoherence.defensiveClusterCount,
            mixedTeamSpread: playerCoherence.mixedTeamSpread,
            isPlayerOnly: quality.isPlayerOnly,
            mixedComboBonusApplied: quality.mixedComboBonusApplied,
            tokenTeamLegPenalty: quality.tokenTeamLegPenalty,
            shapePreferenceScore: quality.shapePreferenceScore,
            oddsFittingPenalty: quality.oddsFittingPenalty,
            playerLedQualityBonus: quality.playerLedQualityBonus,
            families,
            coherenceDelta: computeComboCoherenceDelta(c),
            scoreBreakdown,
            topPlayerLegQuality: c.legs
              .filter((l) => l.type === "player" && l.playerQuality)
              .slice(0, 3)
              .map((l) => ({
                player: l.playerName,
                market: getMarketCategory(l.marketName),
                line: l.line,
                playerTier: l.playerQuality?.playerTier,
                qualityScore: l.playerQuality?.qualityScore,
                sampleReliability: l.playerQuality?.sampleReliability,
                minutesReliability: l.playerQuality?.minutesReliability,
                recencyScore: l.playerQuality?.recencyScore,
                roleConsistencyScore: l.playerQuality?.roleConsistencyScore,
                marketSpecificScore: l.playerQuality?.marketSpecificScore,
                weakSignalFlags: l.playerQuality?.weakSignalFlags,
                explanationSourceFlags: l.playerQuality?.explanationSourceFlags,
              })),
          };
        }),
      },
    });
    console.log("[build-value-bets] score normalization", {
      scoreMin,
      scoreMax,
      scoreRange,
      combos: combos.map((c) => ({
        totalScore: c.comboScore,
        normalizedScore: getNormalizedScore(c.comboScore),
        odds: c.combinedOdds,
      })),
    });
    const top3ScoreComparison = combos.slice(0, 3).map((c) => ({
      odds: c.combinedOdds,
      totalScore: c.comboScore,
      normalizedScore: getNormalizedScore(c.comboScore),
      breakdown: computeComboScoreBreakdown(c),
    }));
    console.log("[build-value-bets] top score comparison", top3ScoreComparison);
    if (BUILDER_DEBUG_VERBOSE && sanitySamples.length > 0) {
      console.log("[build-value-bets][verbose] sanity samples", sanitySamples);
    }
  }

  return {
    combos,
    candidateCount: playerRows.length,
    legCount: allLegs.length,
  };
}
