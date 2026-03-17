/**
 * Build Value Bets: filter candidates, score legs, generate 2/3-leg combos near target odds.
 * Version 1: no correlation; reuses value-bet pipeline outputs and fixture odds team props.
 * Includes market-family overlap protection and model-based Alternative Corners.
 */

import { isOddsSane } from "./valueBetModel.js";
import { probabilityOverLine, probabilityUnderLine } from "./playerPropProbability.js";

/** Min expected minutes for player legs (align with value bet hard filter). */
const MIN_EXPECTED_MINUTES = 35;
/** Min edge to include a player leg (positive only). */
const MIN_EDGE = 0.001;
/** Max odds per leg to avoid longshot junk. */
const MAX_ODDS_PER_LEG = 15;
/** Sensible line bounds per market (loose). */
const LINE_BOUNDS: Record<string, { min: number; max: number }> = {
  shots: { min: 0.5, max: 8 },
  shotsOnTarget: { min: 0.5, max: 5 },
  foulsCommitted: { min: 0.5, max: 5 },
  foulsWon: { min: 0.5, max: 4 },
};

/** One leg in a combo (player or team). */
export interface BuildLeg {
  id: string;
  type: "player" | "team";
  /** Used to reject combos with multiple legs from the same family (e.g. same player+market or multiple corner lines). */
  marketFamily: string;
  label: string;
  marketName: string;
  line: number;
  outcome: "Over" | "Under";
  odds: number;
  bookmakerName: string;
  score: number;
  reason?: string;
  playerName?: string;
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
    marketCategory: "shots" | "shotsOnTarget" | "foulsCommitted" | "foulsWon";
    per90: number;
    recentValues: number[];
  }>;
  /** Recent head-to-head total corners (e.g. last 4 meetings). */
  cornersH2hTotals?: number[];
  /** Team names for corners sentence: "X average ... and Y average ...". */
  homeTeamName?: string;
  awayTeamName?: string;
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
      (cat === "foulsWon" && playerStats?.foulsWon);
    const useRecent =
      Array.isArray(recentValues) && recentValues.length > 0 && recentValues.every((v) => typeof v === "number" && Number.isFinite(v));
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
export interface BuildCombo {
  legs: BuildLeg[];
  combinedOdds: number;
  distanceFromTarget: number;
  comboScore: number;
  /** Short factual "Why this build" lines derived from stats. */
  explanation?: ComboExplanation;
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

/** Team prop market IDs we use for build (v1: corners only to keep clean). */
const BUILD_TEAM_MARKET_IDS = new Set([69]); // MARKET_ID_ALTERNATIVE_CORNERS

/** Only one corner leg per combo; all Alternative Corners lines share this family. */
const CORNERS_MARKET_FAMILY = "team:alternative-corners";

/** Default fixture total corners when no team stats (league-typical). */
const DEFAULT_FIXTURE_EXPECTED_CORNERS = 10.5;

/** Max corner legs to pass into combo builder (best-rated only). */
const MAX_CORNER_LEGS = 5;

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

function getMarketCategory(marketName: string): keyof typeof LINE_BOUNDS | null {
  const n = (marketName || "").toLowerCase();
  if (n.includes("shots on target")) return "shotsOnTarget";
  if (n.includes("shots") && !n.includes("on target")) return "shots";
  if (n.includes("fouls committed")) return "foulsCommitted";
  if (n.includes("fouls won")) return "foulsWon";
  return null;
}

function isLineSensible(marketName: string, line: number): boolean {
  const cat = getMarketCategory(marketName);
  if (!cat || !LINE_BOUNDS[cat]) return true;
  const { min, max } = LINE_BOUNDS[cat];
  return line >= min && line <= max;
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

function normalizePlayerNameForMatch(name: string): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
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
    }

    const cappedBonus = Math.min(FOUL_MATCHUP_MAX_BONUS, bonus);
    const scoreBefore = leg.score;
    leg.score += cappedBonus;
    const existing = leg.reason ?? "";
    leg.reason = existing ? `${existing}; ${reasonSuffix}` : reasonSuffix;

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

/** Filter and convert player rows to build legs. */
export function filterPlayerCandidates(rows: PlayerCandidateInput[]): BuildLeg[] {
  const legs: BuildLeg[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    const cat = getMarketCategory(r.marketName);
    if (cat == null) continue; // only supported player-prop markets
    if (!isOddsSane(r.odds) || r.odds > MAX_ODDS_PER_LEG) continue;
    const edge = r.modelEdge ?? 0;
    if (edge < MIN_EDGE) continue;
    const expectedMinutes = r.modelInputs?.expectedMinutes ?? 0;
    if (expectedMinutes < MIN_EXPECTED_MINUTES) continue;
    if (!isLineSensible(r.marketName, r.line)) continue;

    const key = `${r.playerName}|${r.marketName}|${r.line}|${r.outcome}|${r.bookmakerName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const score = scorePlayerLeg(r);
    const id = `player-${legs.length}-${key.slice(0, 40)}`;
    const reason = buildLegReason(r);
    const marketFamily = `player:${String(r.playerName).trim().toLowerCase()}|${cat}`;
    legs.push({
      id,
      type: "player",
      marketFamily,
      label: `${r.playerName} ${r.marketName} ${r.line} ${r.outcome}`,
      marketName: r.marketName,
      line: r.line,
      outcome: r.outcome,
      odds: r.odds,
      bookmakerName: r.bookmakerName,
      score,
      reason,
      playerName: r.playerName,
    });
  }

  return legs;
}

/** Score a player leg for combo ranking (higher = better). */
function scorePlayerLeg(r: PlayerCandidateInput): number {
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
  if (!isLineSensible(r.marketName, r.line)) score -= 20;
  if (r.odds > 8) score -= 5;
  if (r.odds > 12) score -= 10;
  return Math.max(0, score);
}

function buildLegReason(r: PlayerCandidateInput): string {
  const edge = r.modelEdge;
  const pct = edge != null ? `${(edge * 100).toFixed(1)}% edge` : "";
  const strong = r.isStrongBet ? " strong" : "";
  return pct ? `${pct}${strong}`.trim() : "value";
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
  fixtureCornersContext: FixtureCornersContext | null
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
        let { score, reason, edge } = evaluated;

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
    marketFamily: CORNERS_MARKET_FAMILY,
    label: `${c.marketName} ${c.line} ${c.outcome}`,
    marketName: c.marketName,
    line: c.line,
    outcome: c.outcome,
    odds: c.odds,
    bookmakerName: c.bookmakerName,
    score: c.score,
    reason: c.reason,
  }));
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
  }
  if (per90 == null || statLabel === "") return null;
  return { per90, statLabel };
}

const MAX_RECENT_VALUES_DISPLAY = 5;

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

/** Build factual explanation lines for a combo from available stats. Uses evidence context when provided for evidence-style lines. */
function buildComboExplanation(
  combo: BuildCombo,
  playerRows: PlayerCandidateInput[],
  fixtureCornersContext: FixtureCornersContext | null,
  evidenceContext: BuildEvidenceContext | null
): ComboExplanation {
  const lines: string[] = [];

  for (const leg of combo.legs) {
    if (leg.type === "player") {
      const cat = getMarketCategory(leg.marketName);
      const evidence = evidenceContext ? getPlayerEvidence(leg.playerName!, cat ?? "", evidenceContext.playerRecentStats) : null;
      const data = getPer90AndLabelForLeg(leg, playerRows);
      const per90 = evidence?.per90 ?? data?.per90;
      const statLabel = data?.statLabel ?? (cat === "shots" ? "shots" : cat === "shotsOnTarget" ? "shots on target" : cat === "foulsCommitted" ? "fouls committed" : cat === "foulsWon" ? "fouls won" : "");

      if (per90 != null && statLabel) {
        if (evidence?.recentValues?.length) {
          const recent = evidence.recentValues.slice(-MAX_RECENT_VALUES_DISPLAY).join(", ");
          lines.push(`${leg.playerName} averages ${per90.toFixed(1)} ${statLabel} per 90, with recent starts of ${recent}.`);
        } else {
          lines.push(`${leg.playerName} averages ${per90.toFixed(1)} ${statLabel} per 90.`);
        }
      }
      if (leg.reason && leg.reason.trim()) {
        lines.push(leg.reason.trim());
      }
    } else if (leg.type === "team" && leg.marketName?.toLowerCase().includes("corner")) {
      if (fixtureCornersContext != null) {
        const home = fixtureCornersContext.homeCornersFor;
        const away = fixtureCornersContext.awayCornersFor;
        if (Number.isFinite(home) && Number.isFinite(away)) {
          const homeName = evidenceContext?.homeTeamName?.trim() || "Home";
          const awayName = evidenceContext?.awayTeamName?.trim() || "Away";
          lines.push(`${homeName} average ${home.toFixed(1)} corners per game and ${awayName} average ${away.toFixed(1)}.`);
        }
      }
      if (evidenceContext?.cornersH2hTotals?.length) {
        const h2h = evidenceContext.cornersH2hTotals.slice(-6).join(", ");
        lines.push(`Recent head-to-head total corners: ${h2h}.`);
      }
      const fixtureExpected = getFixtureExpectedCorners(fixtureCornersContext);
      if (Number.isFinite(fixtureExpected)) {
        lines.push(`Fixture projection: ${fixtureExpected.toFixed(1)} total corners.`);
      }
      if (leg.reason && leg.reason.trim()) {
        lines.push(leg.reason.trim());
      }
    }
  }

  const out = lines.filter((s) => s.length > 0);
  if (import.meta.env?.DEV && combo.legs.length > 0 && out.length > 0) {
    const playerEvidenceUsed = combo.legs
      .filter((l) => l.type === "player")
      .map((l) => ({
        player: l.playerName,
        market: getMarketCategory(l.marketName),
        hasRecent: Boolean(evidenceContext && getPlayerEvidence(l.playerName!, getMarketCategory(l.marketName) ?? "", evidenceContext.playerRecentStats)),
      }));
    console.log("[build-value-bets] explanation payload", {
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

/** Generate 2-leg and 3-leg combos, rank by distance to target then combo score. Rejects same-family overlap. */
export function generateCombos(
  legs: BuildLeg[],
  targetOdds: number,
  options: { maxCombos?: number; maxLegs?: number } = {}
): BuildCombo[] {
  const { maxCombos = 50, maxLegs = 3 } = options;
  const combos: BuildCombo[] = [];
  const used = new Set<string>();
  let rejectedOverlap = 0;

  for (let n = 2; n <= Math.min(maxLegs, 3); n++) {
    const indices: number[] = [];
    function recurse(start: number, depth: number) {
      if (depth === n) {
        const selected = indices.map((i) => legs[i]);
        if (hasSameFamilyOverlap(selected)) {
          rejectedOverlap += 1;
          return;
        }
        const combinedOdds = selected.reduce((acc, leg) => acc * leg.odds, 1);
        const distanceFromTarget = Math.abs(combinedOdds - targetOdds);
        const comboScore = selected.reduce((s, leg) => s + leg.score, 0);
        const key = indices.slice().sort((a, b) => a - b).join(",");
        if (!used.has(key)) {
          used.add(key);
          combos.push({ legs: selected, combinedOdds, distanceFromTarget, comboScore });
        }
        return;
      }
      for (let i = start; i < legs.length; i++) {
        indices.push(i);
        recurse(i + 1, depth + 1);
        indices.pop();
      }
    }
    recurse(0, 0);
  }

  if (import.meta.env?.DEV && rejectedOverlap > 0) {
    console.log("[build-value-bets] combos rejected for same-family overlap", rejectedOverlap);
  }

  combos.sort((a, b) => {
    if (a.distanceFromTarget !== b.distanceFromTarget) return a.distanceFromTarget - b.distanceFromTarget;
    return b.comboScore - a.comboScore;
  });

  return combos.slice(0, maxCombos);
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
  } = {}
): { combos: BuildCombo[]; candidateCount: number; legCount: number } {
  const { fixtureCornersContext = null, lineupContext = null, evidenceContext = null } = options;
  const playerLegs = filterPlayerCandidates(playerRows);
  applyFoulMatchupBoost(playerLegs, playerRows, lineupContext);
  applyShotMatchupBoost(playerLegs, playerRows, lineupContext);
  const teamLegs =
    fixtureOddsBookmakers != null
      ? getCornerLegsFromOdds(fixtureOddsBookmakers, fixtureCornersContext)
      : [];
  const allLegs = [...playerLegs, ...teamLegs];

  if (import.meta.env?.DEV) {
    console.log("[build-value-bets] candidates", {
      playerRows: playerRows.length,
      playerLegsAfterFilter: playerLegs.length,
      teamLegs: teamLegs.length,
      totalLegs: allLegs.length,
    });
    if (playerLegs.length > 0) {
      console.log("[build-value-bets] top player legs", playerLegs.slice(0, 5).map((l) => ({ label: l.label, odds: l.odds, score: l.score })));
    }
  }

  let combos = generateCombos(allLegs, targetOdds, { maxCombos: options.maxCombos ?? 30 });

  combos = combos.map((c) => ({
    ...c,
    explanation: buildComboExplanation(c, playerRows, fixtureCornersContext, evidenceContext),
  }));

  if (import.meta.env?.DEV && combos.length > 0) {
    console.log("[build-value-bets] combos", combos.length, "top", combos.slice(0, 3).map((c) => ({
      combinedOdds: c.combinedOdds.toFixed(2),
      distance: c.distanceFromTarget.toFixed(2),
      score: c.comboScore,
      legs: c.legs.map((l) => l.label),
      explanationLines: c.explanation?.lines.length ?? 0,
    })));
  }

  return {
    combos,
    candidateCount: playerRows.length,
    legCount: allLegs.length,
  };
}
