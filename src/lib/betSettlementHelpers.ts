/**
 * Canonical, deterministic settlement primitives for Bet History / combo resolution.
 * All count markets share the same half-line semantics (Over 0.5 wins at actual >= 1).
 */

const EPS = 1e-9;

export type PlayerPropStatCategory =
  | "shots"
  | "shotsOnTarget"
  | "foulsCommitted"
  | "foulsWon"
  | "tackles";

const MARKET_ID_PLAYER_SHOTS_ON_TARGET = 334;
const MARKET_ID_PLAYER_SHOTS = 336;
const MARKET_ID_PLAYER_FOULS_COMMITTED = 338;
const MARKET_ID_PLAYER_FOULS_WON = 339;
const MARKET_ID_PLAYER_TACKLES = 340;

/** Over/Under on a numeric total (goals, shots, etc.). */
export function settleCountOverUnder(actual: number, line: number, outcome: "Over" | "Under"): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(line)) return false;
  if (outcome === "Over") return actual > line - EPS;
  return actual < line + EPS;
}

/** Yes/No vs a numeric threshold (treats Yes like Over, No like Under at the same line). */
export function settleYesNoAgainstLine(actual: number, line: number, outcome: "Yes" | "No"): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(line)) return false;
  if (outcome === "Yes") return actual > line - EPS;
  return actual < line + EPS;
}

export function settleBtts(homeGoals: number, awayGoals: number, outcome: "Yes" | "No"): boolean {
  if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) return false;
  const both = homeGoals >= 1 && awayGoals >= 1;
  if (outcome === "Yes") return both;
  return !both;
}

export function settleMatchResult(
  homeGoals: number,
  awayGoals: number,
  outcome: "Home" | "Draw" | "Away"
): boolean {
  if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) return false;
  if (outcome === "Home") return homeGoals > awayGoals;
  if (outcome === "Away") return awayGoals > homeGoals;
  return homeGoals === awayGoals;
}

/**
 * Infer stat column from stored combo leg: prefer `marketFamily` from Build Value Bets
 * (`player:<normName>|<category>`), then fall back to marketName heuristics (aligned with valueBetBuilder).
 */
export function inferPlayerPropStatCategoryFromLeg(marketFamily: string, marketName: string): PlayerPropStatCategory | null {
  return inferPlayerPropStatCategoryFromLegWithMarketId(marketFamily, marketName, undefined);
}

/**
 * Prefer explicit market id mapping; then fallback to marketFamily/marketName heuristics.
 */
export function inferPlayerPropStatCategoryFromLegWithMarketId(
  marketFamily: string,
  marketName: string,
  marketId?: number | null
): PlayerPropStatCategory | null {
  if (typeof marketId === "number" && Number.isFinite(marketId)) {
    if (marketId === MARKET_ID_PLAYER_SHOTS_ON_TARGET) return "shotsOnTarget";
    if (marketId === MARKET_ID_PLAYER_SHOTS) return "shots";
    if (marketId === MARKET_ID_PLAYER_FOULS_COMMITTED) return "foulsCommitted";
    if (marketId === MARKET_ID_PLAYER_FOULS_WON) return "foulsWon";
    if (marketId === MARKET_ID_PLAYER_TACKLES) return "tackles";
  }

  const fam = (marketFamily ?? "").trim().toLowerCase();
  const pipe = fam.lastIndexOf("|");
  if (fam.startsWith("player:") && pipe > 0) {
    const cat = fam.slice(pipe + 1).trim().toLowerCase();
    if (cat === "shots") return "shots";
    if (cat === "shotsontarget") return "shotsOnTarget";
    if (cat === "foulscommitted") return "foulsCommitted";
    if (cat === "foulswon") return "foulsWon";
    if (cat === "tackles") return "tackles";
  }

  const n = (marketName || "").toLowerCase();
  if (n.includes("shots on target")) return "shotsOnTarget";
  if (n.includes("fouls committed")) return "foulsCommitted";
  if (n.includes("fouls won")) return "foulsWon";
  if (n.includes("player tackles") || (n.includes("tackles") && !n.includes("foul"))) return "tackles";
  if (n.includes("shots") && !n.includes("on target")) return "shots";
  return null;
}

export function formatCountComparison(actual: number, line: number, outcome: string): string {
  return `compare actual=${actual} vs line=${line} (${outcome}) [Over/Yes: >${line - EPS}; Under/No: <${line + EPS}]`;
}
