/**
 * Human-readable bet / prop labels for UI only.
 * Does not affect settlement, storage semantics, or dedupe signatures.
 */

import {
  MARKET_ID_ALTERNATIVE_CORNERS,
  MARKET_ID_ALTERNATIVE_TOTAL_GOALS,
  MARKET_ID_BTTS,
  MARKET_ID_HOME_TEAM_GOALS,
  MARKET_ID_MATCH_GOALS,
  MARKET_ID_MATCH_RESULTS,
  MARKET_ID_AWAY_TEAM_GOALS,
  MARKET_ID_TEAM_TOTAL_GOALS,
} from "../constants/marketIds.js";
import { inferPlayerPropStatCategoryFromLeg } from "./betSettlementHelpers.js";

const SEP = " — ";

const STAT_TITLE: Record<string, string> = {
  shots: "Shots",
  shotsOnTarget: "Shots On Target",
  foulsCommitted: "Fouls Committed",
  foulsWon: "Fouls Won",
  tackles: "Tackles",
};

export type BetLegDisplayInput = {
  type: "player" | "team";
  marketFamily?: string;
  marketName?: string;
  marketId?: number;
  playerName?: string;
  line?: number;
  outcome: "Over" | "Under" | "Home" | "Draw" | "Away" | "Yes" | "No" | string;
  /** Raw machine label; safe fallback when structured formatting is ambiguous */
  label?: string;
};

function rawFallback(leg: BetLegDisplayInput): string {
  const r = (leg.label ?? "").trim();
  if (r) return r;
  const mn = (leg.marketName ?? "").trim();
  const oc = String(leg.outcome ?? "").trim();
  if (mn && oc) return `${mn} ${oc}`.trim();
  return mn || oc || "—";
}

function formatLineNum(line: number): string {
  if (!Number.isFinite(line)) return "";
  const rounded = Math.round(line * 1000) / 1000;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded);
}

function directionWord(
  o: string
): "Over" | "Under" | "Yes" | "No" | "Home" | "Away" | "Draw" | null {
  if (o === "Over" || o === "Under" || o === "Yes" || o === "No" || o === "Home" || o === "Away" || o === "Draw") return o;
  return null;
}

/** Parse numeric line from strings like "Over 2.5", "2.5 Over", "Under 10.5". */
function parseLineFromText(text: string): number | null {
  const m = String(text).match(/(\d+\.?\d*)/);
  if (!m) return null;
  const n = parseFloat(m[1]!.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function selectionIsOver(text: string): boolean | null {
  const t = String(text).trim().toLowerCase();
  if (!t) return null;
  const isOver = /\bover\b|^o(?![a-z])/.test(t) || /^(\d+\.?\d*)\s*over\b/.test(t);
  const isUnder = /\bunder\b|^u(?![a-z])/.test(t) || /^(\d+\.?\d*)\s*under\b/.test(t);
  if (isOver && !isUnder) return true;
  if (isUnder && !isOver) return false;
  return null;
}

function parseMatchResultLabel(text: string): "Home" | "Draw" | "Away" | null {
  const lower = String(text).trim().toLowerCase();
  if (lower === "home" || lower === "1") return "Home";
  if (lower === "draw" || lower === "x") return "Draw";
  if (lower === "away" || lower === "2") return "Away";
  return null;
}

function parseYesNoLabel(text: string): "Yes" | "No" | null {
  const lower = String(text).trim().toLowerCase();
  if (lower === "yes" || lower === "y") return "Yes";
  if (lower === "no" || lower === "n") return "No";
  return null;
}

function cleanPlayerMarketTitle(marketName: string): string {
  let s = marketName.trim();
  s = s.replace(/^player\s+/i, "").trim();
  return s.replace(/\s+/g, " ");
}

function formatPlayerLeg(leg: BetLegDisplayInput): string | null {
  const player = (leg.playerName ?? "").trim();
  if (!player) return null;
  const dw = directionWord(leg.outcome);
  if (dw == null) return null;
  const lineOk = typeof leg.line === "number" && Number.isFinite(leg.line);
  const needsLine = dw === "Over" || dw === "Under" || dw === "Yes" || dw === "No";
  if (needsLine && !lineOk) return null;

  const cat = inferPlayerPropStatCategoryFromLeg(leg.marketFamily ?? "", leg.marketName ?? "");
  const statTitle = cat ? STAT_TITLE[cat] : null;
  const stat = statTitle ?? cleanPlayerMarketTitle(leg.marketName ?? "");
  if (!stat) return null;

  const lineStr = lineOk ? formatLineNum(leg.line!) : "";

  if (dw === "Over" || dw === "Under") {
    return `${player}${SEP}${stat} ${dw} ${lineStr}`.trim();
  }
  if (dw === "Yes" || dw === "No") {
    return `${player}${SEP}${stat} ${dw} ${lineStr}`.trim();
  }
  return null;
}

function formatTeamLegStructured(leg: BetLegDisplayInput): string | null {
  const fam = (leg.marketFamily ?? "").toLowerCase();
  const mid = leg.marketId;
  const mn = (leg.marketName ?? "").toLowerCase();
  const dw = directionWord(leg.outcome);
  if (dw == null) return null;

  const isBtts = fam === "team:btts" || mid === MARKET_ID_BTTS || mn.includes("btts") || mn.includes("both teams to score");
  if (isBtts && (dw === "Yes" || dw === "No")) {
    return `Both Teams To Score${SEP}${dw}`;
  }

  const isMr =
    fam === "team:match-results" || mid === MARKET_ID_MATCH_RESULTS || mn.includes("match result") || mn.includes("1x2");
  if (isMr && (dw === "Home" || dw === "Draw" || dw === "Away")) {
    return `Match Result${SEP}${dw}`;
  }

  const isMatchGoals =
    fam === "team:match-goals" ||
    fam === "team:alternative-total-goals" ||
    mid === MARKET_ID_MATCH_GOALS ||
    mid === MARKET_ID_ALTERNATIVE_TOTAL_GOALS ||
    mn.includes("over/under goals") ||
    mn.includes("alternative goals") ||
    mn.includes("over under goals");
  if (isMatchGoals && (dw === "Over" || dw === "Under")) {
    const lineOk = typeof leg.line === "number" && Number.isFinite(leg.line);
    if (!lineOk) return null;
    return `Total Goals ${dw} ${formatLineNum(leg.line!)}`;
  }

  const isCorners =
    fam === "team:alternative-corners" ||
    mid === MARKET_ID_ALTERNATIVE_CORNERS ||
    /\balternative corners\b/i.test(leg.marketName ?? "");
  if (isCorners && (dw === "Over" || dw === "Under")) {
    const lineOk = typeof leg.line === "number" && Number.isFinite(leg.line);
    if (!lineOk) return null;
    return `Total Corners ${dw} ${formatLineNum(leg.line!)}`;
  }

  const isTeamTotal =
    mid === MARKET_ID_TEAM_TOTAL_GOALS ||
    mid === MARKET_ID_HOME_TEAM_GOALS ||
    mid === MARKET_ID_AWAY_TEAM_GOALS ||
    mn.includes("team total");
  if (isTeamTotal && (dw === "Over" || dw === "Under")) {
    const lineOk = typeof leg.line === "number" && Number.isFinite(leg.line);
    if (!lineOk) return null;
    const raw = (leg.label ?? "").trim();
    const lower = raw.toLowerCase();
    if (mid === MARKET_ID_HOME_TEAM_GOALS || (/\bhome\b/.test(lower) && !/\baway\b/.test(lower))) {
      return `Home Team Goals ${dw} ${formatLineNum(leg.line!)}`;
    }
    if (mid === MARKET_ID_AWAY_TEAM_GOALS || (/\baway\b/.test(lower) && !/\bhome\b/.test(lower))) {
      return `Away Team Goals ${dw} ${formatLineNum(leg.line!)}`;
    }
    return `Team Total Goals ${dw} ${formatLineNum(leg.line!)}`;
  }

  return null;
}

/**
 * Conservative prettify of raw stored labels when structured fields are incomplete.
 */
function formatFromRawLabel(leg: BetLegDisplayInput): string | null {
  const raw = (leg.label ?? "").trim();
  if (!raw) return null;

  if (/^btts\s+/i.test(raw)) {
    const yn = parseYesNoLabel(raw.replace(/^btts\s+/i, ""));
    if (yn) return `Both Teams To Score${SEP}${yn}`;
  }

  const ouGoals = /over\/under\s+goals|alternative\s+goals/i.test(raw);
  if (ouGoals && leg.type === "team") {
    const line = typeof leg.line === "number" && Number.isFinite(leg.line) ? leg.line : parseLineFromText(raw);
    const over =
      leg.outcome === "Over" || leg.outcome === "Under"
        ? leg.outcome === "Over"
        : selectionIsOver(raw);
    if (line != null && over != null) {
      return `Total Goals ${over ? "Over" : "Under"} ${formatLineNum(line)}`;
    }
  }

  return null;
}

/**
 * Primary API: format a stored or builder leg for display.
 */
export function formatBetLegDisplayLabel(leg: BetLegDisplayInput): string {
  const structured = leg.type === "player" ? formatPlayerLeg(leg) : formatTeamLegStructured(leg);

  if (structured) return structured;

  const fromRaw = formatFromRawLabel(leg);
  if (fromRaw) return fromRaw;

  return rawFallback(leg);
}

/**
 * Odds workspace / Build Bet (match markets): format bookmaker selection without a full BuildLeg.
 */
export function formatMatchMarketSelectionDisplay(marketId: number, marketName: string, selectionLabel: string): string {
  const label = String(selectionLabel ?? "").trim() || "—";
  const mn = marketName.trim();

  if (marketId === MARKET_ID_MATCH_RESULTS) {
    const r = parseMatchResultLabel(label);
    if (r) return `Match Result${SEP}${r}`;
    return `${mn}${SEP}${label}`;
  }

  if (marketId === MARKET_ID_BTTS) {
    const yn = parseYesNoLabel(label);
    if (yn) return `Both Teams To Score${SEP}${yn}`;
    return `${mn}${SEP}${label}`;
  }

  if (marketId === MARKET_ID_MATCH_GOALS || marketId === MARKET_ID_ALTERNATIVE_TOTAL_GOALS) {
    const line = parseLineFromText(label);
    const over = selectionIsOver(label);
    if (line != null && over != null) {
      return `Total Goals ${over ? "Over" : "Under"} ${formatLineNum(line)}`;
    }
    return `${mn} ${label}`.trim();
  }

  if (marketId === MARKET_ID_ALTERNATIVE_CORNERS) {
    const line = parseLineFromText(label);
    const over = selectionIsOver(label);
    if (line != null && over != null) {
      return `Total Corners ${over ? "Over" : "Under"} ${formatLineNum(line)}`;
    }
    return `${mn} ${label}`.trim();
  }

  if (marketId === MARKET_ID_TEAM_TOTAL_GOALS || marketId === MARKET_ID_HOME_TEAM_GOALS || marketId === MARKET_ID_AWAY_TEAM_GOALS) {
    const line = parseLineFromText(label);
    const over = selectionIsOver(label);
    if (line != null && over != null) {
      if (marketId === MARKET_ID_HOME_TEAM_GOALS) {
        return `Home Team Goals ${over ? "Over" : "Under"} ${formatLineNum(line)}`;
      }
      if (marketId === MARKET_ID_AWAY_TEAM_GOALS) {
        return `Away Team Goals ${over ? "Over" : "Under"} ${formatLineNum(line)}`;
      }
      return `Team Total Goals ${over ? "Over" : "Under"} ${formatLineNum(line)}`;
    }
    return `${mn}${SEP}${label}`;
  }

  return `${mn} ${label}`.trim();
}

/**
 * Player prop row from player odds API (typically Over-only rows with explicit line).
 */
export function formatPlayerOddsSelectionDisplay(playerName: string, marketName: string, line: number | undefined): string {
  const player = String(playerName ?? "").trim();
  const mn = String(marketName ?? "").trim();
  if (!player || !mn) return `${player} ${mn}`.trim() || "—";
  const lineOk = typeof line === "number" && Number.isFinite(line);
  const cat = inferPlayerPropStatCategoryFromLeg("", mn);
  const stat = cat ? STAT_TITLE[cat] : cleanPlayerMarketTitle(mn);
  if (lineOk) {
    return `${player}${SEP}${stat} Over ${formatLineNum(line!)}`;
  }
  return `${player}${SEP}${stat} Over`.trim();
}
