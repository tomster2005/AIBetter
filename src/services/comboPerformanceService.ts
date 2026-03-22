import type { BuildCombo, BuildLeg, ComboScoreBreakdown } from "../lib/valueBetBuilder.js";
import {
  formatCountComparison,
  inferPlayerPropStatCategoryFromLeg,
  settleBtts,
  settleCountOverUnder,
  settleMatchResult,
  settleYesNoAgainstLine,
} from "../lib/betSettlementHelpers.js";
import { getCompressedNormalizedScore } from "../lib/modelScoreNormalization.js";
import { fetchFixtureResolutionData } from "./comboResolutionDataService.js";

const STORAGE_KEY = "valueBetComboRecords:v1";

type ComboResult = "win" | "loss";

export interface StoredComboLeg {
  legId?: string;
  type: BuildLeg["type"];
  marketName: string;
  marketFamily: string;
  label: string;
  playerName?: string;
  /** Sportmonks player id when known at save time — preferred for post-match stat lookup. */
  sportmonksPlayerId?: number;
  /** Sportmonks market id when known at save time (audit / settlement hints). */
  marketId?: number;
  bookmakerName?: string;
  odds?: number;
  line: number;
  outcome: BuildLeg["outcome"];
  /** LocalStorage row had an unparsable outcome token — never coerce to a bet result. */
  outcomeInvalid?: boolean;
}

/** Last known reconciliation state (persisted). Distinguishes live matches vs FT awaiting stats. */
export interface ResolutionAttemptMeta {
  lastResolutionAttemptAt: string;
  /** False = match not FT yet (or API says not finished). True = FT but combo not fully settled. */
  fixtureFinished: boolean;
  /** Short human summary when fixtureFinished && result still null. */
  pendingReasonSummary?: string;
  legBlockers?: Array<{ label: string; reason: string; legIndex?: number }>;
}

export type BetHistoryDisplayStatus = "settled_win" | "settled_loss" | "pending_fixture" | "pending_resolution";

export interface StoredComboRecord {
  id: string;
  fixtureId: number;
  createdAt: string;
  odds: number;
  legs: StoredComboLeg[];
  totalScore: number;
  normalizedScore: number;
  scoreBreakdown: ComboScoreBreakdown | null;
  result: ComboResult | null;
  resolvedAt: string | null;
  hasTotalScore?: boolean;
  resolutionMeta?: ResolutionAttemptMeta;
}

export interface DisplayStoredComboRecord extends StoredComboRecord {
  displayNormalizedScore: number;
}

export interface ComboResolutionPlayerStat {
  playerId?: number;
  playerName: string;
  shots?: number;
  shotsOnTarget?: number;
  foulsCommitted?: number;
  foulsWon?: number;
  tackles?: number;
}

export interface ComboResolutionInput {
  isFinished: boolean;
  playerStatsById?: Record<number, Omit<ComboResolutionPlayerStat, "playerId" | "playerName">>;
  playerResults: ComboResolutionPlayerStat[];
  /** Optional team-leg result map keyed by exact leg label. */
  teamLegResultsByLabel?: Record<string, boolean>;
  /** From fixture `scores` — enables BTTS and 1X2 team legs when both are finite. */
  homeGoals?: number | null;
  awayGoals?: number | null;
}

export interface BetPerformanceSummary {
  totalBets: number;
  wins: number;
  losses: number;
  winRate: number;
  avgOdds: number;
  avgScore: number;
  avgScoreWin: number;
  avgScoreLoss: number;
  profit: number;
}

export interface OddsBandSummary {
  label: string;
  minOdds: number;
  maxOdds: number | null;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  profit: number;
}

export interface BetHistoryStats extends BetPerformanceSummary {
  finishedBets: number;
  unfinishedBets: number;
  /** Unsettled rows where API reports FT but legs still lack data (e.g. corners). */
  pendingResolutionCombos: number;
  /** Unsettled rows where match is not FT yet (or not reported as FT). */
  pendingFixtureCombos: number;
  roi: number;
  avgOddsWin: number;
  avgOddsLoss: number;
  bestWinningOdds: number | null;
  worstLosingOdds: number | null;
  highestScoreWin: number | null;
  highestScoreLoss: number | null;
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readRecords(): StoredComboRecord[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r) => sanitizeRecord(r))
      .filter((r): r is StoredComboRecord => r != null);
  } catch {
    return [];
  }
}

function writeRecords(records: StoredComboRecord[]): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // ignore storage quota errors in UI flow
  }
}

function toStoredLeg(leg: BuildLeg): StoredComboLeg {
  const smPid = leg.sportmonksPlayerId;
  const mid = leg.marketId;
  return {
    legId: leg.id,
    type: leg.type,
    marketName: leg.marketName,
    marketFamily: leg.marketFamily,
    label: leg.label,
    playerName: leg.playerName,
    sportmonksPlayerId:
      typeof smPid === "number" && Number.isFinite(smPid) && smPid > 0 ? smPid : undefined,
    marketId: typeof mid === "number" && Number.isFinite(mid) && mid > 0 ? mid : undefined,
    bookmakerName: leg.bookmakerName,
    odds: leg.odds,
    line: leg.line,
    outcome: leg.outcome,
  };
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeNum(value: unknown, digits = 4): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(digits);
}

function getLegSignature(leg: StoredComboLeg): string {
  return [
    normalizeText(leg.type),
    normalizeText(leg.marketFamily),
    normalizeText(leg.marketName),
    leg.marketId != null && Number.isFinite(leg.marketId) ? String(leg.marketId) : "",
    normalizeText(leg.playerName ?? ""),
    leg.sportmonksPlayerId != null && Number.isFinite(leg.sportmonksPlayerId) ? String(leg.sportmonksPlayerId) : "",
    normalizeNum(leg.line, 4),
    normalizeText(leg.outcome),
    normalizeText(leg.label),
    normalizeNum(leg.odds ?? 0, 4),
  ].join("|");
}

function getStoredComboSignature(record: Pick<StoredComboRecord, "fixtureId" | "legs">): string {
  const legParts = (record.legs ?? []).map(getLegSignature).sort();
  return `fixture:${record.fixtureId}::legs:${legParts.join("||")}`;
}

function isSameStoredBet(
  a: Pick<StoredComboRecord, "fixtureId" | "legs">,
  b: Pick<StoredComboRecord, "fixtureId" | "legs">
): boolean {
  return getStoredComboSignature(a) === getStoredComboSignature(b);
}

function dedupeUnresolvedExistingRecords(records: StoredComboRecord[]): { records: StoredComboRecord[]; removed: number } {
  const seen = new Set<string>();
  const next: StoredComboRecord[] = [];
  let removed = 0;
  for (const r of records) {
    if (r.result != null) {
      next.push(r);
      continue;
    }
    const sig = getStoredComboSignature(r);
    if (seen.has(sig)) {
      removed += 1;
      continue;
    }
    seen.add(sig);
    next.push(r);
  }
  return { records: next, removed };
}

function sanitizeLeg(value: unknown): StoredComboLeg | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<StoredComboLeg>;
  const type = raw.type === "team" ? "team" : raw.type === "player" ? "player" : null;
  if (!type) return null;
  const marketName = typeof raw.marketName === "string" && raw.marketName.trim() !== "" ? raw.marketName : "Unknown market";
  const marketFamily = typeof raw.marketFamily === "string" && raw.marketFamily.trim() !== "" ? raw.marketFamily : "unknown";
  const label = typeof raw.label === "string" && raw.label.trim() !== "" ? raw.label : marketName;
  const outcome = raw.outcome;
  const validOutcome =
    outcome === "Over" || outcome === "Under" || outcome === "Home" || outcome === "Draw" || outcome === "Away" || outcome === "Yes" || outcome === "No";
  const lineRaw = raw.line;
  let line = 0;
  if (typeof lineRaw === "number" && Number.isFinite(lineRaw)) line = lineRaw;
  else if (typeof lineRaw === "string") {
    const n = parseFloat(lineRaw.replace(",", "."));
    if (Number.isFinite(n)) line = n;
  }
  const outcomeInvalid = !validOutcome;
  const rawSm = (raw as { sportmonksPlayerId?: unknown }).sportmonksPlayerId;
  const sportmonksPlayerId =
    typeof rawSm === "number" && Number.isFinite(rawSm) && rawSm > 0
      ? rawSm
      : typeof rawSm === "string"
        ? (() => {
            const n = parseInt(rawSm, 10);
            return Number.isFinite(n) && n > 0 ? n : undefined;
          })()
        : undefined;
  const rawMid = (raw as { marketId?: unknown }).marketId;
  const marketId =
    typeof rawMid === "number" && Number.isFinite(rawMid) && rawMid > 0
      ? rawMid
      : typeof rawMid === "string"
        ? (() => {
            const n = parseInt(rawMid, 10);
            return Number.isFinite(n) && n > 0 ? n : undefined;
          })()
        : undefined;
  return {
    legId: typeof raw.legId === "string" ? raw.legId : undefined,
    type,
    marketName,
    marketFamily,
    label,
    playerName: typeof raw.playerName === "string" && raw.playerName.trim() !== "" ? raw.playerName : undefined,
    sportmonksPlayerId,
    marketId,
    bookmakerName: typeof raw.bookmakerName === "string" && raw.bookmakerName.trim() !== "" ? raw.bookmakerName : undefined,
    odds: typeof raw.odds === "number" && Number.isFinite(raw.odds) ? raw.odds : undefined,
    line,
    outcome: validOutcome ? outcome : "Over",
    outcomeInvalid: outcomeInvalid ? true : undefined,
  };
}

function sanitizeRecord(value: unknown): StoredComboRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<StoredComboRecord>;
  const rawFid = raw.fixtureId;
  const coerced =
    typeof rawFid === "number" && Number.isFinite(rawFid)
      ? rawFid
      : typeof rawFid === "string"
        ? Number(rawFid)
        : NaN;
  const fixtureId = Number.isFinite(coerced) && coerced > 0 ? coerced : 0;
  if (fixtureId <= 0) return null;
  const legs = Array.isArray(raw.legs) ? raw.legs.map((l) => sanitizeLeg(l)).filter((l): l is StoredComboLeg => l != null) : [];
  const result = raw.result === "win" || raw.result === "loss" ? raw.result : null;
  const hasTotalScore = typeof raw.totalScore === "number" && Number.isFinite(raw.totalScore);
  return {
    id: typeof raw.id === "string" && raw.id !== "" ? raw.id : `${fixtureId}-${Date.now()}`,
    fixtureId,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt !== "" ? raw.createdAt : new Date(0).toISOString(),
    odds: typeof raw.odds === "number" && Number.isFinite(raw.odds) ? raw.odds : 0,
    legs,
    totalScore: hasTotalScore ? (raw.totalScore as number) : 0,
    normalizedScore: typeof raw.normalizedScore === "number" && Number.isFinite(raw.normalizedScore) ? raw.normalizedScore : 50,
    scoreBreakdown: raw.scoreBreakdown ?? null,
    result,
    resolvedAt: typeof raw.resolvedAt === "string" && raw.resolvedAt !== "" ? raw.resolvedAt : null,
    hasTotalScore,
    resolutionMeta: sanitizeResolutionMeta((raw as { resolutionMeta?: unknown }).resolutionMeta),
  };
}

function sanitizeResolutionMeta(raw: unknown): ResolutionAttemptMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const last =
    typeof o.lastResolutionAttemptAt === "string" && o.lastResolutionAttemptAt !== ""
      ? o.lastResolutionAttemptAt
      : undefined;
  if (!last) return undefined;
  const fixtureFinished = o.fixtureFinished === true;
  const summary =
    typeof o.pendingReasonSummary === "string" && o.pendingReasonSummary.trim() !== ""
      ? o.pendingReasonSummary.trim().slice(0, 400)
      : undefined;
  const legBlockers = Array.isArray(o.legBlockers)
    ? (o.legBlockers as unknown[])
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const b = x as { label?: unknown; reason?: unknown; legIndex?: unknown };
          const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 400) : "";
          if (!reason) return null;
          const label = typeof b.label === "string" ? b.label.trim().slice(0, 200) : "";
          const li = b.legIndex;
          const legIndex =
            typeof li === "number" && Number.isFinite(li) && li >= 0 && li < 256 ? Math.floor(li) : undefined;
          return legIndex !== undefined ? { label, reason, legIndex } : { label, reason };
        })
        .filter((x): x is { label: string; reason: string; legIndex?: number } => x != null)
        .slice(0, 16)
    : undefined;
  return {
    lastResolutionAttemptAt: last,
    fixtureFinished,
    pendingReasonSummary: summary,
    legBlockers: legBlockers && legBlockers.length > 0 ? legBlockers : undefined,
  };
}

export function deriveBetHistoryDisplayStatus(r: StoredComboRecord): BetHistoryDisplayStatus {
  if (r.result === "win") return "settled_win";
  if (r.result === "loss") return "settled_loss";
  if (r.resolutionMeta?.fixtureFinished === true) return "pending_resolution";
  return "pending_fixture";
}

function buildLegBlockers(record: StoredComboRecord, input: ComboResolutionInput): Array<{ label: string; reason: string; legIndex: number }> {
  const out: Array<{ label: string; reason: string; legIndex: number }> = [];
  record.legs.forEach((leg, legIndex) => {
    const hit = resolveLegHit(leg, input);
    if (hit !== null) return;
    const d = describeSingleLegForDebug(leg, input);
    out.push({
      legIndex,
      label: (leg.label || leg.marketName || "Leg").slice(0, 160),
      reason: d.reason.slice(0, 400),
    });
  });
  return out;
}

/** Match-level goals O/U only — never treat team-total or ambiguous "goals" labels as match total. */
function isMatchTotalGoalsOuTeamLeg(leg: StoredComboLeg): boolean {
  if (leg.type !== "team") return false;
  if (leg.outcome !== "Over" && leg.outcome !== "Under") return false;
  const mn = (leg.marketName ?? "").toLowerCase();
  if (mn.includes("team total")) return false;
  const fam = (leg.marketFamily ?? "").toLowerCase();
  if (fam === "team:match-goals" || fam === "team:alternative-total-goals") return true;
  const lab = (leg.label ?? "").toLowerCase();
  if (lab.includes("corner") || mn.includes("corner")) return false;
  if (mn.includes("over/under goals") || mn.includes("over under goals") || mn.includes("alternative goals")) return true;
  return false;
}

function isBttsTeamLeg(leg: StoredComboLeg): boolean {
  if (leg.type !== "team") return false;
  const fam = (leg.marketFamily ?? "").toLowerCase();
  if (fam === "team:btts") return true;
  const mn = (leg.marketName ?? "").toLowerCase();
  return mn.includes("both teams to score") || mn.includes("btts") || mn.includes("both teams");
}

function isMatchResultTeamLeg(leg: StoredComboLeg): boolean {
  if (leg.type !== "team") return false;
  const fam = (leg.marketFamily ?? "").toLowerCase();
  if (fam === "team:match-results") return true;
  const mn = (leg.marketName ?? "").toLowerCase();
  return (
    mn.includes("match result") ||
    mn.includes("match results") ||
    mn.includes("full time result") ||
    mn.includes("1x2") ||
    mn.includes("match winner")
  );
}

function hasUsableTotalScore(record: StoredComboRecord): boolean {
  return record.hasTotalScore === true && Number.isFinite(record.totalScore);
}

function getDisplayFallbackScore(record: StoredComboRecord): number {
  if (Number.isFinite(record.normalizedScore)) return record.normalizedScore;
  return 50;
}

function hydrateDisplayScores(records: StoredComboRecord[]): DisplayStoredComboRecord[] {
  const groupMap = new Map<string, StoredComboRecord[]>();
  for (const r of records) {
    const bucket = r.result == null ? "unfinished" : "finished";
    const key = `${r.fixtureId}|${bucket}`;
    const list = groupMap.get(key) ?? [];
    list.push(r);
    groupMap.set(key, list);
  }

  const out: DisplayStoredComboRecord[] = [];
  for (const group of groupMap.values()) {
    const withRaw = group.filter(hasUsableTotalScore);
    const scoreMin = withRaw.length > 0 ? Math.min(...withRaw.map((r) => r.totalScore)) : 0;
    const scoreMax = withRaw.length > 0 ? Math.max(...withRaw.map((r) => r.totalScore)) : 0;
    for (const r of group) {
      const displayNormalizedScore = hasUsableTotalScore(r)
        ? getCompressedNormalizedScore(r.totalScore, scoreMin, scoreMax)
        : getDisplayFallbackScore(r);
      out.push({ ...r, displayNormalizedScore });
    }
  }

  if (import.meta.env.DEV) {
    const changed = out.filter((r) => Number.isFinite(r.normalizedScore) && Math.abs(r.displayNormalizedScore - r.normalizedScore) >= 15).slice(0, 5);
    if (changed.length > 0) {
      console.log(
        "[bet-history score hydration]",
        changed.map((r) => ({
          fixtureId: r.fixtureId,
          totalScore: r.totalScore,
          storedNormalizedScore: r.normalizedScore,
          displayNormalizedScore: r.displayNormalizedScore,
        }))
      );
    }
  }
  return out;
}

function normalizeName(name: string): string {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Match API lineup name to stored leg playerName (exact, then last-name / single-token match). */
function findPlayerRowForLeg(leg: StoredComboLeg, input: ComboResolutionInput): ComboResolutionPlayerStat | null {
  const smPid = leg.sportmonksPlayerId;
  if (typeof smPid === "number" && Number.isFinite(smPid) && smPid > 0) {
    const byId = input.playerResults.find((p) => p.playerId === smPid);
    if (byId) return byId;
  }
  if (!leg.playerName) return null;
  const want = normalizeName(leg.playerName);
  if (!want) return null;
  const list = input.playerResults;
  const exact = list.find((p) => normalizeName(p.playerName) === want);
  if (exact) return exact;
  if (want.length < 3) return null;
  return (
    list.find((p) => {
      const n = normalizeName(p.playerName);
      if (n === want) return true;
      if (!want.includes(" ")) {
        return n.endsWith(" " + want) || n.startsWith(want + " ") || n.split(" ").includes(want);
      }
      return false;
    }) ?? null
  );
}

function getPlayerStatForLeg(leg: StoredComboLeg, input: ComboResolutionInput): number | null {
  if (leg.outcomeInvalid) return null;
  const hasSmId = typeof leg.sportmonksPlayerId === "number" && Number.isFinite(leg.sportmonksPlayerId) && leg.sportmonksPlayerId > 0;
  if (!leg.playerName?.trim() && !hasSmId) return null;
  const player = findPlayerRowForLeg(leg, input);
  const playerById = (() => {
    if (!input.playerStatsById || !player?.playerId || !Number.isFinite(player.playerId)) return null;
    return input.playerStatsById[player.playerId] ?? null;
  })();
  if (!player) return null;
  const cat = inferPlayerPropStatCategoryFromLeg(leg.marketFamily, leg.marketName);
  if (cat == null) return null;
  const pick = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  if (cat === "shotsOnTarget") return pick(playerById?.shotsOnTarget ?? player.shotsOnTarget);
  if (cat === "shots") return pick(playerById?.shots ?? player.shots);
  if (cat === "foulsCommitted") return pick(playerById?.foulsCommitted ?? player.foulsCommitted);
  if (cat === "foulsWon") return pick(playerById?.foulsWon ?? player.foulsWon);
  if (cat === "tackles") return pick(playerById?.tackles ?? player.tackles);
  return null;
}

function resolveTeamLegHit(leg: StoredComboLeg, input: ComboResolutionInput): boolean | null {
  if (leg.outcomeInvalid) return null;
  if (input.teamLegResultsByLabel && Object.prototype.hasOwnProperty.call(input.teamLegResultsByLabel, leg.label)) {
    return Boolean(input.teamLegResultsByLabel[leg.label]);
  }
  const hg = input.homeGoals;
  const ag = input.awayGoals;
  const haveScores =
    typeof hg === "number" && Number.isFinite(hg) && typeof ag === "number" && Number.isFinite(ag);
  if (!haveScores) return null;

  if (leg.outcome === "Yes" || leg.outcome === "No") {
    if (!isBttsTeamLeg(leg)) return null;
    return settleBtts(hg, ag, leg.outcome);
  }
  if (leg.outcome === "Home" || leg.outcome === "Draw" || leg.outcome === "Away") {
    if (!isMatchResultTeamLeg(leg)) return null;
    return settleMatchResult(hg, ag, leg.outcome);
  }
  if (leg.outcome === "Over" || leg.outcome === "Under") {
    if (!isMatchTotalGoalsOuTeamLeg(leg)) return null;
    if (!Number.isFinite(leg.line)) return null;
    const total = hg + ag;
    return settleCountOverUnder(total, leg.line, leg.outcome);
  }
  return null;
}

function resolveLegHit(leg: StoredComboLeg, input: ComboResolutionInput): boolean | null {
  if (leg.outcomeInvalid) return null;
  if (leg.type === "team") {
    return resolveTeamLegHit(leg, input);
  }
  if (leg.outcome === "Over" || leg.outcome === "Under" || leg.outcome === "Yes" || leg.outcome === "No") {
    if (!Number.isFinite(leg.line)) return null;
  }
  const actual = getPlayerStatForLeg(leg, input);
  if (actual == null) return null;
  if (leg.outcome === "Over" || leg.outcome === "Under") {
    return settleCountOverUnder(actual, leg.line, leg.outcome);
  }
  if (leg.outcome === "Yes" || leg.outcome === "No") {
    return settleYesNoAgainstLine(actual, leg.line, leg.outcome);
  }
  return null;
}

export function saveGeneratedCombosForFixture(
  fixtureId: number,
  combos: BuildCombo[],
  topN = 5
): StoredComboRecord[] {
  if (!canUseStorage()) return [];
  const existing = readRecords();
  const cleanup = dedupeUnresolvedExistingRecords(existing);
  const records = cleanup.records;
  const createdAt = new Date().toISOString();
  const attemptedRecords = combos.slice(0, Math.max(1, topN)).map((combo, idx) => ({
    id: `${fixtureId}-${Date.now()}-${idx}`,
    fixtureId,
    createdAt,
    odds: combo.combinedOdds,
    legs: combo.legs.map(toStoredLeg),
    totalScore: combo.comboScore,
    normalizedScore: combo.normalizedScore ?? 50,
    scoreBreakdown: combo.scoreBreakdown ?? null,
    result: null,
    resolvedAt: null,
  }));
  const existingSignatures = new Set(records.map((r) => getStoredComboSignature(r)));
  const inserted: StoredComboRecord[] = [];
  let skippedDuplicates = 0;
  for (const candidate of attemptedRecords) {
    const duplicateExists = records.some((r) => isSameStoredBet(r, candidate));
    if (duplicateExists) {
      skippedDuplicates += 1;
      continue;
    }
    const sig = getStoredComboSignature(candidate);
    if (existingSignatures.has(sig)) {
      skippedDuplicates += 1;
      continue;
    }
    existingSignatures.add(sig);
    inserted.push(candidate);
    records.push(candidate);
  }
  writeRecords(records);
  if (import.meta.env.DEV) {
    console.log("[bet-history save]", {
      attempted: attemptedRecords.length,
      inserted: inserted.length,
      skippedDuplicates,
      cleanedExistingUnresolvedDuplicates: cleanup.removed,
    });
  }
  return inserted;
}

export function resolveComboResult(record: StoredComboRecord, input: ComboResolutionInput): ComboResult | null {
  if (!input.isFinished) return null;
  let anyLoss = false;
  let anyUnknown = false;
  for (const leg of record.legs) {
    const hit = resolveLegHit(leg, input);
    if (hit === false) anyLoss = true;
    else if (hit === null) anyUnknown = true;
  }
  /** Any settled losing leg loses the acca immediately; unknown legs do not imply loss. */
  if (anyLoss) return "loss";
  if (anyUnknown) return null;
  return "win";
}

function describeSingleLegForDebug(leg: StoredComboLeg, input: ComboResolutionInput) {
  const hit = resolveLegHit(leg, input);
  const hg = input.homeGoals;
  const ag = input.awayGoals;
  const totalGoals =
    typeof hg === "number" && Number.isFinite(hg) && typeof ag === "number" && Number.isFinite(ag) ? hg + ag : null;
  let actual: number | null = leg.type === "player" ? getPlayerStatForLeg(leg, input) : null;
  if (leg.type === "team" && isMatchTotalGoalsOuTeamLeg(leg) && totalGoals != null) {
    actual = totalGoals;
  }
  let comparison: string | null = null;
  if (leg.outcomeInvalid) {
    comparison = "(skipped — stored outcome was not a known token)";
  } else if (leg.type === "player" && actual != null && Number.isFinite(leg.line)) {
    if (leg.outcome === "Over" || leg.outcome === "Under" || leg.outcome === "Yes" || leg.outcome === "No") {
      comparison = formatCountComparison(actual, leg.line, leg.outcome);
    }
  } else if (leg.type === "team" && totalGoals != null && hg != null && ag != null) {
    if (isBttsTeamLeg(leg) && (leg.outcome === "Yes" || leg.outcome === "No")) {
      const both = hg >= 1 && ag >= 1;
      comparison = `BTTS home=${hg} away=${ag} bothScored=${both} pick=${leg.outcome}`;
    } else if (isMatchResultTeamLeg(leg) && (leg.outcome === "Home" || leg.outcome === "Draw" || leg.outcome === "Away")) {
      comparison = `1X2 home=${hg} away=${ag} need=${leg.outcome}`;
    } else if (isMatchTotalGoalsOuTeamLeg(leg) && (leg.outcome === "Over" || leg.outcome === "Under") && Number.isFinite(leg.line)) {
      comparison = formatCountComparison(totalGoals, leg.line, leg.outcome);
    }
  }

  let reason: string;
  if (hit == null) {
    if (leg.outcomeInvalid) {
      reason = "stored outcome token was invalid — not settling this leg";
    } else if (leg.type === "team") {
      if (hg == null || ag == null || !Number.isFinite(hg) || !Number.isFinite(ag)) {
        reason = "team: missing homeGoals/awayGoals (need fixture scores) or use teamLegResultsByLabel";
      } else if ((leg.marketFamily ?? "").toLowerCase() === "team:alternative-corners") {
        reason = "team: corners — total corner count not available from fixture resolution API";
      } else if (leg.outcome === "Yes" || leg.outcome === "No") {
        reason = isBttsTeamLeg(leg)
          ? "team: BTTS leg could not be evaluated (unexpected)"
          : "team: Yes/No leg is not a recognized BTTS market (check marketFamily / marketName)";
      } else if (leg.outcome === "Home" || leg.outcome === "Draw" || leg.outcome === "Away") {
        reason = isMatchResultTeamLeg(leg)
          ? "team: match result leg could not be evaluated (unexpected)"
          : "team: Home/Draw/Away not applied — leg is not classified as match result (prefer team:match-results)";
      } else if (leg.outcome === "Over" || leg.outcome === "Under") {
        if (!Number.isFinite(leg.line)) {
          reason = "team: Over/Under leg has non-finite line";
        } else if (!isMatchTotalGoalsOuTeamLeg(leg)) {
          reason =
            "team: Over/Under not match-total goals (e.g. team totals/corners) — no resolver; stays unresolved";
        } else {
          reason = "team: match goals O/U could not be evaluated (unexpected)";
        }
      } else {
        reason = "team: outcome type not supported";
      }
    } else if (!Number.isFinite(leg.line) && (leg.outcome === "Over" || leg.outcome === "Under" || leg.outcome === "Yes" || leg.outcome === "No")) {
      reason = "player: non-finite line — cannot compare";
    } else if (inferPlayerPropStatCategoryFromLeg(leg.marketFamily, leg.marketName) == null) {
      reason = "player: unsupported market category (marketFamily / marketName)";
    } else if (actual == null) {
      const sm = leg.sportmonksPlayerId;
      if (
        leg.type === "player" &&
        typeof sm === "number" &&
        Number.isFinite(sm) &&
        sm > 0 &&
        !input.playerResults.some((p) => p.playerId === sm)
      ) {
        reason = `player: sportmonksPlayerId ${sm} not found in post-match lineup stats`;
      } else {
        reason = "player: no stat row or name mismatch for resolved player";
      }
    } else {
      reason = `player: outcome "${leg.outcome}" has no numeric rule`;
    }
  } else {
    reason = hit ? "hit" : "miss";
  }
  return {
    type: leg.type,
    marketFamily: leg.marketFamily,
    marketName: leg.marketName,
    label: leg.label,
    outcome: leg.outcome,
    line: leg.line,
    playerName: leg.playerName ?? null,
    sportmonksPlayerId: leg.sportmonksPlayerId ?? null,
    homeGoals: leg.type === "team" ? hg : null,
    awayGoals: leg.type === "team" ? ag : null,
    actual,
    comparison,
    hit,
    reason,
  };
}

/** DEV: full trace for one stored combo vs resolution input (Bet History debugging). */
export function describeComboResolutionDebug(record: StoredComboRecord, input: ComboResolutionInput) {
  const legs = record.legs.map((l) => describeSingleLegForDebug(l, input));
  const finalResult = resolveComboResult(record, input);
  return { comboId: record.id, fixtureId: record.fixtureId, legs, finalResult };
}

/** Leg shape required for resolution (compatible with TrackedBetLeg). */
export type ResolutionLeg = Pick<
  StoredComboLeg,
  | "type"
  | "marketName"
  | "marketFamily"
  | "playerName"
  | "line"
  | "outcome"
  | "label"
  | "sportmonksPlayerId"
  | "marketId"
  | "outcomeInvalid"
>;

/** Resolve a bet's legs to win/loss using fixture outcome. Used by bet tracker settlement. */
export function resolveLegsToResult(legs: readonly ResolutionLeg[], input: ComboResolutionInput): ComboResult | null {
  if (!input.isFinished) return null;
  let anyLoss = false;
  let anyUnknown = false;
  for (const leg of legs) {
    const hit = resolveLegHit(leg as StoredComboLeg, input);
    if (hit === false) anyLoss = true;
    else if (hit === null) anyUnknown = true;
  }
  if (anyLoss) return "loss";
  if (anyUnknown) return null;
  return "win";
}

function comboResolutionDevLog(
  kind: "new" | "corrected",
  record: StoredComboRecord,
  input: ComboResolutionInput,
  finalResult: ComboResult,
  previousResult: ComboResult | null
) {
  if (!import.meta.env.DEV) return;
  const legs = record.legs.map((leg) => {
    const d = describeSingleLegForDebug(leg, input);
    const hit = resolveLegHit(leg, input);
    return {
      legId: leg.legId ?? null,
      type: leg.type,
      marketFamily: leg.marketFamily,
      marketName: leg.marketName,
      label: leg.label,
      line: leg.line,
      outcome: leg.outcome,
      playerName: leg.playerName ?? null,
      sportmonksPlayerId: leg.sportmonksPlayerId ?? null,
      actual: d.actual,
      homeGoals: d.homeGoals,
      awayGoals: d.awayGoals,
      hit,
      legResult: hit === null ? "unresolved" : hit ? "won" : "lost",
      reason: d.reason,
    };
  });
  console.log("[bet-history resolve combo]", {
    kind,
    fixtureId: record.fixtureId,
    comboId: record.id,
    createdAt: record.createdAt,
    previousStoredResult: previousResult,
    legs,
    finalResult,
  });
}

export function resolveStoredCombosForFixture(
  fixtureId: number,
  input: ComboResolutionInput
): { resolved: number; unresolved: number; corrected: number } {
  const records = readRecords();
  const now = new Date().toISOString();
  let resolved = 0;
  let unresolved = 0;
  let corrected = 0;

  const updated = records.map((r) => {
    if (r.fixtureId !== fixtureId) return r;

    const previous = r.result;

    if (previous != null) {
      if (!input.isFinished) return r;
      const result = resolveComboResult(r, input);
      if (result == null) return r;
      if (result !== previous) {
        corrected += 1;
        comboResolutionDevLog("corrected", r, input, result, previous);
        return { ...r, result, resolvedAt: now, resolutionMeta: undefined };
      }
      return { ...r, resolutionMeta: undefined };
    }

    if (!input.isFinished) {
      return {
        ...r,
        result: null,
        resolvedAt: null,
        resolutionMeta: {
          lastResolutionAttemptAt: now,
          fixtureFinished: false,
        },
      };
    }

    const result = resolveComboResult(r, input);
    if (result != null) {
      resolved += 1;
      comboResolutionDevLog("new", r, input, result, null);
      return { ...r, result, resolvedAt: now, resolutionMeta: undefined };
    }

    const blockers = buildLegBlockers(r, input);
    const summary =
      blockers.length > 0
        ? blockers.map((b) => b.reason).join(" · ").slice(0, 280)
        : "Finished fixture — settlement incomplete (see leg details).";
    unresolved += 1;
    return {
      ...r,
      result: null,
      resolvedAt: null,
      resolutionMeta: {
        lastResolutionAttemptAt: now,
        fixtureFinished: true,
        pendingReasonSummary: summary,
        legBlockers: blockers.slice(0, 12),
      },
    };
  });

  writeRecords(updated);
  return { resolved, unresolved, corrected };
}

/**
 * Max fixture detail fetches per resolution pass. When there are more unique unfinished fixtures than this,
 * we rotate a cursor so every fixture is visited over successive runs (avoids starving newer matches behind
 * a long-lived block of not-yet-finished fixtures).
 */
const MAX_COMBO_FIXTURES_TO_RESOLVE_PER_RUN = 28;
let comboResolveFixtureCursor = 0;

/** Prioritize FT-but-unsettled combos, then unknown pending, then settled (correction). */
function buildPrioritizedFixtureIds(records: StoredComboRecord[]): number[] {
  const pending = records.filter((r) => r.result == null);
  const settled = records.filter((r) => r.result != null);
  const tier1 = new Map<number, number>();
  const tier2 = new Map<number, number>();
  const tier3 = new Map<number, number>();
  const bump = (m: Map<number, number>, fixtureId: number, ts: number) => {
    const p = m.get(fixtureId);
    if (p === undefined || ts < p) m.set(fixtureId, ts);
  };
  for (const r of pending) {
    const ts = Date.parse(r.createdAt);
    const v = Number.isFinite(ts) ? ts : 0;
    if (r.resolutionMeta?.fixtureFinished === true) bump(tier1, r.fixtureId, v);
    else bump(tier2, r.fixtureId, v);
  }
  for (const r of settled) {
    const ts = Date.parse(r.createdAt);
    const v = Number.isFinite(ts) ? ts : 0;
    bump(tier3, r.fixtureId, v);
  }
  const sortTier = (m: Map<number, number>) =>
    [...m.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  const ordered = [...sortTier(tier1), ...sortTier(tier2), ...sortTier(tier3)];
  const seen = new Set<number>();
  return ordered.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
}

/**
 * Fetches fixture outcomes and persists win/loss via {@link resolveStoredCombosForFixture}.
 * Visits every fixture id that appears in history (unfinished + finished) on a rotating schedule so
 * mis-settled finished rows can be corrected when settlement logic or API data improves.
 */
export async function resolveUnfinishedCombosFromFixtures(): Promise<number> {
  if (typeof window === "undefined") return 0;
  const records = readRecords();
  if (records.length === 0) return 0;

  const pending = records.filter((r) => r.result == null);
  const allUniqueSorted = buildPrioritizedFixtureIds(records);
  const nFixtures = allUniqueSorted.length;
  const take = Math.min(MAX_COMBO_FIXTURES_TO_RESOLVE_PER_RUN, nFixtures);
  const start = nFixtures > take ? comboResolveFixtureCursor % nFixtures : 0;
  const fixtureIds: number[] = [];
  for (let i = 0; i < take; i++) {
    fixtureIds.push(allUniqueSorted[(start + i) % nFixtures]!);
  }
  if (nFixtures > take) {
    comboResolveFixtureCursor = (comboResolveFixtureCursor + take) % nFixtures;
  }

  if (import.meta.env.DEV) {
    console.log("[bet-history combo-resolve] run", {
      totalCombos: records.length,
      pendingCombos: pending.length,
      uniqueFixturesInHistory: nFixtures,
      fetchingThisPass: fixtureIds.length,
      cursorStart: start,
      nextCursor: nFixtures > take ? comboResolveFixtureCursor : "(n/a — all fixtures in one pass)",
      fixtureIdsToFetch: fixtureIds,
    });
  }

  let totalResolved = 0;
  let totalCorrected = 0;
  for (const fixtureId of fixtureIds) {
    const resolutionData = await fetchFixtureResolutionData(fixtureId);
    if (import.meta.env.DEV) {
      const names = resolutionData.playerResults.slice(0, 8).map((p) => p.playerName);
      console.log("[bet-history fixture-resolution-debug]", {
        fixtureId,
        isFinished: resolutionData.isFinished,
        playerResultsCount: resolutionData.playerResults.length,
        homeGoals: resolutionData.homeGoals,
        awayGoals: resolutionData.awayGoals,
        availableTeamResults: { homeGoals: resolutionData.homeGoals, awayGoals: resolutionData.awayGoals },
        samplePlayerLabels: names,
      });
    }

    const input: ComboResolutionInput = {
      isFinished: resolutionData.isFinished,
      playerResults: resolutionData.playerResults,
      playerStatsById: resolutionData.playerStatsById,
      teamLegResultsByLabel: {},
      homeGoals: resolutionData.homeGoals,
      awayGoals: resolutionData.awayGoals,
    };

    if (import.meta.env.DEV) {
      const pendingHere = records.filter((r) => r.fixtureId === fixtureId && r.result == null);
      const debugTarget = Math.min(2, pendingHere.length);
      for (let i = 0; i < debugTarget; i++) {
        const rec = pendingHere[i];
        if (!rec) continue;
        const trace = describeComboResolutionDebug(rec, input);
        const tag = trace.finalResult == null ? "[bet-history combo-null-debug]" : "[bet-history combo-debug]";
        console.log(tag, trace);
      }
    }

    const { resolved, corrected } = resolveStoredCombosForFixture(fixtureId, input);
    totalResolved += resolved;
    totalCorrected += corrected;
    if (import.meta.env.DEV && (resolved > 0 || corrected > 0)) {
      console.log("[bet-history combo-resolve] writeback", { fixtureId, newlyResolved: resolved, corrected });
    }
  }
  return totalResolved + totalCorrected;
}

/**
 * DEV: one console line per stored combo with computed vs stored classification (uses cached fetches per fixture).
 */
export async function devAuditBetHistoryCombos(): Promise<void> {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  const records = readRecords();
  const cache = new Map<number, ComboResolutionInput>();
  for (const r of records) {
    if (!cache.has(r.fixtureId)) {
      const d = await fetchFixtureResolutionData(r.fixtureId);
      cache.set(r.fixtureId, {
        isFinished: d.isFinished,
        playerResults: d.playerResults,
        playerStatsById: d.playerStatsById,
        teamLegResultsByLabel: {},
        homeGoals: d.homeGoals,
        awayGoals: d.awayGoals,
      });
    }
    const input = cache.get(r.fixtureId)!;
    const computed = resolveComboResult(r, input);
    let shouldBe: BetHistoryDisplayStatus;
    if (!input.isFinished) shouldBe = "pending_fixture";
    else if (computed === "win") shouldBe = "settled_win";
    else if (computed === "loss") shouldBe = "settled_loss";
    else shouldBe = "pending_resolution";

    const legs = r.legs.map((leg) => {
      const hit = resolveLegHit(leg, input);
      const dbg = describeSingleLegForDebug(leg, input);
      return {
        label: leg.label,
        marketFamily: leg.marketFamily,
        hit,
        legResult: hit === null ? "unresolved" : hit ? "won" : "lost",
        unresolvedReason: hit === null ? dbg.reason : null,
        actual: dbg.actual,
        comparison: dbg.comparison,
      };
    });

    console.log("[bet-history audit]", {
      fixtureId: r.fixtureId,
      comboId: r.id,
      fixtureFinished: input.isFinished,
      storedResult: r.result,
      computedResult: computed,
      storedDisplayStatus: deriveBetHistoryDisplayStatus(r),
      shouldBe,
      legs,
    });
  }
}

/** Strict per-leg settlement trace for one stored combo (finished audit payload). */
export function describeFinishedComboSettlementAudit(record: StoredComboRecord, input: ComboResolutionInput) {
  const recomputed = resolveComboResult(record, input);
  const legs = record.legs.map((leg) => {
    const hit = resolveLegHit(leg, input);
    const dbg = describeSingleLegForDebug(leg, input);
    return {
      label: leg.label,
      marketId: leg.marketId ?? null,
      marketFamily: leg.marketFamily,
      playerId: leg.sportmonksPlayerId ?? null,
      playerName: leg.playerName ?? null,
      line: leg.line,
      side: leg.outcome,
      actualValueUsed: dbg.actual,
      comparisonPerformed: dbg.comparison,
      resolvedLegResult: hit === null ? null : hit,
      reason: dbg.reason,
    };
  });
  return {
    fixtureId: record.fixtureId,
    comboId: record.id,
    storedResult: record.result,
    recomputedResult: recomputed,
    fixtureFinished: input.isFinished,
    legs,
  };
}

/**
 * DEV: strict audit for settled rows only — full leg actuals, comparison, stored vs recomputed result.
 */
export async function devAuditFinishedBetHistoryCombos(): Promise<void> {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  const records = readRecords().filter((r) => r.result != null);
  const cache = new Map<number, ComboResolutionInput>();
  for (const r of records) {
    if (!cache.has(r.fixtureId)) {
      const d = await fetchFixtureResolutionData(r.fixtureId);
      cache.set(r.fixtureId, {
        isFinished: d.isFinished,
        playerResults: d.playerResults,
        playerStatsById: d.playerStatsById,
        teamLegResultsByLabel: {},
        homeGoals: d.homeGoals,
        awayGoals: d.awayGoals,
      });
    }
    const input = cache.get(r.fixtureId)!;
    console.log("[bet-history finished audit]", describeFinishedComboSettlementAudit(r, input));
  }
}

/**
 * DEV: re-run {@link resolveStoredCombosForFixture} for every fixture id in history (settlements + corrections).
 */
export async function forceRecheckHistorySettlements(): Promise<{
  fixtureCount: number;
  newlyResolved: number;
  corrected: number;
}> {
  if (typeof window === "undefined" || !import.meta.env.DEV) {
    console.warn("[bet-history force-recheck] DEV-only; open Bet History in dev and use from console");
    return { fixtureCount: 0, newlyResolved: 0, corrected: 0 };
  }
  const records = readRecords();
  const ids = [...new Set(records.map((r) => r.fixtureId))].filter((id) => Number.isFinite(id) && id > 0);
  let newlyResolved = 0;
  let corrected = 0;
  for (const fixtureId of ids) {
    const d = await fetchFixtureResolutionData(fixtureId);
    const input: ComboResolutionInput = {
      isFinished: d.isFinished,
      playerResults: d.playerResults,
      playerStatsById: d.playerStatsById,
      teamLegResultsByLabel: {},
      homeGoals: d.homeGoals,
      awayGoals: d.awayGoals,
    };
    const { resolved, corrected: c } = resolveStoredCombosForFixture(fixtureId, input);
    newlyResolved += resolved;
    corrected += c;
  }
  const summary = { fixtureCount: ids.length, newlyResolved, corrected };
  console.log("[bet-history force-recheck] done", summary);
  return summary;
}

/**
 * DEV-only: Force re-resolve stored combo records for a fixture, ignoring existing result/resolvedAt.
 * Clears result fields temporarily, fetches fresh resolution data, then re-runs resolution with fixed logic.
 * Use from browser console: window.forceReResolveComboFixture(19427186)
 */
export async function forceReResolveStoredCombosForFixture(fixtureId: number): Promise<number> {
  if (typeof window === "undefined" || !import.meta.env.DEV) {
    console.warn("[bet-history force-reresolve] DEV-only function; not available in production");
    return 0;
  }
  if (!Number.isFinite(fixtureId) || fixtureId <= 0) {
    console.warn("[bet-history force-reresolve] invalid fixtureId", { fixtureId });
    return 0;
  }

  const records = readRecords();
  const forFixture = records.filter((r) => r.fixtureId === fixtureId);
  if (forFixture.length === 0) {
    console.log("[bet-history force-reresolve] no combos found for fixture", { fixtureId });
    return 0;
  }

  const cleared = records.map((r) => {
    if (r.fixtureId === fixtureId && r.result != null) {
      return { ...r, result: null, resolvedAt: null, resolutionMeta: undefined };
    }
    return r;
  });
  writeRecords(cleared);

  const resolutionData = await fetchFixtureResolutionData(fixtureId);
  if (!resolutionData.isFinished) {
    console.log("[bet-history force-reresolve] fixture not finished", { fixtureId, isFinished: resolutionData.isFinished });
    return 0;
  }

  const input: ComboResolutionInput = {
    isFinished: resolutionData.isFinished,
    playerResults: resolutionData.playerResults,
    playerStatsById: resolutionData.playerStatsById,
    teamLegResultsByLabel: {},
    homeGoals: resolutionData.homeGoals,
    awayGoals: resolutionData.awayGoals,
  };

  const { resolved } = resolveStoredCombosForFixture(fixtureId, input);
  console.log("[bet-history force-reresolve]", {
    fixtureId,
    combosFound: forFixture.length,
    combosReResolved: resolved,
  });
  return resolved;
}

export function listStoredComboRecords(): DisplayStoredComboRecord[] {
  return hydrateDisplayScores(readRecords());
}

export function getAllStoredComboRecords(): DisplayStoredComboRecord[] {
  return hydrateDisplayScores(readRecords()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function getFinishedStoredComboRecords(): DisplayStoredComboRecord[] {
  return hydrateDisplayScores(readRecords())
    .filter((r) => r.result != null)
    .sort((a, b) => {
      const aTs = Date.parse(a.resolvedAt ?? a.createdAt);
      const bTs = Date.parse(b.resolvedAt ?? b.createdAt);
      return bTs - aTs;
    });
}

export function getUnfinishedStoredComboRecords(): DisplayStoredComboRecord[] {
  return hydrateDisplayScores(readRecords())
    .filter((r) => r.result == null)
    .sort((a, b) => {
      const ap = a.resolutionMeta?.fixtureFinished === true ? 0 : 1;
      const bp = b.resolutionMeta?.fixtureFinished === true ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
}

export function getOddsBandBreakdown(stakePerBet = 1): OddsBandSummary[] {
  const finished = readRecords().filter((r) => r.result != null);
  const bands: Array<{ label: string; min: number; max: number | null }> = [
    { label: "1-2", min: 1, max: 2 },
    { label: "2-3", min: 2, max: 3 },
    { label: "3-4", min: 3, max: 4 },
    { label: "4-5", min: 4, max: 5 },
    { label: "5-6", min: 5, max: 6 },
    { label: "6-7", min: 6, max: 7 },
    { label: "7-8", min: 7, max: 8 },
    { label: "8-9", min: 8, max: 9 },
    { label: "9-10", min: 9, max: 10 },
    { label: "10+", min: 10, max: null },
  ];
  return bands.map((band) => {
    const inBand = finished.filter((r) => r.odds >= band.min && (band.max == null ? true : r.odds < band.max));
    const wins = inBand.filter((r) => r.result === "win").length;
    const losses = inBand.filter((r) => r.result === "loss").length;
    const total = inBand.length;
    const profit = inBand.reduce((sum, r) => (r.result === "win" ? sum + (r.odds - 1) * stakePerBet : sum - stakePerBet), 0);
    return {
      label: band.label,
      minOdds: band.min,
      maxOdds: band.max,
      total,
      wins,
      losses,
      winRate: total > 0 ? wins / total : 0,
      profit,
    };
  });
}

export function getBetPerformanceSummary(stakePerBet = 1): BetPerformanceSummary {
  const records = hydrateDisplayScores(readRecords()).filter((r) => r.result != null);
  const totalBets = records.length;
  const wins = records.filter((r) => r.result === "win").length;
  const losses = records.filter((r) => r.result === "loss").length;
  const avgOdds = totalBets > 0 ? records.reduce((s, r) => s + r.odds, 0) / totalBets : 0;
  const avgScore = totalBets > 0 ? records.reduce((s, r) => s + r.displayNormalizedScore, 0) / totalBets : 0;
  const winScores = records.filter((r) => r.result === "win").map((r) => r.displayNormalizedScore);
  const lossScores = records.filter((r) => r.result === "loss").map((r) => r.displayNormalizedScore);
  const avgScoreWin = winScores.length > 0 ? winScores.reduce((a, b) => a + b, 0) / winScores.length : 0;
  const avgScoreLoss = lossScores.length > 0 ? lossScores.reduce((a, b) => a + b, 0) / lossScores.length : 0;
  const profit = records.reduce((sum, r) => {
    if (r.result === "win") return sum + (r.odds - 1) * stakePerBet;
    return sum - stakePerBet;
  }, 0);
  const winRate = totalBets > 0 ? wins / totalBets : 0;
  return { totalBets, wins, losses, winRate, avgOdds, avgScore, avgScoreWin, avgScoreLoss, profit };
}

export function getBetHistoryStats(stakePerBet = 1): BetHistoryStats {
  const all = hydrateDisplayScores(readRecords());
  const finished = all.filter((r) => r.result != null);
  const winsOnly = finished.filter((r) => r.result === "win");
  const lossesOnly = finished.filter((r) => r.result === "loss");
  const base = getBetPerformanceSummary(stakePerBet);
  const finishedBets = finished.length;
  const unfinishedBets = Math.max(0, all.length - finishedBets);
  const unsettled = all.filter((r) => r.result == null);
  const pendingResolutionCombos = unsettled.filter((r) => r.resolutionMeta?.fixtureFinished === true).length;
  const pendingFixtureCombos = unsettled.filter((r) => r.resolutionMeta?.fixtureFinished !== true).length;
  const avgOddsWin = winsOnly.length > 0 ? winsOnly.reduce((s, r) => s + r.odds, 0) / winsOnly.length : 0;
  const avgOddsLoss = lossesOnly.length > 0 ? lossesOnly.reduce((s, r) => s + r.odds, 0) / lossesOnly.length : 0;
  return {
    ...base,
    finishedBets,
    unfinishedBets,
    pendingResolutionCombos,
    pendingFixtureCombos,
    roi: finishedBets > 0 ? base.profit / (finishedBets * stakePerBet) : 0,
    avgOddsWin,
    avgOddsLoss,
    bestWinningOdds: winsOnly.length > 0 ? Math.max(...winsOnly.map((r) => r.odds)) : null,
    worstLosingOdds: lossesOnly.length > 0 ? Math.max(...lossesOnly.map((r) => r.odds)) : null,
    highestScoreWin: winsOnly.length > 0 ? Math.max(...winsOnly.map((r) => r.displayNormalizedScore)) : null,
    highestScoreLoss: lossesOnly.length > 0 ? Math.max(...lossesOnly.map((r) => r.displayNormalizedScore)) : null,
  };
}
