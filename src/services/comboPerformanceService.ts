import type { BuildCombo, BuildLeg, ComboScoreBreakdown } from "../lib/valueBetBuilder.js";
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
  bookmakerName?: string;
  odds?: number;
  line: number;
  outcome: BuildLeg["outcome"];
}

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
  return {
    legId: leg.id,
    type: leg.type,
    marketName: leg.marketName,
    marketFamily: leg.marketFamily,
    label: leg.label,
    playerName: leg.playerName,
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
    normalizeText(leg.playerName ?? ""),
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
  return {
    legId: typeof raw.legId === "string" ? raw.legId : undefined,
    type,
    marketName,
    marketFamily,
    label,
    playerName: typeof raw.playerName === "string" && raw.playerName.trim() !== "" ? raw.playerName : undefined,
    bookmakerName: typeof raw.bookmakerName === "string" && raw.bookmakerName.trim() !== "" ? raw.bookmakerName : undefined,
    odds: typeof raw.odds === "number" && Number.isFinite(raw.odds) ? raw.odds : undefined,
    line,
    outcome: validOutcome ? outcome : "Over",
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
  };
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
  if (!leg.playerName) return null;
  const player = findPlayerRowForLeg(leg, input);
  const playerById = (() => {
    if (!input.playerStatsById || !player?.playerId || !Number.isFinite(player.playerId)) return null;
    return input.playerStatsById[player.playerId] ?? null;
  })();
  if (!player) return null;
  const market = leg.marketName.toLowerCase();
  const isShotsOnTarget =
    /\b(shots?\s+on\s+target|on\s+target\s+shots?|shot\s+on\s+target)\b/i.test(leg.marketName) ||
    market.includes("shots on target");
  if (isShotsOnTarget) {
    const v = playerById?.shotsOnTarget ?? player.shotsOnTarget;
    return typeof v === "number" ? v : null;
  }
  if (market.includes("shots")) {
    const v = playerById?.shots ?? player.shots;
    return typeof v === "number" ? v : null;
  }
  if (market.includes("fouls committed")) {
    const v = playerById?.foulsCommitted ?? player.foulsCommitted;
    return typeof v === "number" ? v : null;
  }
  if (market.includes("fouls won")) {
    const v = playerById?.foulsWon ?? player.foulsWon;
    return typeof v === "number" ? v : null;
  }
  return null;
}

function resolveTeamLegHit(leg: StoredComboLeg, input: ComboResolutionInput): boolean | null {
  const hg = input.homeGoals;
  const ag = input.awayGoals;
  if (typeof hg === "number" && Number.isFinite(hg) && typeof ag === "number" && Number.isFinite(ag)) {
    const fam = (leg.marketFamily ?? "").toLowerCase();
    const mname = leg.marketName.toLowerCase();
    if (fam === "team:btts" || mname.includes("both teams to score") || mname.includes("btts")) {
      const both = hg >= 1 && ag >= 1;
      if (leg.outcome === "Yes") return both;
      if (leg.outcome === "No") return !both;
    }
    if (leg.outcome === "Home") return hg > ag;
    if (leg.outcome === "Away") return ag > hg;
    if (leg.outcome === "Draw") return hg === ag;
  }
  if (input.teamLegResultsByLabel && leg.label in input.teamLegResultsByLabel) {
    return Boolean(input.teamLegResultsByLabel[leg.label]);
  }
  return null;
}

function resolveLegHit(leg: StoredComboLeg, input: ComboResolutionInput): boolean | null {
  if (leg.type === "team") {
    return resolveTeamLegHit(leg, input);
  }
  const actual = getPlayerStatForLeg(leg, input);
  if (actual == null) return null;
  if (leg.outcome === "Over") return actual > leg.line - 1e-9;
  if (leg.outcome === "Under") return actual < leg.line + 1e-9;
  /** Binary player props (e.g. BTTS-style wording) use Yes/No vs line like Over/Under. */
  if (leg.outcome === "Yes") return actual > leg.line - 1e-9;
  if (leg.outcome === "No") return actual < leg.line + 1e-9;
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
  let allKnown = true;
  let allHit = true;
  for (const leg of record.legs) {
    const hit = resolveLegHit(leg, input);
    if (hit == null) {
      allKnown = false;
      break;
    }
    if (!hit) allHit = false;
  }
  if (!allKnown) return null;
  return allHit ? "win" : "loss";
}

function describeSingleLegForDebug(leg: StoredComboLeg, input: ComboResolutionInput) {
  const hit = resolveLegHit(leg, input);
  const actual = leg.type === "player" ? getPlayerStatForLeg(leg, input) : null;
  let reason: string;
  if (hit == null) {
    if (leg.type === "team") {
      const hg = input.homeGoals;
      const ag = input.awayGoals;
      if (hg == null || ag == null || !Number.isFinite(hg) || !Number.isFinite(ag)) {
        reason = "team: missing homeGoals/awayGoals (need fixture scores) or use teamLegResultsByLabel";
      } else {
        reason = "team: market/outcome not handled by goal-based resolver";
      }
    } else if (actual == null) {
      reason = "player: no stat row, name mismatch, or unsupported market for stat";
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
    actual,
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
export type ResolutionLeg = Pick<StoredComboLeg, "type" | "marketName" | "playerName" | "line" | "outcome" | "label">;

/** Resolve a bet's legs to win/loss using fixture outcome. Used by bet tracker settlement. */
export function resolveLegsToResult(legs: readonly ResolutionLeg[], input: ComboResolutionInput): ComboResult | null {
  if (!input.isFinished) return null;
  let allKnown = true;
  let allHit = true;
  for (const leg of legs) {
    const hit = resolveLegHit(leg as StoredComboLeg, input);
    if (hit == null) {
      allKnown = false;
      break;
    }
    if (!hit) allHit = false;
  }
  if (!allKnown) return null;
  return allHit ? "win" : "loss";
}

export function resolveStoredCombosForFixture(
  fixtureId: number,
  input: ComboResolutionInput
): { resolved: number; unresolved: number } {
  const records = readRecords();
  const now = new Date().toISOString();
  let resolved = 0;
  let unresolved = 0;
  const updated = records.map((r) => {
    if (r.fixtureId !== fixtureId || r.result != null) return r;
    const result = resolveComboResult(r, input);
    if (result == null) {
      unresolved += 1;
      return r;
    }
    resolved += 1;
    return { ...r, result, resolvedAt: now };
  });
  writeRecords(updated);
  return { resolved, unresolved };
}

const MAX_COMBO_FIXTURES_TO_RESOLVE_PER_RUN = 8;

/**
 * Fetches fixture outcomes for unfinished combo records and persists win/loss via {@link resolveStoredCombosForFixture}.
 * Call from Bet History (or similar) so combos resolve without opening Odds/Lineup (where useAutoResolveCombos runs).
 */
export async function resolveUnfinishedCombosFromFixtures(): Promise<number> {
  if (typeof window === "undefined") return 0;
  const records = readRecords();
  const pending = records.filter((r) => r.result == null);
  if (pending.length === 0) return 0;

  const oldestByFixture = new Map<number, number>();
  for (const r of pending) {
    const ts = Date.parse(r.createdAt);
    const v = Number.isFinite(ts) ? ts : 0;
    const prev = oldestByFixture.get(r.fixtureId);
    if (prev === undefined || v < prev) oldestByFixture.set(r.fixtureId, v);
  }
  const fixtureIds = [...oldestByFixture.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id)
    .slice(0, MAX_COMBO_FIXTURES_TO_RESOLVE_PER_RUN);

  if (import.meta.env.DEV && pending.length > 0) {
    const sample = pending[0];
    console.log("[bet-history combo-resolve] sample unfinished", {
      comboId: sample.id,
      fixtureId: sample.fixtureId,
      result: sample.result,
      resolvedAt: sample.resolvedAt,
      fixtureIdsToFetch: fixtureIds,
    });
  }

  let totalResolved = 0;
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
    if (!resolutionData.isFinished) continue;

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
      const debugTarget = fixtureId === 19427186 ? pendingHere.length : Math.min(3, pendingHere.length);
      for (let i = 0; i < debugTarget; i++) {
        const rec = pendingHere[i];
        if (!rec) continue;
        const trace = describeComboResolutionDebug(rec, input);
        const tag = trace.finalResult == null ? "[bet-history combo-null-debug]" : "[bet-history combo-debug]";
        console.log(tag, trace);
      }
    }

    const { resolved } = resolveStoredCombosForFixture(fixtureId, input);
    totalResolved += resolved;
    if (import.meta.env.DEV && resolved > 0) {
      console.log("[bet-history combo-resolve] writeback", { fixtureId, resolvedCombos: resolved });
    }
  }
  return totalResolved;
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
      return { ...r, result: null, resolvedAt: null };
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
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
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
  const avgOddsWin = winsOnly.length > 0 ? winsOnly.reduce((s, r) => s + r.odds, 0) / winsOnly.length : 0;
  const avgOddsLoss = lossesOnly.length > 0 ? lossesOnly.reduce((s, r) => s + r.odds, 0) / lossesOnly.length : 0;
  return {
    ...base,
    finishedBets,
    unfinishedBets,
    roi: finishedBets > 0 ? base.profit / (finishedBets * stakePerBet) : 0,
    avgOddsWin,
    avgOddsLoss,
    bestWinningOdds: winsOnly.length > 0 ? Math.max(...winsOnly.map((r) => r.odds)) : null,
    worstLosingOdds: lossesOnly.length > 0 ? Math.max(...lossesOnly.map((r) => r.odds)) : null,
    highestScoreWin: winsOnly.length > 0 ? Math.max(...winsOnly.map((r) => r.displayNormalizedScore)) : null,
    highestScoreLoss: lossesOnly.length > 0 ? Math.max(...lossesOnly.map((r) => r.displayNormalizedScore)) : null,
  };
}
