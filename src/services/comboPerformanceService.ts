import type { BuildCombo, BuildLeg, ComboScoreBreakdown } from "../lib/valueBetBuilder.js";
import { getCompressedNormalizedScore } from "../lib/modelScoreNormalization.js";

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
  const line = typeof raw.line === "number" && Number.isFinite(raw.line) ? raw.line : 0;
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
  const fixtureId = typeof raw.fixtureId === "number" && Number.isFinite(raw.fixtureId) ? raw.fixtureId : 0;
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

function getPlayerStatForLeg(leg: StoredComboLeg, input: ComboResolutionInput): number | null {
  if (!leg.playerName) return null;
  const player = input.playerResults.find((p) => normalizeName(p.playerName) === normalizeName(leg.playerName));
  const playerById = (() => {
    if (!input.playerStatsById || !player?.playerId || !Number.isFinite(player.playerId)) return null;
    return input.playerStatsById[player.playerId] ?? null;
  })();
  if (!player) return null;
  const market = leg.marketName.toLowerCase();
  if (market.includes("shots on target")) {
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

function resolveLegHit(leg: StoredComboLeg, input: ComboResolutionInput): boolean | null {
  if (leg.type === "team") {
    if (input.teamLegResultsByLabel && leg.label in input.teamLegResultsByLabel) {
      return Boolean(input.teamLegResultsByLabel[leg.label]);
    }
    return null;
  }
  const actual = getPlayerStatForLeg(leg, input);
  if (actual == null) return null;
  if (leg.outcome === "Over") return actual > leg.line - 1e-9;
  if (leg.outcome === "Under") return actual < leg.line + 1e-9;
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
