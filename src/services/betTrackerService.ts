import type { BuildCombo, BuildLeg } from "../lib/valueBetBuilder.js";
import { resolveLegsToResult } from "./comboPerformanceService.js";
import { fetchFixtureResolutionData } from "./comboResolutionDataService.js";

const BOOKMAKERS_STORAGE_KEY = "betTracker:bookmakers:v1";
const TRACKED_BETS_STORAGE_KEY = "betTracker:trackedBets:v1";
const BALANCE_ADJUSTMENTS_STORAGE_KEY = "betTracker:balanceAdjustments:v1";
const UNIT_SIZE_STORAGE_KEY = "bet_tracker_unit_size";
const SHARED_BETS_API_PATH = "/api/bets";

/** Shared bets API: same origin when UI is served by Express (`dist/`); local API in dev. */
const API_BASE = import.meta.env.PROD ? "" : "http://localhost:3001";

export type TrackedBetStatus = "pending" | "win" | "loss";
export type TrackedBetSourceType = "valueBetBuilder" | "manualMulti";

export type BalanceAdjustmentType = "deposit" | "withdrawal" | "correction";

export interface BalanceAdjustment {
  id: string;
  bookmakerId: string;
  amount: number;
  type: BalanceAdjustmentType;
  note?: string;
  /** epoch ms */
  createdAt: number;
}

export interface TrackedBookmaker {
  id: string;
  name: string;
  startingBalance: number;
  createdAt: string;
}

export interface TrackedBetLeg {
  legId?: string;
  type: BuildLeg["type"];
  marketName: string;
  marketFamily: string;
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
  bookmakerId: string;
  bookmakerName: string;
  stake: number;
  unitSizeAtBet?: number;
  stakeUnits?: number;
  oddsTaken: number;
  returnAmount: number;
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

export interface BookmakerStats {
  bookmakerId: string;
  bookmakerName: string;
  startingBalance: number;
  currentBalance: number;
  availableBalance: number;
  realizedProfit: number;
  totalUnitsProfit: number;
  potentialProfit: number;
  potentialBalance: number;
  pendingStake: number;
  betCount: number;
  settledCount: number;
  pendingCount: number;
  roi: number;
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

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function getSharedBetsApiUrl(): string {
  return `${API_BASE}${SHARED_BETS_API_PATH}`;
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

function sanitizeBookmaker(value: unknown): TrackedBookmaker | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<TrackedBookmaker>;
  const id = normalizeText(raw.id);
  const name = normalizeText(raw.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    startingBalance: toNumber(raw.startingBalance, 0),
    createdAt: normalizeText(raw.createdAt) || new Date(0).toISOString(),
  };
}

function sanitizeBalanceAdjustment(value: unknown): BalanceAdjustment | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<BalanceAdjustment>;
  const id = normalizeText(raw.id);
  const bookmakerId = normalizeText(raw.bookmakerId);
  const type = raw.type;
  const validType = type === "deposit" || type === "withdrawal" || type === "correction";
  const note = normalizeText(raw.note);
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.parse(String((raw as any).createdAt)) || Date.now();
  const amount = round2(toNumber(raw.amount, 0));
  if (!id || !bookmakerId || !validType) return null;
  if (!Number.isFinite(amount) || Number.isNaN(amount)) return null;
  return {
    id,
    bookmakerId,
    amount,
    type,
    note: note ? note : undefined,
    createdAt,
  };
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
  return {
    legId: normalizeText(raw.legId) || undefined,
    type,
    marketName,
    marketFamily,
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
  const status: TrackedBetStatus = raw.status === "win" || raw.status === "loss" ? raw.status : "pending";
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
    bookmakerId: normalizeText(raw.bookmakerId),
    bookmakerName: normalizeText(raw.bookmakerName) || "Unknown bookmaker",
    stake: Math.max(0, toNumber(raw.stake, 0)),
    unitSizeAtBet: Number.isFinite(raw.unitSizeAtBet as number) && toNumber(raw.unitSizeAtBet, 0) > 0 ? toNumber(raw.unitSizeAtBet, 0) : undefined,
    stakeUnits: Number.isFinite(raw.stakeUnits as number) ? Math.max(0, toNumber(raw.stakeUnits, 0)) : undefined,
    oddsTaken: Math.max(0, toNumber(raw.oddsTaken, 0)),
    returnAmount: Math.max(0, toNumber(raw.returnAmount, 0)),
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
          if (record.status === "win") {
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
  if (!canUseStorage()) return 2;
  try {
    const raw = window.localStorage.getItem(UNIT_SIZE_STORAGE_KEY);
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    return 2;
  } catch {
    return 2;
  }
}

export function setUnitSize(value: number): number {
  const safe = Number.isFinite(value) && value > 0 ? value : 2;
  if (!canUseStorage()) return safe;
  try {
    window.localStorage.setItem(UNIT_SIZE_STORAGE_KEY, String(safe));
  } catch {
    // ignore
  }
  return safe;
}

function readBookmakers(): TrackedBookmaker[] {
  return read<TrackedBookmaker>(BOOKMAKERS_STORAGE_KEY)
    .map(sanitizeBookmaker)
    .filter((b): b is TrackedBookmaker => b != null);
}

function writeBookmakers(value: TrackedBookmaker[]): void {
  write(BOOKMAKERS_STORAGE_KEY, value);
}

function readBalanceAdjustments(): BalanceAdjustment[] {
  return read<BalanceAdjustment>(BALANCE_ADJUSTMENTS_STORAGE_KEY)
    .map(sanitizeBalanceAdjustment)
    .filter((a): a is BalanceAdjustment => a != null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function writeBalanceAdjustments(value: BalanceAdjustment[]): void {
  write(BALANCE_ADJUSTMENTS_STORAGE_KEY, value);
}

export function getBalanceAdjustments(): BalanceAdjustment[] {
  return readBalanceAdjustments();
}

export function getBalanceAdjustmentsForBookmaker(bookmakerId: string): BalanceAdjustment[] {
  return readBalanceAdjustments().filter((a) => a.bookmakerId === bookmakerId);
}

export function adjustBalance(
  bookmakerId: string,
  input: { amount: number; type: BalanceAdjustmentType; note?: string }
): BalanceAdjustment | null {
  const bookmakers = readBookmakers();
  const bookmaker = bookmakers.find((b) => b.id === bookmakerId);
  if (!bookmaker) return null;

  const rawAmount = toNumber(input.amount, 0);
  if (!Number.isFinite(rawAmount)) return null;

  let normalized: number;
  if (input.type === "deposit") normalized = Math.abs(rawAmount);
  else if (input.type === "withdrawal") normalized = -Math.abs(rawAmount);
  else normalized = rawAmount;

  normalized = round2(normalized);
  if (!Number.isFinite(normalized) || normalized === 0) return null;

  const note = normalizeText(input.note);
  const now = Date.now();
  const adj: BalanceAdjustment = {
    id: `adj-${now}-${Math.random().toString(36).slice(2, 9)}`,
    bookmakerId,
    amount: normalized,
    type: input.type,
    note: note ? note : undefined,
    createdAt: now,
  };

  const current = readBalanceAdjustments();
  writeBalanceAdjustments([adj, ...current]);
  return adj;
}

function readTrackedBets(): TrackedBetRecord[] {
  const sanitized = read<TrackedBetRecord>(TRACKED_BETS_STORAGE_KEY)
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
  return repaired.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function writeTrackedBets(value: TrackedBetRecord[]): void {
  write(TRACKED_BETS_STORAGE_KEY, value);
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

async function postSharedBet(record: TrackedBetRecord): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    await fetch(getSharedBetsApiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
  } catch {
    // best-effort sync only
  }
}

async function putSharedBet(record: TrackedBetRecord): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    await fetch(`${getSharedBetsApiUrl()}/${encodeURIComponent(record.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
  } catch {
    // best-effort sync only
  }
}

async function deleteSharedBetById(id: string): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    await fetch(`${getSharedBetsApiUrl()}/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  } catch {
    // best-effort sync only
  }
}

export async function refreshTrackedBetsFromServer(): Promise<TrackedBetRecord[] | null> {
  if (typeof window === "undefined") return null;
  try {
    const res = await fetch(getSharedBetsApiUrl());
    if (!res.ok) return null;
    const json = await res.json();
    return replaceTrackedBets(json);
  } catch {
    return null;
  }
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

  const current = readTrackedBets();
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
    const updated = updateTrackedBetStatus(bet.id, result);
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
  const current = readTrackedBets();
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
  return {
    legId: leg.id,
    type: leg.type,
    marketName: leg.marketName,
    marketFamily: leg.marketFamily,
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
  if (record.status === "win") return record.returnAmount - record.stake;
  if (record.status === "loss") return -record.stake;
  return 0;
}

export function getBookmakers(): TrackedBookmaker[] {
  return readBookmakers();
}

export function addBookmaker(name: string, startingBalance: number): TrackedBookmaker | null {
  const cleanName = normalizeText(name);
  if (!cleanName) return null;
  const balance = Math.max(0, toNumber(startingBalance, 0));
  const existing = readBookmakers();
  if (existing.some((b) => b.name.toLowerCase() === cleanName.toLowerCase())) return null;
  const next: TrackedBookmaker = {
    id: `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: cleanName,
    startingBalance: balance,
    createdAt: new Date().toISOString(),
  };
  writeBookmakers([...existing, next]);
  return next;
}

export function getTrackedBets(): TrackedBetRecord[] {
  return readTrackedBets();
}

export interface AddTrackedBetInput {
  bookmakerId: string;
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

export interface AddManualMultiBetInput {
  bookmakerId: string;
  stake: number;
  oddsTaken: number;
  status?: TrackedBetStatus;
  notes?: string;
  selections: ManualTrackedSelectionInput[];
}

export type ManualMultiBetSaveFailureUI = {
  bookmakerId?: string;
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
  const bookmakers = readBookmakers();
  const bookmaker = bookmakers.find((b) => b.id === input.bookmakerId);
  if (!bookmaker) {
    return { bookmakerId: "That bookmaker was not found. Refresh the page and select a bookmaker again." };
  }
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
  const bookmakers = readBookmakers();
  const bookmaker = bookmakers.find((b) => b.id === input.bookmakerId);
  if (!bookmaker) return null;

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
  const unitSize = getUnitSize();
  const stakeUnits = unitSize > 0 ? stake / unitSize : 0;
  const returnUnits = unitSize > 0 ? returnAmount / unitSize : 0;
  const status = input.status ?? "pending";
  const profitUnits =
    status === "win"
      ? (returnAmount - stake) / unitSize
      : status === "loss"
        ? (-stake) / unitSize
        : 0;
  const now = new Date().toISOString();
  const record: TrackedBetRecord = {
    id: `tracked-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    sourceType: "manualMulti",
    createdAt: now,
    updatedAt: now,
    bookmakerId: bookmaker.id,
    bookmakerName: bookmaker.name,
    stake,
    unitSizeAtBet: Number(unitSize.toFixed(6)),
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
  const current = readTrackedBets();
  writeTrackedBets([record, ...current]);
  void postSharedBet(record);

  if (import.meta.env.DEV) {
    console.log("[bet-tracker quick-add]", {
      bookmaker: bookmaker.name,
      stake: record.stake,
      oddsTaken: record.oddsTaken,
      selectionCount: record.legs.length,
      status: record.status,
    });
  }
  return record;
}

export function addTrackedBet(input: AddTrackedBetInput): TrackedBetRecord | null {
  const bookmakers = readBookmakers();
  const bookmaker = bookmakers.find((b) => b.id === input.bookmakerId);
  if (!bookmaker) return null;
  const stake = Math.max(0, toNumber(input.stake, 0));
  const oddsTaken = Math.max(0, toNumber(input.oddsTaken, 0));
  if (stake <= 0 || oddsTaken <= 1) return null;
  const returnAmount = stake * oddsTaken;
  const unitSize = getUnitSize();
  const stakeUnits = unitSize > 0 ? stake / unitSize : 0;
  const returnUnits = unitSize > 0 ? returnAmount / unitSize : 0;
  const status = input.status ?? "pending";
  const profitUnits =
    status === "win"
      ? (returnAmount - stake) / unitSize
      : status === "loss"
        ? (-stake) / unitSize
        : 0;
  const now = new Date().toISOString();
  const record: TrackedBetRecord = {
    id: `tracked-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    sourceType: "valueBetBuilder",
    createdAt: now,
    updatedAt: now,
    bookmakerId: bookmaker.id,
    bookmakerName: bookmaker.name,
    stake,
    unitSizeAtBet: Number(unitSize.toFixed(6)),
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
  const current = readTrackedBets();
  writeTrackedBets([record, ...current]);
  void postSharedBet(record);
  if (import.meta.env.DEV) {
    console.log("[bet-tracker add]", {
      bookmaker: bookmaker.name,
      fixtureId: input.fixtureId ?? null,
      match: record.matchLabel,
      oddsTaken: record.oddsTaken,
      stake: record.stake,
      status: record.status,
    });
  }
  return record;
}

export function updateTrackedBetStatus(id: string, status: TrackedBetStatus): TrackedBetRecord | null {
  const current = readTrackedBets();
  let updatedRecord: TrackedBetRecord | null = null;
  const now = new Date().toISOString();
  const next = current.map((r) => {
    if (r.id !== id) return r;
    const hasUnitSizeAtBet = Number.isFinite(r.unitSizeAtBet as number) && (r.unitSizeAtBet as number) > 0;
    const inferredUnitSize =
      r.stake > 0 && Number.isFinite(r.stakeUnits as number) && (r.stakeUnits as number) > 0
        ? r.stake / (r.stakeUnits as number)
        : undefined;
    const canonicalUnitSize = hasUnitSizeAtBet
      ? (r.unitSizeAtBet as number)
      : inferredUnitSize && Number.isFinite(inferredUnitSize) && inferredUnitSize > 0
        ? inferredUnitSize
        : undefined;
    const stableStakeUnits =
      canonicalUnitSize && canonicalUnitSize > 0
        ? r.stake / canonicalUnitSize
        : Number.isFinite(r.stakeUnits as number)
          ? (r.stakeUnits as number)
          : 0;
    const stableReturnUnits =
      canonicalUnitSize && canonicalUnitSize > 0
        ? r.returnAmount / canonicalUnitSize
        : Number.isFinite(r.returnUnits as number)
          ? (r.returnUnits as number)
          : 0;
    const profitUnits =
      status === "win"
        ? stableReturnUnits - stableStakeUnits
        : status === "loss"
          ? -stableStakeUnits
          : 0;
    updatedRecord = {
      ...r,
      status,
      updatedAt: now,
      unitSizeAtBet: canonicalUnitSize != null && canonicalUnitSize > 0 ? Number(canonicalUnitSize.toFixed(6)) : r.unitSizeAtBet,
      stakeUnits: Number(stableStakeUnits.toFixed(4)),
      returnUnits: Number(stableReturnUnits.toFixed(4)),
      profitUnits: Number(profitUnits.toFixed(4)),
    };
    return updatedRecord;
  });
  writeTrackedBets(next);
  if (updatedRecord) void putSharedBet(updatedRecord);
  return updatedRecord;
}

export function deleteTrackedBet(id: string): boolean {
  const current = readTrackedBets();
  const next = current.filter((b) => b.id !== id);
  if (next.length === current.length) return false;
  writeTrackedBets(next);
  void deleteSharedBetById(id);
  return true;
}

export function getTrackedBetsByBookmaker(bookmakerId: string): TrackedBetRecord[] {
  return readTrackedBets().filter((b) => b.bookmakerId === bookmakerId);
}

export function getBookmakerStats(bookmakerId: string): BookmakerStats | null {
  const bookmaker = readBookmakers().find((b) => b.id === bookmakerId);
  if (!bookmaker) return null;
  const bets = getTrackedBetsByBookmaker(bookmakerId);
  const settled = bets.filter((b) => b.status !== "pending");
  const pending = bets.filter((b) => b.status === "pending");
  const realizedProfit = settled.reduce((sum, b) => sum + getSettledProfit(b), 0);
  const totalUnitsProfit = settled.reduce((sum, b) => sum + (Number.isFinite(b.profitUnits as number) ? (b.profitUnits as number) : 0), 0);
  const potentialProfit = pending.reduce((sum, b) => sum + (b.returnAmount - b.stake), 0);
  const pendingStake = pending.reduce((sum, b) => sum + b.stake, 0);
  const settledStake = settled.reduce((sum, b) => sum + b.stake, 0);
  const adjustmentsSum = getBalanceAdjustmentsForBookmaker(bookmakerId).reduce((sum, a) => sum + (Number.isFinite(a.amount) ? a.amount : 0), 0);
  const currentBalance = bookmaker.startingBalance + realizedProfit + adjustmentsSum;
  const availableBalance = currentBalance - pendingStake;
  const potentialBalance = currentBalance + potentialProfit;
  return {
    bookmakerId: bookmaker.id,
    bookmakerName: bookmaker.name,
    startingBalance: bookmaker.startingBalance,
    currentBalance,
    availableBalance,
    realizedProfit,
    totalUnitsProfit,
    potentialProfit,
    potentialBalance,
    pendingStake,
    betCount: bets.length,
    settledCount: settled.length,
    pendingCount: bets.length - settled.length,
    roi: settledStake > 0 ? realizedProfit / settledStake : 0,
  };
}

export function getAllBookmakerStats(): BookmakerStats[] {
  return readBookmakers()
    .map((b) => getBookmakerStats(b.id))
    .filter((s): s is BookmakerStats => s != null)
    .sort((a, b) => b.currentBalance - a.currentBalance);
}

export function getTrackedBetStats(): TrackedBetStats {
  const bets = readTrackedBets();
  const settled = bets.filter((b) => b.status !== "pending");
  const wins = settled.filter((b) => b.status === "win").length;
  const losses = settled.filter((b) => b.status === "loss").length;
  const totalProfit = settled.reduce((sum, b) => sum + getSettledProfit(b), 0);
  const totalStakeSettled = settled.reduce((sum, b) => sum + b.stake, 0);
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

export function getBankrollTimeline(bookmakerId?: string): BankrollTimelinePoint[] {
  const bookmakers = readBookmakers();
  const tracked = readTrackedBets();

  const bookmakerFilter = bookmakerId && bookmakerId.trim() !== "" ? bookmakerId : null;
  const relevantBookmakers = bookmakerFilter ? bookmakers.filter((b) => b.id === bookmakerFilter) : bookmakers;
  const startingBalance = relevantBookmakers.reduce((sum, b) => sum + b.startingBalance, 0);
  const settled = tracked
    .filter((b) => b.status !== "pending")
    .filter((b) => (bookmakerFilter ? b.bookmakerId === bookmakerFilter : true))
    .sort((a, b) => Date.parse(a.updatedAt || a.createdAt) - Date.parse(b.updatedAt || b.createdAt));

  const adjustments = getBalanceAdjustments()
    .filter((a) => (bookmakerFilter ? a.bookmakerId === bookmakerFilter : true))
    .sort((a, b) => a.createdAt - b.createdAt);

  type Event =
    | { kind: "bet"; date: number; delta: number; label: string }
    | { kind: "adjustment"; date: number; delta: number; label: string };

  const events: Event[] = [];
  for (const bet of settled) {
    const d = Date.parse(bet.updatedAt || bet.createdAt);
    const delta =
      bet.status === "win" ? bet.returnAmount - bet.stake : bet.status === "loss" ? -bet.stake : 0;
    events.push({ kind: "bet", date: d, delta, label: bet.updatedAt || bet.createdAt });
  }
  for (const a of adjustments) {
    events.push({ kind: "adjustment", date: a.createdAt, delta: a.amount, label: new Date(a.createdAt).toISOString() });
  }
  events.sort((a, b) => a.date - b.date);

  const points: BankrollTimelinePoint[] = [];
  let balance = startingBalance;
  points.push({ date: "Start", balance });
  for (const e of events) {
    if (!Number.isFinite(e.delta)) continue;
    balance += e.delta;
    points.push({
      date: e.label,
      balance,
    });
  }
  return points;
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

  const settled = readTrackedBets().filter((b) => b.status !== "pending");
  const withScore = settled.filter((b) => {
    const s = b.sourceMeta?.normalizedScore;
    return typeof s === "number" && Number.isFinite(s);
  });

  return bands.map((band) => {
    const inBand = withScore.filter((b) => {
      const s = b.sourceMeta?.normalizedScore as number;
      return s >= band.min && s < band.max;
    });
    const wins = inBand.filter((b) => b.status === "win").length;
    const losses = inBand.filter((b) => b.status === "loss").length;
    const total = inBand.length;
    const profit = inBand.reduce((sum, b) => {
      if (b.status === "win") return sum + (b.returnAmount - b.stake);
      if (b.status === "loss") return sum - b.stake;
      return sum;
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
