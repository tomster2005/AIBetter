import type { BuildCombo, BuildLeg } from "../lib/valueBetBuilder.js";
import { resolveLegsToResult } from "./comboPerformanceService.js";
import { fetchFixtureResolutionData } from "./comboResolutionDataService.js";

const TRACKED_BETS_STORAGE_KEY = "betTracker:trackedBets:v1";
const UNIT_SIZE_STORAGE_KEY = "bet_tracker_unit_size";
const TRACKED_BETS_BACKUP_KEY = "betTracker_backup";

const DEFAULT_BOOKMAKER_ID = "units";
const DEFAULT_BOOKMAKER_NAME = "Units";

export type TrackedBetStatus = "pending" | "win" | "loss" | "cashed_out";
export type TrackedBetSourceType = "valueBetBuilder" | "manualMulti";

export interface TrackedBetLeg {
  legId?: string;
  type: BuildLeg["type"];
  marketName: string;
  marketFamily: string;
  /** Optional; improves display labels when present (newer tracker rows). */
  marketId?: number;
  label: string;
  playerName?: string;
  matchLabel?: string;
  leagueName?: string;
  kickoffTime?: string;
  line: number;
  outcome: BuildLeg["outcome"];
  odds?: number;
  bookmakerName?: string;
  /** Per-leg notes from Quick Add (optional); kept separate from `label`. */
  legNotes?: string;
}

export interface TrackedBetRecord {
  id: string;
  sourceType: TrackedBetSourceType;
  createdAt: string;
  updatedAt: string;
  bookmakerId?: string;
  bookmakerName?: string;
  stake: number;
  unitSizeAtBet?: number;
  stakeUnits?: number;
  oddsTaken: number;
  returnAmount: number;
  cashOutAmount?: number;
  returnUnits?: number;
  profitUnits?: number;
  status: TrackedBetStatus;
  fixtureId?: number;
  matchLabel: string;
  kickoffTime: string;
  leagueName: string;
  legs: TrackedBetLeg[];
  notes?: string;
  sourceMeta?: {
    modelScore?: number;
    normalizedScore?: number;
  };
}

export interface TrackedBetStats {
  totalBets: number;
  settledBets: number;
  pendingBets: number;
  wins: number;
  losses: number;
  totalProfit: number;
  roi: number;
}

export interface ScoreBandAnalysisRow {
  label: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  profit: number;
}

export interface BankrollTimelinePoint {
  date: string;
  balance: number;
}

let lastSyncTimestamp: number | null = null;
let lastSyncServerCount: number | null = null;
let lastSyncSource: "server" | "local-fallback" | "merged" = "local-fallback";

let trackedBetsCache: TrackedBetRecord[] = [];
let trackedBetsLoaded = false;
let unitSizeCache: number | null = null;

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}


function read<T>(key: string): T[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function write<T>(key: string, value: T[]): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota errors
  }
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function sanitizeTrackedLeg(value: unknown): TrackedBetLeg | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<TrackedBetLeg>;
  const type = raw.type === "player" || raw.type === "team" ? raw.type : null;
  const marketName = normalizeText(raw.marketName) || "Unknown market";
  const marketFamily = normalizeText(raw.marketFamily) || "unknown";
  const label = normalizeText(raw.label) || marketName;
  const outcome = raw.outcome;
  const validOutcome =
    outcome === "Over" || outcome === "Under" || outcome === "Home" || outcome === "Draw" || outcome === "Away" || outcome === "Yes" || outcome === "No";
  if (!type || !validOutcome) return null;
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
    legId: normalizeText(raw.legId) || undefined,
    type,
    marketName,
    marketFamily,
    marketId,
    label,
    playerName: normalizeText(raw.playerName) || undefined,
    matchLabel: normalizeText(raw.matchLabel) || undefined,
    leagueName: normalizeText(raw.leagueName) || undefined,
    kickoffTime: normalizeText(raw.kickoffTime) || undefined,
    line: toNumber(raw.line, 0),
    outcome,
    odds: Number.isFinite(raw.odds as number) ? (raw.odds as number) : undefined,
    bookmakerName: normalizeText(raw.bookmakerName) || undefined,
    legNotes: normalizeText(raw.legNotes) || undefined,
  };
}

function sanitizeTrackedBet(value: unknown): TrackedBetRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<TrackedBetRecord>;
  const status: TrackedBetStatus =
    raw.status === "win" || raw.status === "loss" || raw.status === "cashed_out" ? raw.status : "pending";
  const rawLegs = Array.isArray(raw.legs) ? raw.legs : [];
  const legs = rawLegs.map(sanitizeTrackedLeg).filter((l): l is TrackedBetLeg => l != null);
  const droppedLegCount = rawLegs.length - legs.length;
  const id = normalizeText(raw.id);
  if (!id) return null;
  if (droppedLegCount > 0 && import.meta.env.DEV) {
    console.warn("[bet-tracker sanitize]", {
      message: "Dropped invalid legs during bet load",
      betId: id,
      droppedLegCount,
      originalLegCount: rawLegs.length,
      keptLegCount: legs.length,
    });
  }
  return {
    id,
    sourceType: raw.sourceType === "manualMulti" ? "manualMulti" : "valueBetBuilder",
    createdAt: normalizeText(raw.createdAt) || new Date(0).toISOString(),
    updatedAt: normalizeText(raw.updatedAt) || normalizeText(raw.createdAt) || new Date(0).toISOString(),
    bookmakerId: normalizeText(raw.bookmakerId) || DEFAULT_BOOKMAKER_ID,
    bookmakerName: normalizeText(raw.bookmakerName) || DEFAULT_BOOKMAKER_NAME,
    stake: Math.max(0, toNumber(raw.stake, 0)),
    unitSizeAtBet: Number.isFinite(raw.unitSizeAtBet as number) && toNumber(raw.unitSizeAtBet, 0) > 0 ? toNumber(raw.unitSizeAtBet, 0) : undefined,
    stakeUnits: Number.isFinite(raw.stakeUnits as number) ? Math.max(0, toNumber(raw.stakeUnits, 0)) : undefined,
    oddsTaken: Math.max(0, toNumber(raw.oddsTaken, 0)),
    returnAmount: Math.max(0, toNumber(raw.returnAmount, 0)),
    cashOutAmount:
      Number.isFinite(raw.cashOutAmount as number) && toNumber(raw.cashOutAmount, 0) >= 0
        ? Math.max(0, toNumber(raw.cashOutAmount, 0))
        : undefined,
    returnUnits: Number.isFinite(raw.returnUnits as number) ? Math.max(0, toNumber(raw.returnUnits, 0)) : undefined,
    profitUnits: Number.isFinite(raw.profitUnits as number) ? toNumber(raw.profitUnits, 0) : undefined,
    status,
    /** Coerce string/number from JSON/localStorage; plain `Number.isFinite` fails for string IDs. */
    fixtureId: (() => {
      const fid = toNumber(raw.fixtureId, NaN);
      return Number.isFinite(fid) && fid > 0 ? fid : undefined;
    })(),
    matchLabel: normalizeText(raw.matchLabel) || "Unknown match",
    kickoffTime: normalizeText(raw.kickoffTime) || "-",
    leagueName: normalizeText(raw.leagueName) || "-",
    legs,
    notes: normalizeText(raw.notes) || undefined,
    sourceMeta: raw.sourceMeta && typeof raw.sourceMeta === "object"
      ? {
          modelScore: Number.isFinite((raw.sourceMeta as { modelScore?: number }).modelScore)
            ? (raw.sourceMeta as { modelScore?: number }).modelScore
            : undefined,
          normalizedScore: Number.isFinite((raw.sourceMeta as { normalizedScore?: number }).normalizedScore)
            ? (raw.sourceMeta as { normalizedScore?: number }).normalizedScore
            : undefined,
        }
      : undefined,
  };
}

function repairUnits(record: TrackedBetRecord): TrackedBetRecord {
  const hasUnitSizeAtBet = Number.isFinite(record.unitSizeAtBet as number) && (record.unitSizeAtBet as number) > 0;
  const inferredUnitSize =
    record.stake > 0 && Number.isFinite(record.stakeUnits as number) && (record.stakeUnits as number) > 0
      ? record.stake / (record.stakeUnits as number)
      : undefined;
  const canonicalUnitSize = hasUnitSizeAtBet
    ? (record.unitSizeAtBet as number)
    : inferredUnitSize && Number.isFinite(inferredUnitSize) && inferredUnitSize > 0
      ? inferredUnitSize
      : undefined;

  const stakeUnits =
    Number.isFinite(record.stakeUnits as number) && (record.stakeUnits as number) >= 0
      ? (record.stakeUnits as number)
      : canonicalUnitSize && canonicalUnitSize > 0
        ? record.stake / canonicalUnitSize
        : undefined;
  const returnUnits =
    Number.isFinite(record.returnUnits as number) && (record.returnUnits as number) >= 0
      ? (record.returnUnits as number)
      : canonicalUnitSize && canonicalUnitSize > 0
        ? record.returnAmount / canonicalUnitSize
        : undefined;
  const profitUnits =
    Number.isFinite(record.profitUnits as number)
      ? (record.profitUnits as number)
      : (() => {
          if (record.status === "pending") return 0;
          if (record.status === "loss") return stakeUnits != null ? -stakeUnits : undefined;
          if (record.status === "win" || record.status === "cashed_out") {
            if (returnUnits != null && stakeUnits != null) return returnUnits - stakeUnits;
          }
          return undefined;
        })();

  const next: TrackedBetRecord = {
    ...record,
    unitSizeAtBet: canonicalUnitSize != null && canonicalUnitSize > 0 ? Number(canonicalUnitSize.toFixed(6)) : record.unitSizeAtBet,
    stakeUnits: stakeUnits != null ? Number(stakeUnits.toFixed(4)) : record.stakeUnits,
    returnUnits: returnUnits != null ? Number(returnUnits.toFixed(4)) : record.returnUnits,
    profitUnits: profitUnits != null ? Number(profitUnits.toFixed(4)) : record.profitUnits,
  };

  const repaired =
    next.unitSizeAtBet !== record.unitSizeAtBet ||
    next.stakeUnits !== record.stakeUnits ||
    next.returnUnits !== record.returnUnits ||
    next.profitUnits !== record.profitUnits;
  if (repaired && import.meta.env.DEV) {
    console.warn("[bet-tracker repairUnits] repaired unit values", {
      betId: next.id,
      before: {
        unitSizeAtBet: record.unitSizeAtBet,
        stakeUnits: record.stakeUnits,
        returnUnits: record.returnUnits,
        profitUnits: record.profitUnits,
      },
      after: {
        unitSizeAtBet: next.unitSizeAtBet,
        stakeUnits: next.stakeUnits,
        returnUnits: next.returnUnits,
        profitUnits: next.profitUnits,
      },
      status: next.status,
      stake: next.stake,
      returnAmount: next.returnAmount,
    });
  }
  return next;
}

export function getUnitSize(): number {
  if (unitSizeCache != null && Number.isFinite(unitSizeCache) && unitSizeCache > 0) return unitSizeCache;
  if (!canUseStorage()) return 2;
  try {
    const raw = window.localStorage.getItem(UNIT_SIZE_STORAGE_KEY);
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n) && n > 0) {
      unitSizeCache = n;
      return n;
    }
    return 2;
  } catch {
    return 2;
  }
}

export function setUnitSize(value: number): number {
  const safe = Number.isFinite(value) && value > 0 ? value : 2;
  unitSizeCache = safe;
  if (!canUseStorage()) return safe;
  try {
    window.localStorage.setItem(UNIT_SIZE_STORAGE_KEY, String(safe));
  } catch {
    // ignore
  }
  return safe;
}

function readTrackedBets(): TrackedBetRecord[] {
  let rawSnapshot: string | null = null;
  if (canUseStorage()) {
    try {
      rawSnapshot = window.localStorage.getItem(TRACKED_BETS_STORAGE_KEY);
    } catch {
      rawSnapshot = null;
    }
  }
  const parsed = read<TrackedBetRecord>(TRACKED_BETS_STORAGE_KEY);
  const sanitized = parsed
    .map(sanitizeTrackedBet)
    .filter((b): b is TrackedBetRecord => b != null);
  let repairedAny = false;
  const repaired = sanitized.map((b) => {
    const next = repairUnits(b);
    if (
      next.unitSizeAtBet !== b.unitSizeAtBet ||
      next.stakeUnits !== b.stakeUnits ||
      next.returnUnits !== b.returnUnits ||
      next.profitUnits !== b.profitUnits
    ) {
      repairedAny = true;
    }
    return next;
  });
  if (repairedAny) {
    writeTrackedBets(repaired);
  }
  const sorted = repaired.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (import.meta.env.DEV) {
    console.log("[bet-tracker storage read]", {
      key: TRACKED_BETS_STORAGE_KEY,
      rawPresent: rawSnapshot != null,
      rawLength: rawSnapshot?.length ?? 0,
      parsedCount: parsed.length,
      sanitizedCount: sanitized.length,
      finalCount: sorted.length,
      sample: sorted.slice(0, 2).map((b) => ({
        id: b.id,
        status: b.status,
        bookmakerId: b.bookmakerId,
        matchLabel: b.matchLabel,
        legs: Array.isArray(b.legs) ? b.legs.length : 0,
      })),
    });
  }
  return sorted;
}

function writeTrackedBets(value: TrackedBetRecord[]): void {
  trackedBetsCache = value;
  trackedBetsLoaded = true;
  if (canUseStorage()) {
    try {
      const currentRaw = window.localStorage.getItem(TRACKED_BETS_STORAGE_KEY);
      if (currentRaw) {
        window.localStorage.setItem(TRACKED_BETS_BACKUP_KEY, currentRaw);
      }
    } catch {
      // ignore backup write failures
    }
  }
  write(TRACKED_BETS_STORAGE_KEY, value);
}

function clearTrackedBetsLocal(): void {
  writeTrackedBets([]);
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(TRACKED_BETS_BACKUP_KEY);
  } catch {
    // ignore
  }
}

export function clearTrackedBetsLocalOnly(): void {
  clearTrackedBetsLocal();
}

function sanitizeTrackedBetsList(value: unknown): TrackedBetRecord[] {
  const raw = Array.isArray(value) ? value : [];
  const sanitized = raw.map(sanitizeTrackedBet).filter((b): b is TrackedBetRecord => b != null).map(repairUnits);
  sanitized.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return sanitized;
}

export function replaceTrackedBets(records: unknown): TrackedBetRecord[] {
  const next = sanitizeTrackedBetsList(records);
  writeTrackedBets(next);
  return next;
}

export function restoreTrackedBetsFromBackup(): { restored: boolean; count: number } {
  if (!canUseStorage()) return { restored: false, count: 0 };
  try {
    const raw = window.localStorage.getItem(TRACKED_BETS_BACKUP_KEY);
    if (!raw) return { restored: false, count: 0 };
    const parsed = JSON.parse(raw) as unknown;
    const next = sanitizeTrackedBetsList(parsed);
    if (next.length === 0) return { restored: false, count: 0 };
    write(TRACKED_BETS_STORAGE_KEY, next);
    return { restored: true, count: next.length };
  } catch {
    return { restored: false, count: 0 };
  }
}

export function getTrackedBetsDebugState(): {
  storageCount: number;
  backupExists: boolean;
  backupCount: number;
  serverCount: number | null;
  lastSyncTimestamp: number | null;
  syncSource: "server" | "local-fallback" | "merged";
} {
  const storageCount = trackedBetsLoaded ? trackedBetsCache.length : readTrackedBets().length;
  if (!canUseStorage()) {
    return {
      storageCount,
      backupExists: false,
      backupCount: 0,
      serverCount: lastSyncServerCount,
      lastSyncTimestamp,
      syncSource: lastSyncSource,
    };
  }
  let backupExists = false;
  let backupCount = 0;
  try {
    const raw = window.localStorage.getItem(TRACKED_BETS_BACKUP_KEY);
    backupExists = !!raw;
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      backupCount = sanitizeTrackedBetsList(parsed).length;
    }
  } catch {
    // ignore
  }
  return {
    storageCount,
    backupExists,
    backupCount,
    serverCount: lastSyncServerCount,
    lastSyncTimestamp,
    syncSource: lastSyncSource,
  };
}

const MAX_FIXTURES_TO_SETTLE_PER_RUN = 5;

/**
 * Settles pending tracked bets for a single fixture when it is finished.
 * Updates local storage and persists each settled bet to the shared backend.
 * Returns the number of bets settled.
 */
export async function settleTrackedBetsForFixture(fixtureId: number): Promise<number> {
  if (typeof window === "undefined") return 0;
  if (!Number.isFinite(fixtureId) || fixtureId <= 0) return 0;

  const resolutionData = await fetchFixtureResolutionData(fixtureId);
  if (!resolutionData.isFinished) {
    return 0;
  }
  if (import.meta.env.DEV) {
    console.log("[bet-settlement] fixture state", {
      fixtureId,
      isFinished: resolutionData.isFinished,
      playerResultsCount: resolutionData.playerResults.length,
    });
  }

  const input = {
    isFinished: resolutionData.isFinished,
    playerResults: resolutionData.playerResults,
    playerStatsById: resolutionData.playerStatsById,
    teamLegResultsByLabel: {} as Record<string, boolean>,
  };

  const current = getTrackedBets();
  const pendingForFixture = current.filter(
    (b) => b.fixtureId === fixtureId && b.status === "pending" && b.legs.length > 0
  );
  if (pendingForFixture.length === 0) return 0;

  let settled = 0;
  for (const bet of pendingForFixture) {
    const result = resolveLegsToResult(bet.legs, input);
    if (result == null) {
      if (import.meta.env.DEV) {
        console.log("[bet-settlement] resolution returned null (legs not fully resolvable yet)", {
          fixtureId,
          betId: bet.id,
          legTypes: bet.legs.map((l) => l.type),
          legOutcomes: bet.legs.map((l) => l.outcome),
        });
      }
      continue;
    }

    if (import.meta.env.DEV) {
      console.log("[bet-settlement] fixture finished, updating tracked bet", {
        fixtureId,
        betId: bet.id,
        matchLabel: bet.matchLabel,
        result,
      });
    }
    const updated = await updateTrackedBetStatusShared(bet.id, result);
    if (updated) {
      settled += 1;
      if (import.meta.env.DEV) {
        console.log("[bet-settlement] persisted shared bet", { betId: bet.id, status: result });
      }
    }
  }
  return settled;
}

/**
 * Settles all pending tracked bets whose fixtures are finished.
 * Persists each update to the shared backend.
 * Returns the total number of bets settled.
 */
export async function settlePendingTrackedBets(): Promise<number> {
  if (typeof window === "undefined") return 0;
  const current = getTrackedBets();
  if (import.meta.env.DEV) {
    const pendingNoFixture = current.filter(
      (b) => b.status === "pending" && (b.fixtureId == null || !Number.isFinite(b.fixtureId))
    );
    if (pendingNoFixture.length > 0) {
      console.log("[bet-settlement] pending bets missing numeric fixtureId — auto-settlement skipped for these", {
        count: pendingNoFixture.length,
        sample: pendingNoFixture.slice(0, 5).map((b) => ({ id: b.id, fixtureId: b.fixtureId })),
      });
    }
  }
  const pendingWithFixture = current.filter(
    (b) => b.status === "pending" && b.fixtureId != null && Number.isFinite(b.fixtureId)
  );
  const oldestPendingByFixture = new Map<number, number>();
  for (const b of pendingWithFixture) {
    const fid = b.fixtureId as number;
    const ts = Date.parse(b.createdAt);
    const v = Number.isFinite(ts) ? ts : 0;
    const prev = oldestPendingByFixture.get(fid);
    if (prev === undefined || v < prev) oldestPendingByFixture.set(fid, v);
  }
  const fixtureIds = [...oldestPendingByFixture.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id)
    .slice(0, MAX_FIXTURES_TO_SETTLE_PER_RUN);
  if (fixtureIds.length === 0) return 0;

  if (import.meta.env.DEV && pendingWithFixture.length > 0) {
    console.log("[bet-settlement] checking fixtures for settlement", {
      pendingCount: pendingWithFixture.length,
      fixtureIds,
    });
  }

  let totalSettled = 0;
  for (const fid of fixtureIds) {
    const n = await settleTrackedBetsForFixture(fid);
    totalSettled += n;
  }
  if (import.meta.env.DEV && totalSettled > 0) {
    console.log("[bet-settlement] persisted shared bets", { settledCount: totalSettled });
  }
  return totalSettled;
}

function toTrackedLeg(leg: BuildLeg): TrackedBetLeg {
  const mid = leg.marketId;
  return {
    legId: leg.id,
    type: leg.type,
    marketName: leg.marketName,
    marketFamily: leg.marketFamily,
    marketId: typeof mid === "number" && Number.isFinite(mid) && mid > 0 ? mid : undefined,
    label: leg.label,
    playerName: leg.playerName,
    line: leg.line,
    outcome: leg.outcome,
    odds: leg.odds,
    bookmakerName: leg.bookmakerName,
  };
}

/** Same rules as `toManualTrackedLeg` — used for user-facing save diagnostics. */
export function manualLegRejectReason(
  sel: ManualTrackedSelectionInput
): { field: "matchLabel" | "marketName" | "selectionLabel" | "outcome"; message: string } | null {
  const matchLabel = normalizeText(sel.matchLabel);
  const marketName = normalizeText(sel.marketName);
  const selectionLabel = normalizeText(sel.selectionLabel);
  const outcome = sel.outcome;
  const normalizedOutcome = normalizeText(outcome);
  const validOutcome =
    outcome === "Over" || outcome === "Under" || outcome === "Home" || outcome === "Draw" || outcome === "Away" || outcome === "Yes" || outcome === "No";
  let error: { field: "matchLabel" | "marketName" | "selectionLabel" | "outcome"; message: string } | null = null;
  if (!matchLabel) error = { field: "matchLabel", message: "Match is required." };
  if (!marketName) error = { field: "marketName", message: "Market is required." };
  if (!selectionLabel) error = { field: "selectionLabel", message: "Selection is required." };
  if (!normalizedOutcome || normalizedOutcome.toLowerCase() === "none") error = { field: "outcome", message: "Outcome is required." };
  else if (!validOutcome) error = { field: "outcome", message: "Invalid outcome selected." };
  return error;
}

function toManualTrackedLeg(sel: ManualTrackedSelectionInput, legId: string): TrackedBetLeg | null {
  if (manualLegRejectReason(sel)) return null;
  const matchLabel = normalizeText(sel.matchLabel);
  const marketName = normalizeText(sel.marketName);
  const selectionLabel = normalizeText(sel.selectionLabel);
  const playerName = normalizeText(sel.playerName) || undefined;
  const line = Number.isFinite(sel.line as number) ? (sel.line as number) : 0;
  const outcome = sel.outcome as BuildLeg["outcome"];
  return {
    legId,
    type: "team",
    marketName,
    marketFamily: `manual:${marketName.toLowerCase().replace(/\s+/g, "-")}`,
    label: playerName ? `${selectionLabel} (${playerName})` : selectionLabel,
    playerName,
    matchLabel,
    leagueName: normalizeText(sel.leagueName) || undefined,
    kickoffTime: normalizeText(sel.kickoffTime) || undefined,
    line,
    outcome,
    odds: Number.isFinite(sel.odds as number) ? (sel.odds as number) : undefined,
    legNotes: normalizeText(sel.legNotes) || undefined,
  };
}

function getSettledProfit(record: TrackedBetRecord): number {
  if (record.status === "pending") return 0;
  return getBetProfitUnits(record);
}

function getSettledOutcome(record: TrackedBetRecord): "win" | "loss" | null {
  if (record.status === "win") return "win";
  if (record.status === "loss") return "loss";
  if (record.status === "cashed_out") return record.returnAmount >= record.stake ? "win" : "loss";
  return null;
}

export function getTrackedBets(): TrackedBetRecord[] {
  if (trackedBetsLoaded) return trackedBetsCache;
  return readTrackedBets();
}

export interface AddTrackedBetInput {
  stake: number;
  oddsTaken: number;
  status?: TrackedBetStatus;
  fixtureId?: number;
  matchLabel: string;
  kickoffTime: string;
  leagueName: string;
  combo: BuildCombo;
}

export interface ManualTrackedSelectionInput {
  matchLabel: string;
  leagueName?: string;
  kickoffTime?: string;
  marketName: string;
  selectionLabel: string;
  playerName?: string;
  line?: number;
  outcome?: BuildLeg["outcome"];
  odds?: number;
  /** Per-leg notes; stored on the leg, not appended to `selectionLabel`. */
  legNotes?: string;
}

export type DuplicateCheckLeg = {
  marketName?: string;
  marketFamily?: string;
  playerName?: string;
  line?: number;
  outcome?: BuildLeg["outcome"];
};

export type DuplicateCheckInput = {
  fixtureId?: number;
  matchLabel?: string;
  legs: DuplicateCheckLeg[];
};

export type DuplicateMatch = {
  existingBet: TrackedBetRecord;
  existingLeg: TrackedBetLeg;
  incomingLegIndex: number;
};

function normalizeDupText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeDupLine(value?: number): string | null {
  return Number.isFinite(value as number) ? Number(value).toFixed(2) : null;
}

function isSameFixture(existing: TrackedBetRecord, fixtureId?: number, matchLabel?: string): boolean {
  if (fixtureId != null && Number.isFinite(fixtureId) && existing.fixtureId != null && Number.isFinite(existing.fixtureId)) {
    return existing.fixtureId === fixtureId;
  }
  if (matchLabel) {
    return normalizeDupText(existing.matchLabel) === normalizeDupText(matchLabel);
  }
  return false;
}

function isSameLeg(existing: TrackedBetLeg, incoming: DuplicateCheckLeg): boolean {
  const incomingMarket = normalizeDupText(incoming.marketName || incoming.marketFamily);
  const existingMarket = normalizeDupText(existing.marketName || existing.marketFamily);
  if (incomingMarket && existingMarket && incomingMarket !== existingMarket) return false;

  const incomingLine = normalizeDupLine(incoming.line);
  const existingLine = normalizeDupLine(existing.line);
  if (incomingLine && existingLine && incomingLine !== existingLine) return false;

  if (incoming.playerName) {
    const incomingPlayer = normalizeDupText(incoming.playerName);
    const existingPlayer = normalizeDupText(existing.playerName);
    if (incomingPlayer && existingPlayer && incomingPlayer !== existingPlayer) return false;
  }

  if (incoming.outcome && existing.outcome !== incoming.outcome) return false;
  return true;
}

export function findDuplicateTrackedBet(input: DuplicateCheckInput, existingBets?: TrackedBetRecord[]): DuplicateMatch | null {
  const bets = existingBets ?? getTrackedBets();
  if (!Array.isArray(input.legs) || input.legs.length === 0) return null;
  for (const bet of bets) {
    if (!isSameFixture(bet, input.fixtureId, input.matchLabel)) continue;
    for (let i = 0; i < input.legs.length; i++) {
      const incoming = input.legs[i];
      for (const leg of bet.legs) {
        if (isSameLeg(leg, incoming)) {
          return { existingBet: bet, existingLeg: leg, incomingLegIndex: i };
        }
      }
    }
  }
  return null;
}

export interface AddManualMultiBetInput {
  stake: number;
  oddsTaken: number;
  status?: TrackedBetStatus;
  notes?: string;
  selections: ManualTrackedSelectionInput[];
}

export type ManualMultiBetSaveFailureUI = {
  stake?: string;
  oddsTaken?: string;
  selections?: string;
  /** Map 0-based selection index → inline field errors (caller maps to row ids). */
  selectionRowsByIndex?: Record<number, { matchLabel?: string; marketName?: string; selectionLabel?: string; outcome?: string }>;
};

/**
 * Explains why `addManualMultiBet` would return null, using the same rules as the save path.
 * Call with the same payload you passed to `addManualMultiBet` when it returns null.
 */
export function explainManualMultiBetFailure(input: AddManualMultiBetInput): ManualMultiBetSaveFailureUI {
  const selections = Array.isArray(input.selections) ? input.selections : [];
  const stake = Math.max(0, toNumber(input.stake, 0));
  const oddsTaken = Math.max(0, toNumber(input.oddsTaken, 0));
  if (stake <= 0) return { stake: "Stake must be greater than 0." };
  if (oddsTaken <= 1) return { oddsTaken: "Odds must be greater than 1." };
  if (selections.length === 0) return { selections: "Add at least one selection." };

  const selectionRowsByIndex: Record<number, { matchLabel?: string; marketName?: string; selectionLabel?: string; outcome?: string }> = {};
  for (let i = 0; i < selections.length; i++) {
    const rej = manualLegRejectReason(selections[i]);
    if (rej) {
      selectionRowsByIndex[i] = { [rej.field]: rej.message };
    }
  }
  if (Object.keys(selectionRowsByIndex).length > 0) {
    return {
      selections: "Fix the highlighted selection rows below.",
      selectionRowsByIndex,
    };
  }
  return { selections: "Save failed. Try again or refresh the page." };
}

export function addManualMultiBet(input: AddManualMultiBetInput): TrackedBetRecord | null {
  const stake = Math.max(0, toNumber(input.stake, 0));
  const oddsTaken = Math.max(0, toNumber(input.oddsTaken, 0));
  if (stake <= 0 || oddsTaken <= 1) return null;

  const rawSelections = Array.isArray(input.selections) ? input.selections : [];
  const legIdPrefix = `manual-leg-${Date.now()}`;
  const legs = rawSelections
    .map((sel, index) => toManualTrackedLeg(sel, `${legIdPrefix}-${index + 1}`))
    .filter((leg): leg is TrackedBetLeg => leg != null);
  if (legs.length !== rawSelections.length || legs.length === 0) return null;

  const firstLeg = legs[0];
  const uniqueMatches = Array.from(new Set(legs.map((l) => normalizeText(l.matchLabel)).filter(Boolean)));
  const fixtureCount = uniqueMatches.length;
  const hasManyFixtures = fixtureCount > 1;
  const matchLabel = hasManyFixtures
    ? `Multi (${fixtureCount} fixtures)`
    : uniqueMatches[0] || normalizeText(firstLeg.matchLabel) || `Multi (${legs.length} selections)`;
  const kickoffTime = hasManyFixtures ? "-" : normalizeText(firstLeg.kickoffTime) || "-";
  const leagueName = hasManyFixtures ? "Multiple" : normalizeText(firstLeg.leagueName) || "-";

  const returnAmount = stake * oddsTaken;
  const stakeUnits = stake;
  const returnUnits = returnAmount;
  const status = input.status ?? "pending";
  const profitUnits =
    status === "win" || status === "cashed_out"
      ? returnUnits - stakeUnits
      : status === "loss"
        ? -stakeUnits
        : 0;
  const now = new Date().toISOString();
  const record: TrackedBetRecord = {
    id: `tracked-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    sourceType: "manualMulti",
    createdAt: now,
    updatedAt: now,
    bookmakerId: DEFAULT_BOOKMAKER_ID,
    bookmakerName: DEFAULT_BOOKMAKER_NAME,
    stake,
    unitSizeAtBet: 1,
    stakeUnits: Number(stakeUnits.toFixed(4)),
    oddsTaken,
    returnAmount,
    returnUnits: Number(returnUnits.toFixed(4)),
    profitUnits: Number(profitUnits.toFixed(4)),
    status,
    matchLabel,
    kickoffTime,
    leagueName,
    legs,
    notes: normalizeText(input.notes) || undefined,
  };
  const current = getTrackedBets();
  writeTrackedBets([record, ...current]);

  if (import.meta.env.DEV) {
    console.log("[bet-tracker quick-add]", {
      stake: record.stake,
      oddsTaken: record.oddsTaken,
      selectionCount: record.legs.length,
      status: record.status,
    });
  }
  return record;
}

export async function addManualMultiBetShared(input: AddManualMultiBetInput): Promise<TrackedBetRecord | null> {
  return addManualMultiBet(input);
}

export function addTrackedBet(input: AddTrackedBetInput): TrackedBetRecord | null {
  const stake = Math.max(0, toNumber(input.stake, 0));
  const oddsTaken = Math.max(0, toNumber(input.oddsTaken, 0));
  if (stake <= 0 || oddsTaken <= 1) return null;
  const returnAmount = stake * oddsTaken;
  const stakeUnits = stake;
  const returnUnits = returnAmount;
  const status = input.status ?? "pending";
  const profitUnits =
    status === "win" || status === "cashed_out"
      ? returnUnits - stakeUnits
      : status === "loss"
        ? -stakeUnits
        : 0;
  const now = new Date().toISOString();
  const record: TrackedBetRecord = {
    id: `tracked-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    sourceType: "valueBetBuilder",
    createdAt: now,
    updatedAt: now,
    bookmakerId: DEFAULT_BOOKMAKER_ID,
    bookmakerName: DEFAULT_BOOKMAKER_NAME,
    stake,
    unitSizeAtBet: 1,
    stakeUnits: Number(stakeUnits.toFixed(4)),
    oddsTaken,
    returnAmount,
    returnUnits: Number(returnUnits.toFixed(4)),
    profitUnits: Number(profitUnits.toFixed(4)),
    status,
    fixtureId: input.fixtureId,
    matchLabel: normalizeText(input.matchLabel) || "Unknown match",
    kickoffTime: normalizeText(input.kickoffTime) || "-",
    leagueName: normalizeText(input.leagueName) || "-",
    legs: input.combo.legs.map(toTrackedLeg),
    sourceMeta: {
      modelScore: Number.isFinite(input.combo.comboScore) ? input.combo.comboScore : undefined,
      normalizedScore: Number.isFinite(input.combo.normalizedScore as number) ? (input.combo.normalizedScore as number) : undefined,
    },
  };
  const current = getTrackedBets();
  writeTrackedBets([record, ...current]);
  if (import.meta.env.DEV) {
    console.log("[bet-tracker add]", {
      fixtureId: input.fixtureId ?? null,
      match: record.matchLabel,
      oddsTaken: record.oddsTaken,
      stake: record.stake,
      status: record.status,
    });
  }
  return record;
}

export async function addTrackedBetShared(input: AddTrackedBetInput): Promise<TrackedBetRecord | null> {
  return addTrackedBet(input);
}

export function updateTrackedBetStatus(id: string, status: TrackedBetStatus): TrackedBetRecord | null {
  const current = getTrackedBets();
  let updatedRecord: TrackedBetRecord | null = null;
  const now = new Date().toISOString();
  const next = current.map((r) => {
    if (r.id !== id) return r;
    const stableStakeUnits = getStakeUnits(r);
    const stableReturnUnits = getReturnUnits(r);
    const profitUnits =
      status === "win" || status === "cashed_out"
        ? stableReturnUnits - stableStakeUnits
        : status === "loss"
          ? -stableStakeUnits
          : 0;
    updatedRecord = {
      ...r,
      status,
      updatedAt: now,
      unitSizeAtBet: r.unitSizeAtBet,
      stakeUnits: Number(stableStakeUnits.toFixed(4)),
      returnUnits: Number(stableReturnUnits.toFixed(4)),
      profitUnits: Number(profitUnits.toFixed(4)),
    };
    return updatedRecord;
  });
  writeTrackedBets(next);
  return updatedRecord;
}

export async function updateTrackedBetStatusShared(id: string, status: TrackedBetStatus): Promise<TrackedBetRecord | null> {
  return updateTrackedBetStatus(id, status);
}

export async function updateTrackedBetCashOutShared(id: string, cashOutAmount: number): Promise<TrackedBetRecord | null> {
  const current = getTrackedBets();
  const existing = current.find((r) => r.id === id);
  if (!existing) return null;
  const amount = round2(toNumber(cashOutAmount, NaN));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const now = new Date().toISOString();
  const stableStakeUnits = getStakeUnits(existing);
  const stableReturnUnits = getReturnUnits(existing, amount);
  const profitUnits = stableReturnUnits - stableStakeUnits;

  const updated: TrackedBetRecord = {
    ...existing,
    status: "cashed_out",
    returnAmount: amount,
    cashOutAmount: amount,
    updatedAt: now,
    unitSizeAtBet: existing.unitSizeAtBet,
    stakeUnits: Number(stableStakeUnits.toFixed(4)),
    returnUnits: Number(stableReturnUnits.toFixed(4)),
    profitUnits: Number(profitUnits.toFixed(4)),
  };
  writeTrackedBets(current.map((r) => (r.id === id ? updated : r)));
  return updated;
}

export function deleteTrackedBet(id: string): boolean {
  const current = getTrackedBets();
  const next = current.filter((b) => b.id !== id);
  if (next.length === current.length) return false;
  writeTrackedBets(next);
  return true;
}

export async function deleteTrackedBetShared(id: string): Promise<boolean> {
  const current = getTrackedBets();
  if (!current.some((b) => b.id === id)) return false;
  writeTrackedBets(current.filter((b) => b.id !== id));
  return true;
}

export async function clearAllTrackedBetsShared(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  clearTrackedBetsLocal();
  return true;
}

export function getTrackedBetStats(): TrackedBetStats {
  const bets = getTrackedBets();
  const settled = bets.filter((b) => b.status !== "pending");
  const wins = settled.filter((b) => getSettledOutcome(b) === "win").length;
  const losses = settled.filter((b) => getSettledOutcome(b) === "loss").length;
  const totalProfit = settled.reduce((sum, b) => sum + getSettledProfit(b), 0);
  const totalStakeSettled = settled.reduce((sum, b) => sum + getStakeUnits(b), 0);
  return {
    totalBets: bets.length,
    settledBets: settled.length,
    pendingBets: bets.length - settled.length,
    wins,
    losses,
    totalProfit,
    roi: totalStakeSettled > 0 ? totalProfit / totalStakeSettled : 0,
  };
}

export function getScoreBandAnalysis(): ScoreBandAnalysisRow[] {
  const bands: Array<{ label: string; min: number; max: number }> = [
    { label: "0-40", min: 0, max: 40 },
    { label: "40-60", min: 40, max: 60 },
    { label: "60-70", min: 60, max: 70 },
    { label: "70-80", min: 70, max: 80 },
    { label: "80-90", min: 80, max: 90 },
    { label: "90-100", min: 90, max: 101 }, // include 100 in final band
  ];

  const settled = getTrackedBets().filter((b) => b.status !== "pending");
  const withScore = settled.filter((b) => {
    const s = b.sourceMeta?.normalizedScore;
    return typeof s === "number" && Number.isFinite(s);
  });

  return bands.map((band) => {
    const inBand = withScore.filter((b) => {
      const s = b.sourceMeta?.normalizedScore as number;
      return s >= band.min && s < band.max;
    });
    const wins = inBand.filter((b) => getSettledOutcome(b) === "win").length;
    const losses = inBand.filter((b) => getSettledOutcome(b) === "loss").length;
    const total = inBand.length;
    const profit = inBand.reduce((sum, b) => {
      return sum + getSettledProfit(b);
    }, 0);
    return {
      label: band.label,
      total,
      wins,
      losses,
      winRate: total > 0 ? wins / total : 0,
      profit,
    };
  });
}

function getStakeUnits(record: TrackedBetRecord): number {
  if (Number.isFinite(record.stakeUnits as number)) return record.stakeUnits as number;
  return record.stake;
}

function getReturnUnits(record: TrackedBetRecord, overrideReturn?: number): number {
  if (Number.isFinite(record.returnUnits as number) && overrideReturn == null) return record.returnUnits as number;
  return overrideReturn != null ? overrideReturn : record.returnAmount;
}

function getBetProfitUnits(record: TrackedBetRecord): number {
  if (Number.isFinite(record.profitUnits as number)) return record.profitUnits as number;
  const stakeUnits = getStakeUnits(record);
  if (record.status === "win" || record.status === "cashed_out") {
    const returnUnits = getReturnUnits(record);
    return returnUnits - stakeUnits;
  }
  if (record.status === "loss") return -stakeUnits;
  return 0;
}
