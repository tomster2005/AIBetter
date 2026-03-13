/**
 * Odds by fixture ID via Sportmonks pre-match odds API.
 * Isolated odds layer — not used by lineup or player profile.
 *
 * Pipeline: raw rows → market classification → bookmaker filter → group by bookmaker →
 * selection normalisation + dedupe → assemble output. New markets: add config to
 * SUPPORTED_MARKET_CONFIGS (classifier, normaliser, outcomeOrder), add bucketKey to BookmakerEntry.
 * Debug: set DEBUG_FIXTURE_ID or ODDS_DEBUG=1 (dev).
 */

import {
  ACTIVE_ODDS_MARKET_IDS,
  MARKET_ID_ALTERNATIVE_CORNERS,
  MARKET_ID_ALTERNATIVE_TOTAL_GOALS,
  MARKET_ID_BTTS,
  MARKET_ID_MATCH_GOALS,
  MARKET_ID_MATCH_RESULTS,
  MARKET_ID_TEAM_TOTAL_GOALS,
} from "../constants/marketIds";

const SPORTMONKS_ODDS_BASE = "https://api.sportmonks.com/v3/football/odds/pre-match/fixtures";

/** Bookmaker IDs to request from Sportmonks (comma-separated for filter). */
const ODDS_BOOKMAKER_IDS = "2,41,19,29,13,32,9";

/** Fetches pre-match odds for one fixture and one market with bookmaker filter. Returns rows or [] on failure. */
async function fetchMarketOddsForFixture(
  fixtureId: number,
  marketId: number,
  token: string
): Promise<SportmonksOdd[]> {
  const url = `${SPORTMONKS_ODDS_BASE}/${fixtureId}?api_token=${encodeURIComponent(token)}&include=market;bookmaker&filters=markets:${marketId};bookmakers:${ODDS_BOOKMAKER_IDS}`;
  try {
    const res = await fetch(url);
    const json = (await res.json()) as { data?: SportmonksOdd[] };
    return Array.isArray(json?.data) ? json.data : [];
  } catch {
    return [];
  }
}

/** Set to a fixture id to emit trace/strict/validation logs for that fixture only (dev). Set to 0 to disable. */
const DEBUG_FIXTURE_ID = 19432180;

/** When true (e.g. ODDS_DEBUG=1), emit per-row and generic verbose logs in dev. Otherwise only summary + DEBUG_FIXTURE_ID logs. */
const ODDS_DEBUG_VERBOSE =
  process.env.NODE_ENV !== "production" &&
  (process.env.ODDS_DEBUG === "1" || process.env.ODDS_DEBUG === "true");

/** Bucket keys for per-market selections in BookmakerEntry. Extend when adding markets (e.g. 'playerProps'). */
export type SupportedMarketBucketKey = "matchResults" | "btts" | "overUnder" | "alternativeGoals" | "totalCorners" | "teamTotalGoals";

/** Signature for selection label normalisers. New markets should implement (label, value) => canonicalLabel | null. */
export type MarketLabelNormaliser = (label: string, value: string | number | null | undefined) => string | null;

/** Supported market names for display. Populated from SUPPORTED_MARKET_CONFIGS below. */
const MARKET_NAME_MATCH_RESULTS = "Match Results";
const MARKET_NAME_BTTS = "BTTS";
const MARKET_NAME_OVER_UNDER = "Over/Under Goals";

export interface NormalisedOddsSelection {
  label: string;
  value: string | number | null;
  odds: number | null;
}

export interface NormalisedOddsMarket {
  marketId: number;
  marketName: string;
  selections: NormalisedOddsSelection[];
}

export interface NormalisedOddsBookmaker {
  bookmakerId: number;
  bookmakerName: string;
  markets: NormalisedOddsMarket[];
}

export interface NormalisedOddsResponse {
  fixtureId: number;
  bookmakers: NormalisedOddsBookmaker[];
}

/** Single source of truth: allowed bookmakers in display order. Extend when adding new bookmakers. */
const PREFERRED_BOOKMAKER_ORDER: Array<{ id: number; name: string }> = [
  { id: 2, name: "bet365" },
  { id: 41, name: "SkyBet" },
  { id: 19, name: "PaddyPower" },
  { id: 29, name: "WilliamHill" },
  { id: 13, name: "Coral" },
  { id: 32, name: "Ladbrokes" },
  { id: 9, name: "Betfair" },
];

/** Map bookmaker id to display name (for normalised output). Derived from PREFERRED_BOOKMAKER_ORDER. */
export const ALLOWED_BOOKMAKERS: Record<number, string> = Object.fromEntries(
  PREFERRED_BOOKMAKER_ORDER.map((b) => [b.id, b.name])
);

const ALLOWED_BOOKMAKER_IDS = new Set(PREFERRED_BOOKMAKER_ORDER.map((b) => b.id));

/** Raw odd item from Sportmonks pre-match odds response (data array element). Relations vary. */
interface SportmonksOdd {
  id?: number;
  fixture_id?: number;
  bookmaker_id?: number;
  market_id?: number;
  label?: string;
  value?: string | number;
  name?: string;
  odds?: number | string;
  total?: number | string;
  handicap?: number | string;
  market_description?: string;
  market_name?: string;
  bookmaker_name?: string;
  bookmaker?: { id?: number; name?: string; data?: { id?: number; name?: string } };
  market?: {
    id?: number;
    name?: string;
    description?: string;
    developer_name?: string;
    data?: { id?: number; name?: string; description?: string; developer_name?: string };
  };
  /** If true, row is suspended/stopped and should be ignored. */
  suspended?: boolean;
  stopped?: boolean;
}

/** Resolve bookmaker id and name from any likely Sportmonks location. */
function resolveBookmakerInfo(row: SportmonksOdd): { bookmakerId: number | null; bookmakerName: string } {
  const id =
    row.bookmaker_id ??
    (row.bookmaker as { data?: { id?: number } } | undefined)?.data?.id ??
    row.bookmaker?.id ??
    null;
  const rawName =
    row.bookmaker_name ??
    (row.bookmaker as { data?: { name?: string } } | undefined)?.data?.name ??
    row.bookmaker?.name ??
    "";
  const bookmakerName =
    typeof rawName === "string" && rawName.trim()
      ? rawName.trim()
      : id != null && ALLOWED_BOOKMAKERS[id]
        ? ALLOWED_BOOKMAKERS[id]
        : id != null
          ? `Bookmaker ${id}`
          : "Unknown";
  return {
    bookmakerId: id != null && typeof id === "number" ? id : null,
    bookmakerName,
  };
}

/** Normalise for matching: strip spaces, lowercase. "Paddy Power" -> "paddypower" */
function normaliseBookmakerName(name: string): string {
  return (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

/** Allowed names (normalised) for matching when ID is missing or not in allowed list. Derived from PREFERRED_BOOKMAKER_ORDER. */
const ALLOWED_BOOKMAKER_NAMES = new Set(PREFERRED_BOOKMAKER_ORDER.map((b) => normaliseBookmakerName(b.name)));

function isAllowedBookmaker(resolvedId: number | null, resolvedName: string): boolean {
  const nameNorm = normaliseBookmakerName(resolvedName);
  if (resolvedId != null && ALLOWED_BOOKMAKER_IDS.has(resolvedId)) return true;
  return ALLOWED_BOOKMAKER_NAMES.has(nameNorm);
}

/** Resolve canonical bookmaker id for output (from id or name lookup). */
function canonicalBookmakerId(resolvedId: number | null, resolvedName: string): number {
  if (resolvedId != null && ALLOWED_BOOKMAKER_IDS.has(resolvedId)) return resolvedId;
  const nameNorm = normaliseBookmakerName(resolvedName);
  const byName = Object.fromEntries(PREFERRED_BOOKMAKER_ORDER.map((b) => [normaliseBookmakerName(b.name), b.id]));
  return byName[nameNorm] ?? resolvedId ?? 0;
}

/** Stable key for grouping: prefer id when allowed, else normalised name. */
function bookmakerGroupKey(resolvedId: number | null, resolvedName: string): string {
  if (resolvedId != null && ALLOWED_BOOKMAKER_IDS.has(resolvedId)) return `id:${resolvedId}`;
  return `name:${normaliseBookmakerName(resolvedName)}`;
}

function getSportmonksToken(): string | null {
  const t = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
  return t && typeof t === "string" && t.trim() ? t.trim() : null;
}

/** All likely sources for market name (debug logging). */
function debugMarketName(row: SportmonksOdd): string {
  const m = row.market as { data?: { name?: string } } | undefined;
  return (
    m?.data?.name ??
    row.market?.name ??
    row.market_name ??
    ""
  );
}

/** All likely sources for market description (debug logging). */
function debugMarketDesc(row: SportmonksOdd): string {
  const m = row.market as { data?: { description?: string } } | undefined;
  return (
    m?.data?.description ??
    row.market?.description ??
    row.market_description ??
    ""
  );
}

/** Compact debug row shape; rawOddsValue = raw source used for decimal odds. */
function debugRowShape(row: SportmonksOdd): {
  id: number | string;
  fixtureId: number | string;
  bookmakerId: number | string;
  bookmakerName: string;
  marketId: number | string;
  marketName: string;
  marketDescription: string;
  label: string;
  value: string | number | null;
  odds: number | null;
  rawOddsValue: unknown;
} {
  const { bookmakerId, bookmakerName } = resolveBookmakerInfo(row);
  const marketId = row.market_id ?? (row.market as { id?: number })?.id ?? "";
  return {
    id: row.id ?? "—",
    fixtureId: row.fixture_id ?? "—",
    bookmakerId: bookmakerId ?? "—",
    bookmakerName,
    marketId: marketId ?? "—",
    marketName: debugMarketName(row) || "—",
    marketDescription: debugMarketDesc(row) || "—",
    label: (row.label ?? row.name ?? "—") as string,
    value: row.value ?? null,
    odds: parseOddsValue(row.value),
    rawOddsValue: row.odds ?? row.value ?? "—",
  };
}

function parseOddsValue(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number" && !Number.isNaN(v) && v > 0) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return !Number.isNaN(n) && n > 0 ? n : null;
  }
  return null;
}

/** Lowercase, remove spaces, remove punctuation/slashes/hyphens. */
function normaliseMarketText(value: string): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[-/\\.,'"]/g, "");
}

function getMarketMeta(row: SportmonksOdd): {
  marketId: number | null;
  marketName: string;
  marketDeveloperName: string;
  marketDescription: string;
} {
  const m = row.market;
  const marketId =
    row.market_id ??
    m?.id ??
    m?.data?.id ??
    null;
  const marketName =
    m?.data?.name ??
    m?.name ??
    row.market_name ??
    "";
  const marketDeveloperName =
    m?.data?.developer_name ??
    m?.developer_name ??
    "";
  const marketDescription =
    m?.data?.description ??
    m?.description ??
    row.market_description ??
    "";
  return {
    marketId: marketId != null && typeof marketId === "number" ? marketId : null,
    marketName: String(marketName),
    marketDeveloperName: String(marketDeveloperName),
    marketDescription: String(marketDescription),
  };
}

/** STRICT: only MARKET_ID_MATCH_RESULTS (1), or FULLTIME_RESULT, or name exactly "fulltimeresult" / "full time result". */
function isMatchResultsMarket(row: SportmonksOdd): boolean {
  const meta = getMarketMeta(row);
  if (meta.marketId === MARKET_ID_MATCH_RESULTS) return true;
  const dev = meta.marketDeveloperName.trim().toUpperCase();
  if (dev === "FULLTIME_RESULT") return true;
  const nameNorm = normaliseMarketText(meta.marketName);
  return nameNorm === "fulltimeresult";
}

/** STRICT: only MARKET_ID_BTTS, or developer_name indicates BTTS, or name/description exactly "bothteamstoscore" / "btts". */
function isBTTSMarket(row: SportmonksOdd): boolean {
  const meta = getMarketMeta(row);
  if (meta.marketId === MARKET_ID_BTTS) return true;
  const dev = normaliseMarketText(meta.marketDeveloperName);
  if (dev === "bothteamstoscore" || dev === "btts" || dev === "both_teams_to_score") return true;
  const nameNorm = normaliseMarketText(meta.marketName);
  if (nameNorm === "bothteamstoscore" || nameNorm === "btts") return true;
  const descNorm = normaliseMarketText(meta.marketDescription);
  return descNorm === "bothteamstoscore" || descNorm === "btts";
}

/** Compact row shape for [odds][trace] logs. */
function traceRowShape(row: SportmonksOdd, meta: { marketId: number | null; marketName: string }): {
  id: number | string;
  bookmakerId: number | string;
  bookmakerName: string;
  marketId: number | string;
  marketName: string;
  label: string;
  value: string | number | null;
  odds: number | null;
} {
  const { bookmakerId, bookmakerName } = resolveBookmakerInfo(row);
  return {
    id: row.id ?? "—",
    bookmakerId: bookmakerId ?? "—",
    bookmakerName,
    marketId: meta.marketId ?? "—",
    marketName: meta.marketName || "—",
    label: (row.label ?? row.name ?? "—") as string,
    value: row.value ?? null,
    odds: parseOddsValue(row.value),
  };
}

/** Shape for [odds][strict] accepted rows log. */
function strictAcceptedRowShape(row: SportmonksOdd): {
  id: number | string;
  bookmakerId: number | string;
  bookmakerName: string;
  marketId: number | string;
  marketName: string;
  marketDeveloperName: string;
  marketDescription: string;
  label: string;
  value: string | number | null;
  odds: number | null;
} {
  const { bookmakerId, bookmakerName } = resolveBookmakerInfo(row);
  const meta = getMarketMeta(row);
  return {
    id: row.id ?? "—",
    bookmakerId: bookmakerId ?? "—",
    bookmakerName,
    marketId: meta.marketId ?? "—",
    marketName: meta.marketName || "—",
    marketDeveloperName: meta.marketDeveloperName || "—",
    marketDescription: meta.marketDescription || "—",
    label: (row.label ?? row.name ?? "—") as string,
    value: row.value ?? null,
    odds: parseOddsValue(row.value),
  };
}

/** Map MR selection to canonical label only. Home/1, Draw/X, Away/2; ignore anything else. */
function normaliseMRLabel(label: string, value: string | number | null | undefined): "Home" | "Draw" | "Away" | null {
  const s = (typeof label === "string" ? label : String(value ?? "")).trim().toLowerCase();
  if (s === "home" || s === "1") return "Home";
  if (s === "draw" || s === "x") return "Draw";
  if (s === "away" || s === "2") return "Away";
  return null;
}

/** Map BTTS selection to Yes/No only. Yes/Y, No/N; ignore anything else. */
function normaliseBTTSLabel(label: string, value: string | number | null): string | null {
  const text = String(label || "").toLowerCase();

  if (text.includes("yes") || text === "y") {
    return "Yes";
  }

  if (text.includes("no") || text === "n") {
    return "No";
  }

  return null;
}

/** Main Over/Under goals: market 80 only (Match Goals). */
function isOverUnderMarket(row: SportmonksOdd): boolean {
  return getMarketMeta(row).marketId === MARKET_ID_MATCH_GOALS;
}

/** Alternative Total Goals: market 81 (multi-line Over/Under). */
function isAlternativeTotalGoalsMarket(row: SportmonksOdd): boolean {
  return getMarketMeta(row).marketId === MARKET_ID_ALTERNATIVE_TOTAL_GOALS;
}

/** Alternative Corners (market 69): Over/Under X.X, same structure as goals O/U. */
function isCornersOverUnderMarket(row: SportmonksOdd): boolean {
  return getMarketMeta(row).marketId === MARKET_ID_ALTERNATIVE_CORNERS;
}

/** Team Total Goals (market 86): classify by market id only. */
function isTeamTotalGoalsMarket(row: SportmonksOdd): boolean {
  return getMarketMeta(row).marketId === MARKET_ID_TEAM_TOTAL_GOALS;
}

/**
 * Extract the goal line for Over/Under from a raw row. Prefer: total, handicap, number in label/name.
 * Use value only as last resort and only when it looks like a line (e.g. 2.5, 1.5) not odds (e.g. 1.9).
 */
function getOverUnderLineFromRow(row: SportmonksOdd): number | null {
  const total = row.total;
  if (total != null) {
    const n = typeof total === "number" ? total : parseFloat(String(total).replace(/,/g, "."));
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const handicap = row.handicap;
  if (handicap != null) {
    const n = typeof handicap === "number" ? handicap : parseFloat(String(handicap).replace(/,/g, "."));
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const fromLabel = (typeof row.label === "string" ? row.label : "").match(/(\d+\.?\d*)/);
  if (fromLabel) {
    const n = parseFloat(fromLabel[1]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const fromName = (typeof row.name === "string" ? row.name : "").match(/(\d+\.?\d*)/);
  if (fromName) {
    const n = parseFloat(fromName[1]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const value = row.value;
  if (value != null) {
    const n = typeof value === "number" ? value : parseFloat(String(value).replace(/,/g, "."));
    if (!Number.isFinite(n) || n < 0 || n > 20) return null;
    if (n === Math.floor(n) || Math.abs((n % 1) - 0.5) < 0.01) return n;
  }
  return null;
}

/** Parse to "Over X.X" or "Under X.X". Second param is the GOAL LINE (not odds). Uses label to determine Over vs Under. */
function normaliseOverUnderLabel(label: string, line: string | number | null | undefined): string | null {
  const rawLabel = (typeof label === "string" ? label : "").trim();
  const lineNum =
    line != null && line !== ""
      ? (typeof line === "number" ? line : parseFloat(String(line).replace(/,/g, ".")))
      : null;
  const numFromLabel = rawLabel.match(/(\d+\.?\d*)/);
  const lineValue =
    lineNum != null && Number.isFinite(lineNum) && lineNum >= 0
      ? lineNum
      : numFromLabel
        ? parseFloat(numFromLabel[1])
        : null;
  if (lineValue == null || !Number.isFinite(lineValue)) return null;
  const lineStr = lineValue % 1 === 0 ? `${lineValue}.5` : lineValue.toFixed(1);
  const lower = rawLabel.toLowerCase();
  const isOver = /^o(ver)?\s|over\s|^\d+\s*over|^over$/i.test(rawLabel) || lower === "over" || (lower.startsWith("o") && !lower.startsWith("un"));
  const isUnder = /^u(nder)?\s|under\s|^\d+\s*under|^under$/i.test(rawLabel) || lower === "under" || lower.startsWith("u");
  if (isOver && !isUnder) return `Over ${lineStr}`;
  if (isUnder && !isOver) return `Under ${lineStr}`;
  return null;
}

/** Sort Over/Under labels by line (asc) then Over before Under. */
function sortOverUnderOutcomeOrder(labels: string[]): string[] {
  const unique = [...new Set(labels)];
  return unique.sort((a, b) => {
    const aNum = parseFloat(a.replace(/[^\d.]/g, "")) || 0;
    const bNum = parseFloat(b.replace(/[^\d.]/g, "")) || 0;
    if (aNum !== bNum) return aNum - bNum;
    return a.toLowerCase().startsWith("over") ? -1 : 1;
  });
}

/** Parse line value from "Over 2.5" / "Under 2.5". Returns null if not parseable. */
function parseOverUnderLine(label: string): number | null {
  const num = parseFloat(label.replace(/[^\d.]/g, ""));
  return Number.isFinite(num) && num > 0 ? num : null;
}

/** Standard goal lines for Match Goals multi-line market. */
const STANDARD_GOAL_LINES: readonly number[] = [0.5, 1.5, 2.5, 3.5, 4.5];

/** Standard corner lines for Alternative Corners multi-line market (Over/Under per line). */
const STANDARD_CORNER_LINES: readonly number[] = [6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5];

/**
 * For Over/Under Goals: keep multiple standard lines per bookmaker.
 * Groups by line, keeps only lines in standardLines, at most one Over and one Under per line (best odds).
 * Sorts by line ascending, then Over before Under.
 */
function selectStandardOverUnderLines(
  selections: NormalisedOddsSelection[],
  standardLines: readonly number[]
): NormalisedOddsSelection[] {
  if (selections.length === 0) return [];
  const standardSet = new Set(standardLines);
  const byLine = new Map<
    number,
    { over: NormalisedOddsSelection | null; under: NormalisedOddsSelection | null }
  >();
  for (const s of selections) {
    const line = parseOverUnderLine(s.label);
    if (line == null || !standardSet.has(line)) continue;
    let slot = byLine.get(line);
    if (!slot) {
      slot = { over: null, under: null };
      byLine.set(line, slot);
    }
    const lower = s.label.toLowerCase();
    if (lower.startsWith("over")) {
      if (!slot.over || (s.odds != null && (slot.over.odds == null || s.odds > slot.over.odds)))
        slot.over = s;
    } else if (lower.startsWith("under")) {
      if (!slot.under || (s.odds != null && (slot.under.odds == null || s.odds > slot.under.odds)))
        slot.under = s;
    }
  }
  const sortedLines = Array.from(byLine.keys()).sort((a, b) => a - b);
  const out: NormalisedOddsSelection[] = [];
  for (const line of sortedLines) {
    const slot = byLine.get(line)!;
    if (slot.over) out.push(slot.over);
    if (slot.under) out.push(slot.under);
  }
  return out;
}

/**
 * For Alternative Corners (69): keep multiple standard lines per bookmaker.
 * Ignores "Exactly" selections; only keeps Over/Under for STANDARD_CORNER_LINES.
 * At most one Over and one Under per line (best odds). Sorted by line asc, Over before Under.
 */
function selectStandardCornerLines(selections: NormalisedOddsSelection[]): NormalisedOddsSelection[] {
  if (selections.length === 0) return [];
  const standardSet = new Set(STANDARD_CORNER_LINES);
  const byLine = new Map<
    number,
    { over: NormalisedOddsSelection | null; under: NormalisedOddsSelection | null }
  >();
  for (const s of selections) {
    const lower = s.label.toLowerCase();
    if (lower.includes("exact")) continue;
    const num = parseFloat(s.label.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(num) || num <= 0) continue;
    const lineRounded = Math.round(num * 10) / 10;
    if (!standardSet.has(lineRounded)) continue;
    let slot = byLine.get(lineRounded);
    if (!slot) {
      slot = { over: null, under: null };
      byLine.set(lineRounded, slot);
    }
    if (lower.startsWith("over")) {
      if (!slot.over || (s.odds != null && (slot.over.odds == null || s.odds > slot.over.odds))) {
        slot.over = s;
      }
    } else if (lower.startsWith("under")) {
      if (!slot.under || (s.odds != null && (slot.under.odds == null || s.odds > slot.under.odds))) {
        slot.under = s;
      }
    }
  }
  const sortedLines = Array.from(byLine.keys()).sort((a, b) => a - b);
  const out: NormalisedOddsSelection[] = [];
  for (const line of sortedLines) {
    const slot = byLine.get(line)!;
    if (slot.over) out.push(slot.over);
    if (slot.under) out.push(slot.under);
  }
  return out;
}

/**
 * For Total Corners / Team Total Goals: keep only ONE main line per bookmaker (one Over + one Under).
 * Prefer the line where both Over and Under exist and |overOdds - underOdds| is smallest (most balanced).
 * Fallback: line with most selections; if tied, lowest line value.
 */
function selectMainOverUnderLine(selections: NormalisedOddsSelection[]): NormalisedOddsSelection[] {
  if (selections.length === 0) return [];
  const byLine = new Map<
    number,
    { over: NormalisedOddsSelection | null; under: NormalisedOddsSelection | null }
  >();
  for (const s of selections) {
    const line = parseOverUnderLine(s.label);
    if (line == null) continue;
    let slot = byLine.get(line);
    if (!slot) {
      slot = { over: null, under: null };
      byLine.set(line, slot);
    }
    const lower = s.label.toLowerCase();
    if (lower.startsWith("over")) {
      if (!slot.over || (s.odds != null && (slot.over.odds == null || s.odds > slot.over.odds)))
        slot.over = s;
    } else if (lower.startsWith("under")) {
      if (!slot.under || (s.odds != null && (slot.under.odds == null || s.odds > slot.under.odds)))
        slot.under = s;
    }
  }
  const linesWithBoth = Array.from(byLine.entries()).filter(([, slot]) => slot.over && slot.under);
  let chosenLine: number;
  if (linesWithBoth.length > 0) {
    const withDiff = linesWithBoth.map(([line, slot]) => {
      const overOdds = (slot.over!.odds ?? 0);
      const underOdds = (slot.under!.odds ?? 0);
      return { line, diff: Math.abs(overOdds - underOdds) };
    });
    withDiff.sort((a, b) => a.diff - b.diff);
    chosenLine = withDiff[0].line;
  } else {
    const linesByCount = Array.from(byLine.entries())
      .map(([line, slot]) => ({
        line,
        count: (slot.over ? 1 : 0) + (slot.under ? 1 : 0),
      }))
      .sort((a, b) => b.count - a.count || a.line - b.line);
    chosenLine = linesByCount[0]?.line ?? 0;
  }
  const slot = byLine.get(chosenLine);
  if (!slot) return [];
  const out: NormalisedOddsSelection[] = [];
  if (slot.over) out.push(slot.over);
  if (slot.under) out.push(slot.under);
  return out;
}

function mrOutcomeKey(label: string): string {
  const L = label.trim().toLowerCase();
  if (L === "1" || L === "home") return "home";
  if (L === "x" || L === "draw") return "draw";
  if (L === "2" || L === "away") return "away";
  return L;
}

/** Dedupe selections to at most one per outcome (keep best odds). Reusable for any market with a fixed outcome order. */
function dedupeSelectionsByOutcome(
  selections: NormalisedOddsSelection[],
  outcomeOrder: string[],
  outcomeKeyFn?: (label: string) => string
): NormalisedOddsSelection[] {
  const keyFn = outcomeKeyFn ?? ((l: string) => l.trim().toLowerCase());
  const byOutcome = new Map<string, NormalisedOddsSelection>();
  for (const s of selections) {
    const k = keyFn(s.label);
    const existing = byOutcome.get(k);
    const odds = s.odds ?? 0;
    if (!existing || odds > (existing.odds ?? 0)) byOutcome.set(k, s);
  }
  return outcomeOrder.map((outcome) => {
    const key = outcomeKeyFn ? outcomeKeyFn(outcome) : outcome.toLowerCase();
    return byOutcome.get(key) ?? null;
  }).filter((s): s is NormalisedOddsSelection => s != null);
}

/**
 * Single source for supported markets: id, name, classifier, normaliser, dedupe order.
 * To add Over/Under or player props: add entry here, add bucketKey to BookmakerEntry, implement classifier + normaliser.
 * Use getOutcomeOrder when outcome order is dynamic (e.g. Over/Under lines vary per bookmaker).
 */
type SupportedMarketConfig = {
  marketId: number;
  marketName: string;
  bucketKey: SupportedMarketBucketKey;
  classifier: (row: SportmonksOdd) => boolean;
  normaliser: MarketLabelNormaliser;
  outcomeOrder: string[];
  outcomeKeyFn?: (label: string) => string;
  /** When set, used instead of outcomeOrder to compute order from current selections (e.g. Over/Under). */
  getOutcomeOrder?: (selections: NormalisedOddsSelection[]) => string[];
};

const MARKET_NAME_ALTERNATIVE_CORNERS = "Alternative Corners";
const MARKET_NAME_TEAM_TOTAL_GOALS = "Team Total Goals";

const SUPPORTED_MARKET_CONFIGS: SupportedMarketConfig[] = [
  {
    marketId: MARKET_ID_MATCH_RESULTS,
    marketName: MARKET_NAME_MATCH_RESULTS,
    bucketKey: "matchResults",
    classifier: isMatchResultsMarket,
    normaliser: normaliseMRLabel as MarketLabelNormaliser,
    outcomeOrder: ["Home", "Draw", "Away"],
    outcomeKeyFn: mrOutcomeKey,
  },
  {
    marketId: MARKET_ID_BTTS,
    marketName: MARKET_NAME_BTTS,
    bucketKey: "btts",
    classifier: isBTTSMarket,
    normaliser: normaliseBTTSLabel as MarketLabelNormaliser,
    outcomeOrder: ["Yes", "No"],
  },
  {
    marketId: MARKET_ID_MATCH_GOALS,
    marketName: MARKET_NAME_OVER_UNDER,
    bucketKey: "overUnder",
    classifier: isOverUnderMarket,
    normaliser: normaliseOverUnderLabel as MarketLabelNormaliser,
    outcomeOrder: [],
    outcomeKeyFn: (label) => label,
    getOutcomeOrder: (selections) => sortOverUnderOutcomeOrder(selections.map((s) => s.label)),
  },
  {
    marketId: MARKET_ID_ALTERNATIVE_TOTAL_GOALS,
    marketName: "Alternative Goals",
    bucketKey: "alternativeGoals",
    classifier: isAlternativeTotalGoalsMarket,
    normaliser: normaliseOverUnderLabel as MarketLabelNormaliser,
    outcomeOrder: [],
    outcomeKeyFn: (label) => label,
    getOutcomeOrder: (selections) => sortOverUnderOutcomeOrder(selections.map((s) => s.label)),
  },
  {
    marketId: MARKET_ID_ALTERNATIVE_CORNERS,
    marketName: MARKET_NAME_ALTERNATIVE_CORNERS,
    bucketKey: "totalCorners",
    classifier: isCornersOverUnderMarket,
    normaliser: normaliseOverUnderLabel as MarketLabelNormaliser,
    outcomeOrder: [],
    outcomeKeyFn: (label) => label,
    getOutcomeOrder: (selections) => sortOverUnderOutcomeOrder(selections.map((s) => s.label)),
  },
  {
    marketId: MARKET_ID_TEAM_TOTAL_GOALS,
    marketName: MARKET_NAME_TEAM_TOTAL_GOALS,
    bucketKey: "teamTotalGoals",
    classifier: isTeamTotalGoalsMarket,
    normaliser: normaliseOverUnderLabel as MarketLabelNormaliser,
    outcomeOrder: [],
    outcomeKeyFn: (label) => label,
    getOutcomeOrder: (selections) => sortOverUnderOutcomeOrder(selections.map((s) => s.label)),
  },
];

/** Supported markets for display/API. Derived from SUPPORTED_MARKET_CONFIGS. */
export const ALLOWED_MARKETS: Record<number, string> = Object.fromEntries(
  SUPPORTED_MARKET_CONFIGS.map((m) => [m.marketId, m.marketName])
);

/**
 * Fetches odds for a fixture via Sportmonks and returns normalised shape.
 * On request failure or no data, returns { fixtureId, bookmakers: [] }. Does not throw.
 */
export async function getOddsByFixtureId(fixtureId: number): Promise<NormalisedOddsResponse> {
  const empty = (): NormalisedOddsResponse => ({ fixtureId, bookmakers: [] });
  const isDev = process.env.NODE_ENV !== "production";

  const token = getSportmonksToken();
  if (!token) {
    if (isDev) console.log("[odds] sportmonks request | fixtureId:", fixtureId, "| token missing");
    return empty();
  }

  if (isDev)
    console.log("[odds] sportmonks request fixtureId:", fixtureId, "| markets:", ACTIVE_ODDS_MARKET_IDS.join(", "));

  let results: SportmonksOdd[][];
  try {
    results = await Promise.all(
      ACTIVE_ODDS_MARKET_IDS.map((marketId) => fetchMarketOddsForFixture(fixtureId, marketId, token))
    );
  } catch {
    if (isDev) console.log("[odds] sportmonks response\nrawOddsCount: (request failed)");
    return empty();
  }

  const rawData: SportmonksOdd[] = results.flat();

  if (isDev && fixtureId === DEBUG_FIXTURE_ID) {
    console.log(
      "[odds][api] market fetch results",
      results.map((rows, i) => {
        const ids = new Set<number>();
        for (const r of rows) {
          const id = r.bookmaker_id ?? (r.bookmaker as { id?: number })?.id ?? (r.bookmaker as { data?: { id?: number } })?.data?.id;
          if (id != null && typeof id === "number") ids.add(id);
        }
        return { marketId: ACTIVE_ODDS_MARKET_IDS[i], rowCount: rows.length, uniqueBookmakerIds: Array.from(ids).sort((a, b) => a - b) };
      })
    );
  }

  if (isDev) console.log("[odds] sportmonks response\nrawOddsCount:", rawData.length);

  if (rawData.length === 0) {
    if (isDev) console.log("[odds] normalised\nbookmakers: 0\nmatchResultsFound: false\nbttsFound: false");
    return empty();
  }

  if (isDev && fixtureId === DEBUG_FIXTURE_ID) {
    const corners69Rows = rawData.filter((r) => getMarketMeta(r).marketId === MARKET_ID_ALTERNATIVE_CORNERS);
    console.log(
      "[corners69][raw]",
      corners69Rows.map((row) => ({
        bookmakerId: row.bookmaker_id,
        bookmakerName: row.bookmaker?.name ?? row.bookmaker_name,
        marketId: row.market_id ?? row.market?.id,
        marketName: row.market?.name ?? row.market_name,
        marketDeveloperName: (row.market as { developer_name?: string })?.developer_name ?? "",
        label: row.label,
        name: row.name,
        value: row.value,
        total: row.total,
        handicap: row.handicap,
      }))
    );
  }

  if (isDev && fixtureId === DEBUG_FIXTURE_ID) {
    const ou80Rows = rawData.filter((r) => getMarketMeta(r).marketId === MARKET_ID_MATCH_GOALS);
    console.log(
      "[odds][ou80][raw]",
      ou80Rows.map((row) => ({
        bookmakerId: row.bookmaker_id,
        bookmakerName: row.bookmaker?.name ?? row.bookmaker_name,
        marketId: row.market_id ?? row.market?.id,
        marketName: row.market?.name ?? row.market_name,
        marketDeveloperName: (row.market as { developer_name?: string })?.developer_name ?? "",
        label: row.label,
        name: row.name,
        value: row.value,
        total: row.total,
        handicap: row.handicap,
        dp3: (row as Record<string, unknown>).dp3,
      }))
    );
    const ou80ByBookmaker = new Map<string, { bookmakerName: string; rawLinesDetected: number[]; rawLabels: string[] }>();
    for (const r of ou80Rows) {
      const { bookmakerId, bookmakerName } = resolveBookmakerInfo(r);
      const key = bookmakerGroupKey(bookmakerId, bookmakerName);
      if (!ou80ByBookmaker.has(key)) {
        ou80ByBookmaker.set(key, { bookmakerName, rawLinesDetected: [], rawLabels: [] });
      }
      const rec = ou80ByBookmaker.get(key)!;
      const line = getOverUnderLineFromRow(r);
      if (line != null) rec.rawLinesDetected.push(line);
      rec.rawLabels.push(typeof r.label === "string" ? r.label : (r.name as string) ?? "");
    }
    console.log(
      "[odds][ou80][summary]",
      Array.from(ou80ByBookmaker.values()).map((v) => ({
        bookmakerName: v.bookmakerName,
        rawLinesDetected: v.rawLinesDetected,
        rawLabels: v.rawLabels,
      }))
    );
  }

  if (isDev && fixtureId === DEBUG_FIXTURE_ID) {
    const ouRawRows = rawData.filter((r) => isOverUnderMarket(r));
    console.log(
      "[odds][ou][raw] rows",
      ouRawRows.map((r) => {
        const meta = getMarketMeta(r);
        const { bookmakerId, bookmakerName } = resolveBookmakerInfo(r);
        return {
          bookmakerId,
          bookmakerName,
          marketId: meta.marketId,
          marketName: meta.marketName,
          label: r.label,
          name: r.name,
          value: r.value,
          total: r.total,
          handicap: r.handicap,
          odds: parseOddsValue(r.value),
        };
      })
    );
  }

  if (isDev && fixtureId === DEBUG_FIXTURE_ID) {
    const uniqueMarketsById = new Map<
      number,
      { marketId: number; marketName: string; marketDeveloperName: string; marketDescription: string }
    >();
    for (const row of rawData) {
      const marketId =
        row.market_id ??
        row.market?.id ??
        (row.market as { data?: { id?: number } })?.data?.id ??
        null;
      const marketName =
        row.market?.name ??
        (row.market as { data?: { name?: string } })?.data?.name ??
        row.market_name ??
        "";
      const marketDeveloperName =
        (row.market as { developer_name?: string })?.developer_name ??
        (row.market as { data?: { developer_name?: string } })?.data?.developer_name ??
        "";
      const marketDescription =
        (row.market as { description?: string })?.description ??
        (row.market as { data?: { description?: string } })?.data?.description ??
        row.market_description ??
        "";
      const id = marketId != null && typeof marketId === "number" ? marketId : 0;
      if (!uniqueMarketsById.has(id)) {
        uniqueMarketsById.set(id, {
          marketId: id,
          marketName: String(marketName),
          marketDeveloperName: String(marketDeveloperName),
          marketDescription: String(marketDescription),
        });
      }
    }
    console.log("[odds][markets] unique markets", Array.from(uniqueMarketsById.values()));
  }

  type TraceGroupedEntry = {
    bookmakerKey: string;
    bookmakerId: number;
    bookmakerName: string;
    marketId: number;
    selections: Array<{ label: string; odds: number | null }>;
  };
  let traceStrictMR: SportmonksOdd[] = [];
  let traceStrictBTTS: SportmonksOdd[] = [];
  let traceStrictOU: SportmonksOdd[] = [];
  let traceAllowedMR: SportmonksOdd[] = [];
  let traceAllowedBTTS: SportmonksOdd[] = [];
  let traceAllowedOU: SportmonksOdd[] = [];
  let traceGroupedMR: TraceGroupedEntry[] = [];
  let traceGroupedBTTS: TraceGroupedEntry[] = [];
  let traceGroupedOU: TraceGroupedEntry[] = [];

  // ----- [odds][debug] fixture-specific full raw evidence (dev only) -----
  if (isDev && fixtureId === DEBUG_FIXTURE_ID) {
    const seenBookmakers = new Map<string, { bookmakerId: number | string; bookmakerName: string }>();
    const seenMarkets = new Map<string, { marketId: number | string; marketName: string; marketDescription: string }>();
    for (const row of rawData) {
      const { bookmakerId, bookmakerName } = resolveBookmakerInfo(row);
      const bkKey = bookmakerId != null ? `id:${bookmakerId}` : `name:${normaliseBookmakerName(bookmakerName)}`;
      if (!seenBookmakers.has(bkKey)) {
        seenBookmakers.set(bkKey, { bookmakerId: bookmakerId ?? "—", bookmakerName });
      }
      const mId = row.market_id ?? (row.market as { id?: number })?.id ?? "";
      const mName = debugMarketName(row) || "—";
      const mDesc = debugMarketDesc(row) || "—";
      const mkKey = `${mId}|${mName}|${mDesc}`;
      if (!seenMarkets.has(mkKey)) {
        seenMarkets.set(mkKey, { marketId: mId ?? "—", marketName: mName, marketDescription: mDesc });
      }
    }
    console.log("[odds][debug] raw unique bookmakers", Array.from(seenBookmakers.values()));
    console.log("[odds][debug] raw unique markets", Array.from(seenMarkets.values()));

    const williamHillRows = rawData.filter((r) => {
      const n = resolveBookmakerInfo(r).bookmakerName.toLowerCase();
      return n.includes("william") || n.includes("hill");
    });
    console.log("[odds][debug] raw William Hill rows", williamHillRows.map(debugRowShape));

    const paddyPowerRows = rawData.filter((r) => {
      const n = resolveBookmakerInfo(r).bookmakerName.toLowerCase();
      return n.includes("paddy") || n.includes("power");
    });
    console.log("[odds][debug] raw Paddy Power rows", paddyPowerRows.map(debugRowShape));

    const bttsRows = rawData.filter((r) => isBTTSMarket(r));
    console.log("[odds][debug] raw BTTS candidate rows", bttsRows.map(debugRowShape));

    const mrRows = rawData.filter((r) => isMatchResultsMarket(r));
    console.log("[odds][debug] raw Match Results candidate rows", mrRows.map(debugRowShape));

    const strictAcceptedMatchResultsRows = rawData.filter((r) => isMatchResultsMarket(r));
    const strictAcceptedBTTSRows = rawData.filter((r) => isBTTSMarket(r));
    const allowedMatchResultsRows = rawData.filter((r) => {
      if (!isMatchResultsMarket(r)) return false;
      const { bookmakerId, bookmakerName } = resolveBookmakerInfo(r);
      return isAllowedBookmaker(bookmakerId, bookmakerName);
    });
    const allowedBTTSRows = rawData.filter((r) => {
      if (!isBTTSMarket(r)) return false;
      const { bookmakerId, bookmakerName } = resolveBookmakerInfo(r);
      return isAllowedBookmaker(bookmakerId, bookmakerName);
    });
    const strictAcceptedOURows = rawData.filter((r) => isOverUnderMarket(r));
    const allowedOURows = rawData.filter((r) => {
      if (!isOverUnderMarket(r)) return false;
      const { bookmakerId, bookmakerName } = resolveBookmakerInfo(r);
      return isAllowedBookmaker(bookmakerId, bookmakerName);
    });

    traceStrictMR = strictAcceptedMatchResultsRows;
    traceStrictBTTS = strictAcceptedBTTSRows;
    traceStrictOU = strictAcceptedOURows;
    traceAllowedMR = allowedMatchResultsRows;
    traceAllowedBTTS = allowedBTTSRows;
    traceAllowedOU = allowedOURows;

    console.log("[odds][ou] accepted rows (strict)", strictAcceptedOURows.map((r) => traceRowShape(r, getMarketMeta(r))));
    console.log("[odds][ou] accepted rows (allowed)", allowedOURows.map((r) => traceRowShape(r, getMarketMeta(r))));

    console.log("[odds][trace] strictAcceptedMatchResultsRows", strictAcceptedMatchResultsRows.map((r) => traceRowShape(r, getMarketMeta(r))));
    console.log("[odds][trace] strictAcceptedBTTSRows", strictAcceptedBTTSRows.map((r) => traceRowShape(r, getMarketMeta(r))));
    console.log("[odds][trace] allowedMatchResultsRows", allowedMatchResultsRows.map((r) => traceRowShape(r, getMarketMeta(r))));
    console.log("[odds][trace] allowedBTTSRows", allowedBTTSRows.map((r) => traceRowShape(r, getMarketMeta(r))));

    const acceptedMRPre = strictAcceptedMatchResultsRows;
    const acceptedBTTSPre = strictAcceptedBTTSRows;
    console.log("[odds][strict][pre-filter] accepted match-results rows", acceptedMRPre.map(strictAcceptedRowShape));
    console.log("[odds][strict][pre-filter] accepted btts rows", acceptedBTTSPre.map(strictAcceptedRowShape));

    const preMRByKey: Record<string, number> = {};
    const preBTTSByKey: Record<string, number> = {};
    for (const r of acceptedMRPre) {
      const key = bookmakerGroupKey(resolveBookmakerInfo(r).bookmakerId, resolveBookmakerInfo(r).bookmakerName);
      preMRByKey[key] = (preMRByKey[key] ?? 0) + 1;
    }
    for (const r of acceptedBTTSPre) {
      const key = bookmakerGroupKey(resolveBookmakerInfo(r).bookmakerId, resolveBookmakerInfo(r).bookmakerName);
      preBTTSByKey[key] = (preBTTSByKey[key] ?? 0) + 1;
    }
    console.log("[odds][strict][pre-filter] match-results counts by bookmaker", preMRByKey);
    console.log("[odds][strict][pre-filter] btts counts by bookmaker", preBTTSByKey);

    console.log("[odds][strict][post-filter] accepted match-results rows", allowedMatchResultsRows.map(strictAcceptedRowShape));
    console.log("[odds][strict][post-filter] accepted btts rows", allowedBTTSRows.map(strictAcceptedRowShape));

    const postMRByKey: Record<string, number> = {};
    const postBTTSByKey: Record<string, number> = {};
    for (const r of allowedMatchResultsRows) {
      const key = bookmakerGroupKey(resolveBookmakerInfo(r).bookmakerId, resolveBookmakerInfo(r).bookmakerName);
      postMRByKey[key] = (postMRByKey[key] ?? 0) + 1;
    }
    for (const r of allowedBTTSRows) {
      const key = bookmakerGroupKey(resolveBookmakerInfo(r).bookmakerId, resolveBookmakerInfo(r).bookmakerName);
      postBTTSByKey[key] = (postBTTSByKey[key] ?? 0) + 1;
    }
    console.log("[odds][strict][post-filter] match-results counts by bookmaker", postMRByKey);
    console.log("[odds][strict][post-filter] btts counts by bookmaker", postBTTSByKey);
  }

  if (ODDS_DEBUG_VERBOSE) {
    for (const row of rawData) {
      const marketName = row.market?.name ?? row.market_name ?? "—";
      const marketDesc = row.market?.description ?? row.market_description ?? "—";
      console.log("[odds] raw row", {
        id: row.id ?? "—",
        fixture_id: row.fixture_id ?? "—",
        bookmaker_id: row.bookmaker_id ?? row.bookmaker?.id ?? "—",
        bookmaker_name: row.bookmaker?.name ?? "—",
        market_id: row.market_id ?? row.market?.id ?? "—",
        market_name: marketName,
        market_description: marketDesc,
        label: row.label ?? row.name ?? "—",
        value: row.value ?? "—",
        odds: parseOddsValue(row.value) ?? "—",
      });
    }
  }

  // Group by stable bookmaker key (resolved id or normalised name); only allowed bookmakers
  type BookmakerEntry = {
    bookmakerId: number;
    bookmakerName: string;
    matchResults: NormalisedOddsSelection[];
    btts: NormalisedOddsSelection[];
    overUnder: NormalisedOddsSelection[];
    alternativeGoals: NormalisedOddsSelection[];
    totalCorners: NormalisedOddsSelection[];
    teamTotalGoals: NormalisedOddsSelection[];
  };
  const byKey = new Map<string, BookmakerEntry>();

  const ouStyleBucketKeys: SupportedMarketBucketKey[] = ["overUnder", "alternativeGoals", "totalCorners", "teamTotalGoals"];

  for (const row of rawData) {
    if (row.suspended === true || row.stopped === true) continue;
    const { bookmakerId: resolvedId, bookmakerName: resolvedName } = resolveBookmakerInfo(row);
    if (!isAllowedBookmaker(resolvedId, resolvedName)) continue;

    const key = bookmakerGroupKey(resolvedId, resolvedName);
    const canonicalId = canonicalBookmakerId(resolvedId, resolvedName);
    const displayName = resolvedName || (ALLOWED_BOOKMAKERS[canonicalId] ?? `Bookmaker ${canonicalId}`);

    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        bookmakerId: canonicalId,
        bookmakerName: displayName,
        matchResults: [],
        btts: [],
        overUnder: [],
        alternativeGoals: [],
        totalCorners: [],
        teamTotalGoals: [],
      };
      byKey.set(key, entry);
    }

    const label = typeof row.label === "string" ? row.label.trim() || (row.name as string) : (row.name as string) ?? "—";
    const value = row.value ?? null;
    const odds = parseOddsValue(row.value);

    for (const config of SUPPORTED_MARKET_CONFIGS) {
      if (!config.classifier(row)) continue;
      let canonicalLabel: string | null;
      let selValue: string | number | null = value;
      if (ouStyleBucketKeys.includes(config.bucketKey)) {
        const line = getOverUnderLineFromRow(row);
        canonicalLabel = normaliseOverUnderLabel(label, line);
        if (canonicalLabel != null && line != null) selValue = line;
      } else {
        canonicalLabel = config.normaliser(label, row.value);
      }
      if (canonicalLabel === null) break;
      const bucket = entry[config.bucketKey];
      const existing = bucket.find((s) => s.label === canonicalLabel);
      const sel: NormalisedOddsSelection = { label: canonicalLabel, value: selValue, odds };
      if (existing) {
        if (odds != null && (existing.odds == null || odds > existing.odds)) {
          existing.value = value;
          existing.odds = odds;
        }
      } else {
        bucket.push(sel);
      }
      break;
    }
  }

  if (isDev && fixtureId === DEBUG_FIXTURE_ID) {
    traceGroupedMR = Array.from(byKey.entries())
      .filter(([, e]) => e.matchResults.length > 0)
      .map(([key, e]) => ({
        bookmakerKey: key,
        bookmakerId: e.bookmakerId,
        bookmakerName: e.bookmakerName,
        marketId: MARKET_ID_MATCH_RESULTS,
        selections: e.matchResults.map((s) => ({ label: s.label, odds: s.odds })),
      }));
    traceGroupedBTTS = Array.from(byKey.entries())
      .filter(([, e]) => e.btts.length > 0)
      .map(([key, e]) => ({
        bookmakerKey: key,
        bookmakerId: e.bookmakerId,
        bookmakerName: e.bookmakerName,
        marketId: MARKET_ID_BTTS,
        selections: e.btts.map((s) => ({ label: s.label, odds: s.odds })),
      }));
    traceGroupedOU = Array.from(byKey.entries())
      .filter(([, e]) => e.overUnder.length > 0)
      .map(([key, e]) => ({
        bookmakerKey: key,
        bookmakerId: e.bookmakerId,
        bookmakerName: e.bookmakerName,
        marketId: MARKET_ID_MATCH_GOALS,
        selections: e.overUnder.map((s) => ({ label: s.label, odds: s.odds })),
      }));
    console.log("[odds][trace] groupedMatchResultsByBookmaker", traceGroupedMR);
    console.log("[odds][trace] groupedBTTSByBookmaker", traceGroupedBTTS);
    console.log("[odds][ou] grouped rows", traceGroupedOU);
  }

  const preferredIds = PREFERRED_BOOKMAKER_ORDER.map((b) => b.id);
  const sortedEntries = Array.from(byKey.entries()).sort((a, b) => {
    const idA = a[1].bookmakerId;
    const idB = b[1].bookmakerId;
    const idxA = preferredIds.indexOf(idA);
    const idxB = preferredIds.indexOf(idB);
    if (idxA >= 0 && idxB >= 0) return idxA - idxB;
    if (idxA >= 0) return -1;
    if (idxB >= 0) return 1;
    return idA - idB;
  });

  const bookmakers: NormalisedOddsBookmaker[] = [];
  let matchResultsFound = false;
  let bttsFound = false;
  let overUnderFound = false;
  for (const [, entry] of sortedEntries) {
    const marketsOut: NormalisedOddsMarket[] = [];
    for (const config of SUPPORTED_MARKET_CONFIGS) {
      const bucket = entry[config.bucketKey];
      const order = config.getOutcomeOrder ? config.getOutcomeOrder(bucket) : config.outcomeOrder;
      const deduped = dedupeSelectionsByOutcome(bucket, order, config.outcomeKeyFn);
      if (deduped.length > 0) {
        if (config.bucketKey === "matchResults") matchResultsFound = true;
        if (config.bucketKey === "btts") bttsFound = true;
        if (config.bucketKey === "overUnder") overUnderFound = true;
        if (config.bucketKey === "overUnder") {
          const ouSelections = selectMainOverUnderLine(deduped);
          if (ouSelections.length > 0) {
            marketsOut.push({
              marketId: config.marketId,
              marketName: config.marketName,
              selections: ouSelections,
            });
          }
        } else if (config.bucketKey === "alternativeGoals") {
          const altSelections = selectStandardOverUnderLines(deduped, STANDARD_GOAL_LINES);
          if (isDev && fixtureId === DEBUG_FIXTURE_ID && altSelections.length > 0) {
            console.log("[multiline] alternative-goals kept lines", {
              bookmakerName: entry.bookmakerName,
              selections: altSelections.map((s) => ({ label: s.label, odds: s.odds })),
            });
          }
          if (altSelections.length > 0) {
            marketsOut.push({
              marketId: config.marketId,
              marketName: config.marketName,
              selections: altSelections,
            });
          }
        } else if (config.bucketKey === "totalCorners" || config.bucketKey === "teamTotalGoals") {
          let selectionsForMarket: NormalisedOddsSelection[] = [];
          if (config.bucketKey === "totalCorners") {
            selectionsForMarket = selectStandardCornerLines(deduped);
            if (isDev && fixtureId === DEBUG_FIXTURE_ID && selectionsForMarket.length > 0) {
              console.log("[multiline] alternative-corners kept lines", {
                bookmakerName: entry.bookmakerName,
                selections: selectionsForMarket.map((s) => ({ label: s.label, odds: s.odds })),
              });
            }
          } else {
            selectionsForMarket = selectMainOverUnderLine(deduped);
          }
          if (selectionsForMarket.length > 0) {
            marketsOut.push({
              marketId: config.marketId,
              marketName: config.marketName,
              selections: selectionsForMarket,
            });
          }
        } else {
          marketsOut.push({
            marketId: config.marketId,
            marketName: config.marketName,
            selections: deduped,
          });
        }
      }
    }
    if (marketsOut.length > 0) {
      bookmakers.push({
        bookmakerId: entry.bookmakerId,
        bookmakerName: entry.bookmakerName,
        markets: marketsOut,
      });
    }
  }

  if (isDev) {
    const mrCount = bookmakers.filter((b) => b.markets.some((m) => m.marketId === MARKET_ID_MATCH_RESULTS)).length;
    const bttsCount = bookmakers.filter((b) => b.markets.some((m) => m.marketId === MARKET_ID_BTTS)).length;
    const ouCount = bookmakers.filter((b) => b.markets.some((m) => m.marketId === MARKET_ID_MATCH_GOALS)).length;
    console.log("[odds] normalised\nbookmakers:", bookmakers.length, "\nmatchResultsFound:", matchResultsFound, "\nbttsFound:", bttsFound, "\noverUnderFound:", overUnderFound);
    console.log("[odds] final: bookmakers with Match Results:", mrCount, "| BTTS:", bttsCount, "| Over/Under:", ouCount);
  }

  if (isDev && fixtureId === DEBUG_FIXTURE_ID) {
    console.log("[odds][trace] finalNormalisedBookmakers", JSON.parse(JSON.stringify(bookmakers)));

    const finalMRBookmakers = bookmakers.filter((b) => b.markets.some((m) => m.marketId === MARKET_ID_MATCH_RESULTS));
    const finalBTTSBookmakers = bookmakers.filter((b) => b.markets.some((m) => m.marketId === MARKET_ID_BTTS));
    console.log("[odds][trace] counts", {
      strictAcceptedMatchResults: traceStrictMR.length,
      strictAcceptedBTTS: traceStrictBTTS.length,
      allowedMatchResults: traceAllowedMR.length,
      allowedBTTS: traceAllowedBTTS.length,
      groupedMatchResultsBookmakers: traceGroupedMR.length,
      groupedBTTSBookmakers: traceGroupedBTTS.length,
      finalBookmakers: bookmakers.length,
      finalMatchResultsBookmakers: finalMRBookmakers.length,
      finalBTTSBookmakers: finalBTTSBookmakers.length,
    });

    const ALLOWED_NAMES_FOR_MATRIX = PREFERRED_BOOKMAKER_ORDER.map((b) => b.name);
    const strictMRNames = new Set(traceStrictMR.map((r) => normaliseBookmakerName(resolveBookmakerInfo(r).bookmakerName)));
    const strictBTTSNames = new Set(traceStrictBTTS.map((r) => normaliseBookmakerName(resolveBookmakerInfo(r).bookmakerName)));
    const allowedMRNames = new Set(traceAllowedMR.map((r) => normaliseBookmakerName(resolveBookmakerInfo(r).bookmakerName)));
    const allowedBTTSNames = new Set(traceAllowedBTTS.map((r) => normaliseBookmakerName(resolveBookmakerInfo(r).bookmakerName)));
    const groupedMRNames = new Set(traceGroupedMR.map((e) => normaliseBookmakerName(e.bookmakerName)));
    const groupedBTTSNames = new Set(traceGroupedBTTS.map((e) => normaliseBookmakerName(e.bookmakerName)));
    const finalMRNames = new Set(finalMRBookmakers.map((b) => normaliseBookmakerName(b.bookmakerName)));
    const finalBTTSNames = new Set(finalBTTSBookmakers.map((b) => normaliseBookmakerName(b.bookmakerName)));

    const bookmakerPresenceMatrix = ALLOWED_NAMES_FOR_MATRIX.map((bookmakerName) => {
      const norm = normaliseBookmakerName(bookmakerName);
      return {
        bookmakerName,
        matchResults: {
          strictAccepted: strictMRNames.has(norm),
          allowed: allowedMRNames.has(norm),
          grouped: groupedMRNames.has(norm),
          final: finalMRNames.has(norm),
        },
        btts: {
          strictAccepted: strictBTTSNames.has(norm),
          allowed: allowedBTTSNames.has(norm),
          grouped: groupedBTTSNames.has(norm),
          final: finalBTTSNames.has(norm),
        },
      };
    });
    console.log("[odds][trace] bookmaker presence matrix", bookmakerPresenceMatrix);

    console.log("[odds][strict] final normalised bookmakers", JSON.parse(JSON.stringify(bookmakers)));

    const matchResultsBookmakers = bookmakers
      .filter((b) => b.markets.some((m) => m.marketId === MARKET_ID_MATCH_RESULTS))
      .map((b) => b.bookmakerName);
    const bttsBookmakers = bookmakers
      .filter((b) => b.markets.some((m) => m.marketId === MARKET_ID_BTTS))
      .map((b) => b.bookmakerName);
    console.log("[odds][strict][final] bookmaker names in output", {
      matchResultsBookmakers,
      bttsBookmakers,
    });

    console.log(
      "[odds][ou] final selections",
      bookmakers.map((b) => {
        const ou = b.markets.find((m) => m.marketId === MARKET_ID_MATCH_GOALS);
        return { bookmaker: b.bookmakerName, selections: ou?.selections ?? [] };
      })
    );

    for (const b of bookmakers) {
      const idAllowed = ALLOWED_BOOKMAKER_IDS.has(b.bookmakerId);
      const nameAllowed = ALLOWED_BOOKMAKER_NAMES.has(normaliseBookmakerName(b.bookmakerName));
      if (!idAllowed && !nameAllowed) {
        console.warn("[odds][strict] validation: bookmaker in final output is not in allowed list", {
          bookmakerId: b.bookmakerId,
          bookmakerName: b.bookmakerName,
        });
      }
    }

    const MR_LABELS = new Set(["Home", "Draw", "Away"]);
    const BTTS_LABELS = new Set(["Yes", "No"]);
    for (const b of bookmakers) {
      for (const m of b.markets) {
        if (m.marketId === MARKET_ID_MATCH_RESULTS) {
          if (m.selections.length !== 3) {
            console.warn("[odds][strict] validation: Match Results has not exactly 3 selections", {
              bookmakerId: b.bookmakerId,
              bookmakerName: b.bookmakerName,
              count: m.selections.length,
              labels: m.selections.map((s) => s.label),
            });
          }
          const labels = new Set(m.selections.map((s) => s.label));
          if (labels.size !== 3 || ![...labels].every((l) => MR_LABELS.has(l))) {
            console.warn("[odds][strict] validation: Match Results labels are not exactly Home, Draw, Away", {
              bookmakerId: b.bookmakerId,
              bookmakerName: b.bookmakerName,
              labels: m.selections.map((s) => s.label),
            });
          }
        }
        if (m.marketId === MARKET_ID_BTTS) {
          if (m.selections.length !== 2) {
            console.warn("[odds][strict] validation: BTTS has not exactly 2 selections", {
              bookmakerId: b.bookmakerId,
              bookmakerName: b.bookmakerName,
              count: m.selections.length,
              labels: m.selections.map((s) => s.label),
            });
          }
          const labels = new Set(m.selections.map((s) => s.label));
          if (labels.size !== 2 || ![...labels].every((l) => BTTS_LABELS.has(l))) {
            console.warn("[odds][strict] validation: BTTS labels are not exactly Yes, No", {
              bookmakerId: b.bookmakerId,
              bookmakerName: b.bookmakerName,
              labels: m.selections.map((s) => s.label),
            });
          }
        }
      }
    }
  }

  return { fixtureId, bookmakers };
}

/*
  Odds pipeline notes
  ------------------
  - Bookmakers: PREFERRED_BOOKMAKER_ORDER is the single source; ALLOWED_BOOKMAKERS, IDs, and
    normalised names are derived. Bookmaker resolution uses id/name from row or relation.
  - Markets: Match Results, BTTS, Match Goals (ids from constants/marketIds). Classification via isMatchResultsMarket /
    isBTTSMarket (marketId, developer_name, normalised name/description). Selection labels
    normalised by normaliseMRLabel / normaliseBTTSLabel; unknown labels dropped.
  - Dedupe: One selection per outcome (Home/Draw/Away; Yes/No), keeping highest odds.
  - Debug: Set DEBUG_FIXTURE_ID to a fixture id (or 0 to disable) for trace/strict/validation
    logs. Set ODDS_DEBUG=1 in dev for per-row and generic verbose logs.
*/

/*
  Verification and selection mapping (debug fixture only):

  - Logs A–E: [odds][strict] accepted match-results rows (A), accepted btts rows (B), raw rows
    per bookmaker: accepted Match Results (C), accepted BTTS (D), final normalised bookmakers (E).
    E includes the full array (bookmakerId, bookmakerName, markets, selections) for inspection.

  - Selection mapping: Match Results only accepts Home/1 -> Home, Draw/X -> Draw, Away/2 -> Away;
    any other label is ignored. BTTS only accepts Yes/Y -> Yes, No/N -> No. Unknown labels do
    not appear in the final output. Best-odds deduplication per outcome is unchanged.

  - Validation (dev): For the debug fixture we warn if any bookmaker’s Match Results market has
    not exactly 3 selections or labels are not exactly Home, Draw, Away (in some order). We
    warn if BTTS has not exactly 2 selections or labels are not exactly Yes, No. Check the
    console for "[odds][strict] validation:" warnings.

  - In the final normalised bookmakers log (E): final Match Results bookmaker count = number
    of bookmakers that have a market with MARKET_ID_MATCH_RESULTS; final BTTS bookmaker count = number with
    MARKET_ID_BTTS. William Hill should show exactly Home, Draw, Away for Match Results; bet365
    (and any other bookmaker with BTTS) should show exactly Yes, No. If no validation warnings
    appear, counts and labels are correct.
*/

/*
  Debug pipeline: pre-filter vs post-filter (debug fixture only).

  - Pre-filter ([odds][strict][pre-filter]): All raw rows that pass strict market classification
    (isMatchResultsMarket / isBTTSMarket) regardless of bookmaker. Extra bookmakers can appear
    here if they have MR/BTTS markets in the raw response but are not in our allowed list.

  - Post-filter ([odds][strict][post-filter]): Only raw rows that pass strict market classification
    AND whose bookmaker passes isAllowedBookmaker (allowed IDs or normalised names). This is the
    set that feeds into the normalisation loop; the final returned output contains only these.

  - [odds][strict][final] bookmaker names in output: Derived from the actual final normalised
    bookmakers array returned to the frontend. matchResultsBookmakers = names of bookmakers
    that have a Match Results market; bttsBookmakers = names that have a BTTS market. These
    should all be from the allowed set (bet365, SkyBet, PaddyPower, WilliamHill, Coral,
    Ladbrokes, Betfair).

  - If any bookmaker in the final output is not in the allowed list, a validation warning is
    logged. The runtime filtering only keeps allowed bookmakers, so the final output should
    contain only allowed bookmakers; the warning would indicate a bug in resolution or the
    allowed matcher.
*/
