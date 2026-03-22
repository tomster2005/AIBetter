/**
 * Cross-fixture combo helpers: tag legs with fixture scope, cap pools aggressively,
 * then search combos with bounded evaluation, pruning, and async yields (no UI freeze).
 */

import {
  filterPlayerCandidates,
  buildComboFromSelectedLegs,
  hasSameFamilyOverlap,
  type BuildCombo,
  type BuildLeg,
  type GenerateCombosMetrics,
} from "./valueBetBuilder.js";
import type { CrossMatchPlayerSingle, CrossMatchTeamSingle } from "./crossMatchRanking.js";
import { valueBetRowToCandidate } from "./crossMatchRanking.js";

export type CrossMatchComboMarketMode = "player" | "team" | "both";

/** Hard limits — cross-match only (single-fixture modal unchanged). */
const CROSS_STRATIFY_MAX_PER_FIXTURE = 3;
const CROSS_STRATIFY_MAX_PLAYER = 48;
const CROSS_STRATIFY_MAX_TEAM = 48;
const CROSS_LEG_POOL_GLOBAL_MAX = 40;
const CROSS_LEGS_PER_FIXTURE_MAX = 3;

const CROSS_MAX_COMBOS_EVALUATED = 8000;
const CROSS_COMBO_TIME_LIMIT_MS = 150;
const CROSS_YIELD_EVERY_STEPS = 200;

/** Max legs sharing the same {@link legDiversityFamily} inside one cross-match combo. */
const CROSS_MAX_LEGS_PER_SAME_DIVERSITY = 2;
/** Minimum model edge (fraction) for a leg that duplicates a diversity family already in the partial combo. */
const MIN_EDGE_FOR_DUPLICATE_FAMILY = 0.035;
/** Fallback when `edge` is missing: builder score must clear this to allow a second leg of the same diversity family. */
const MIN_SCORE_FOR_DUPLICATE_FAMILY = 48;
/** Subtracted from `comboScore` only in the final sort tie-break (does not change stored EV or combo fields). */
const COMBO_DIVERSITY_REPEAT_SORT_PENALTY = 3;

/** Aligns with builder team corner legs (`valueBetBuilder`). */
const TEAM_CORNERS_DIVERSITY_FAMILY = "team:alternative-corners";

/**
 * Cross-match diversity bucket: strips fixture prefix and collapses player-specific families to `player:{category}`.
 * Collapses main + alt O/U goals into one bucket so combos cannot stack multiple goal-total legs.
 */
export function legDiversityFamily(leg: BuildLeg): string {
  const raw = leg.marketFamily.replace(/^xf:\d+:/, "");
  const playerM = /^player:[^|]+\|(.+)$/.exec(raw);
  if (playerM) return `player:${playerM[1]}`;
  if (raw === "team:match-goals" || raw === "team:alternative-total-goals") return "team:total-goals";
  if (raw === TEAM_CORNERS_DIVERSITY_FAMILY) return "team:corners";
  return raw;
}

/**
 * Same fixture + same market shape + line + outcome → redundant (cross-fixture duplicate lines still allowed).
 */
export function legRedundancyKey(leg: BuildLeg): string {
  const xf = /^xf:(\d+):/.exec(leg.marketFamily);
  const fid = xf ? xf[1]! : "0";
  const raw = leg.marketFamily.replace(/^xf:\d+:/, "");
  const mn = String(leg.marketName ?? "")
    .trim()
    .toLowerCase();
  return `${fid}|${raw}|${mn}|${leg.line}|${leg.outcome}`;
}

export function passesDuplicateFamilyQualityGate(leg: BuildLeg): boolean {
  const e = leg.edge;
  if (typeof e === "number" && Number.isFinite(e) && e >= MIN_EDGE_FOR_DUPLICATE_FAMILY) return true;
  if (leg.score >= MIN_SCORE_FOR_DUPLICATE_FAMILY) return true;
  return false;
}

/**
 * Used only for the "≥2 different legs" combo rule: allows two `player:shots` from different players,
 * or two `team:total-goals` from different fixtures, while {@link legDiversityFamily} still caps repeats per market type.
 */
export function legComboBreadthKey(leg: BuildLeg): string {
  const xf = /^xf:(\d+):/.exec(leg.marketFamily);
  const fid = xf ? xf[1]! : "0";
  if (leg.type === "player") {
    const pid = String(leg.playerId ?? leg.playerName ?? "")
      .trim()
      .toLowerCase();
    return `${legDiversityFamily(leg)}|p:${pid}`;
  }
  return `${legDiversityFamily(leg)}|f:${fid}`;
}

type CrossMatchDiversityRejectReason =
  | "too_many_same_family"
  | "redundant"
  | "quality_second"
  | "insufficient_family_mix";

function tryAppendLegForCrossMatch(
  currentIndices: readonly number[],
  candIdx: number,
  legs: BuildLeg[],
  comboLegCount: number
): { ok: true } | { ok: false; reason: CrossMatchDiversityRejectReason } {
  const cand = legs[candIdx]!;
  const div = legDiversityFamily(cand);
  let sameFamilyBefore = 0;
  for (const j of currentIndices) {
    if (legDiversityFamily(legs[j]!) === div) sameFamilyBefore++;
  }
  if (sameFamilyBefore >= CROSS_MAX_LEGS_PER_SAME_DIVERSITY) {
    return { ok: false, reason: "too_many_same_family" };
  }
  if (sameFamilyBefore >= 1 && !passesDuplicateFamilyQualityGate(cand)) {
    return { ok: false, reason: "quality_second" };
  }
  const rk = legRedundancyKey(cand);
  for (const j of currentIndices) {
    if (legRedundancyKey(legs[j]!) === rk) {
      return { ok: false, reason: "redundant" };
    }
  }
  if (currentIndices.length + 1 === comboLegCount) {
    const allLegs = [...currentIndices.map((j) => legs[j]!), cand];
    const uniqBreadth = new Set(allLegs.map((l) => legComboBreadthKey(l))).size;
    if (uniqBreadth < 2) {
      return { ok: false, reason: "insufficient_family_mix" };
    }
  }
  return { ok: true };
}

const CROSS_MAX_LEGS_PER_DIVERSITY_FAMILY = 7;

function marketFamilyWithFixture(leg: BuildLeg, fixtureId: number): string {
  const prefix = `xf:${fixtureId}:`;
  if (leg.marketFamily.startsWith("xf:")) return leg.marketFamily;
  return `${prefix}${leg.marketFamily}`;
}

/** Prefix leg ids / market families / playerIds so merged pools stay distinct per fixture. */
export function tagLegForCrossFixture(leg: BuildLeg, fixtureId: number): BuildLeg {
  const mf = marketFamilyWithFixture(leg, fixtureId);
  const newPlayerId =
    leg.type === "player" && leg.playerId != null && leg.playerId !== ""
      ? `xf:${fixtureId}:${leg.playerId}`
      : leg.playerId;
  return {
    ...leg,
    id: `cm-${fixtureId}-${leg.id}`.slice(0, 160),
    marketFamily: mf,
    playerId: newPlayerId,
  };
}

export function extractFixtureIdsFromCombo(combo: BuildCombo): Set<number> {
  const ids = new Set<number>();
  for (const leg of combo.legs) {
    const m = /^xf:(\d+):/.exec(leg.marketFamily);
    if (m) ids.add(Number(m[1]));
  }
  return ids;
}

export function isDistinctFixtureCombo(combo: BuildCombo): boolean {
  const n = combo.legs.length;
  if (n < 2) return false;
  return extractFixtureIdsFromCombo(combo).size === n;
}

export function stratifyPreRankedByFixture<T>(
  globallyRanked: T[],
  getFixtureId: (t: T) => number,
  maxPerFixture: number,
  maxTotal: number
): T[] {
  const byFix = new Map<number, T[]>();
  for (const item of globallyRanked) {
    const id = getFixtureId(item);
    let arr = byFix.get(id);
    if (!arr) {
      arr = [];
      byFix.set(id, arr);
    }
    arr.push(item);
  }
  const fixtureOrder = [...byFix.keys()].sort((a, b) => a - b);
  const pos = new Map<number, number>();
  for (const id of fixtureOrder) pos.set(id, 0);
  const taken = new Map<number, number>();
  const out: T[] = [];
  while (out.length < maxTotal) {
    let progressed = false;
    for (const fid of fixtureOrder) {
      if (out.length >= maxTotal) break;
      if ((taken.get(fid) ?? 0) >= maxPerFixture) continue;
      const arr = byFix.get(fid)!;
      const i = pos.get(fid) ?? 0;
      if (i >= arr.length) continue;
      out.push(arr[i]!);
      pos.set(fid, i + 1);
      taken.set(fid, (taken.get(fid) ?? 0) + 1);
      progressed = true;
    }
    if (!progressed) break;
  }
  return out;
}

function legConfidenceScore(leg: BuildLeg): number {
  const pq = leg.playerQuality;
  if (pq) {
    return pq.sampleReliability + pq.qualityScore + pq.recencyScore * 0.5;
  }
  return leg.score * 0.25;
}

/** Deterministic: edge → score → confidence → id. */
export function compareLegsForCrossMatchSearch(a: BuildLeg, b: BuildLeg): number {
  const edgeA = Number.isFinite(a.edge as number) ? (a.edge as number) : -999;
  const edgeB = Number.isFinite(b.edge as number) ? (b.edge as number) : -999;
  if (edgeA !== edgeB) return edgeB - edgeA;
  if (a.score !== b.score) return b.score - a.score;
  const ca = legConfidenceScore(a);
  const cb = legConfidenceScore(b);
  if (ca !== cb) return cb - ca;
  return a.id.localeCompare(b.id);
}

/**
 * After stratified merge: at most `maxPerFixture` legs per fixture, `maxTotal` overall (greedy on sort order).
 */
export function applyPerFixtureAndGlobalLegCap(legs: BuildLeg[], maxPerFixture: number, maxTotal: number): BuildLeg[] {
  const sorted = [...legs].sort(compareLegsForCrossMatchSearch);
  const countByFix = new Map<number, number>();
  const out: BuildLeg[] = [];
  for (const leg of sorted) {
    const m = /^xf:(\d+):/.exec(leg.marketFamily);
    const fid = m ? Number(m[1]) : -1;
    if (fid < 0) continue;
    const c = countByFix.get(fid) ?? 0;
    if (c >= maxPerFixture) continue;
    countByFix.set(fid, c + 1);
    out.push(leg);
    if (out.length >= maxTotal) break;
  }
  return out.sort(compareLegsForCrossMatchSearch);
}

/**
 * Keep only the best legs per diversity family (deterministic sort), then caller applies fixture/global caps.
 */
export function capLegsPerDiversityFamily(legs: BuildLeg[], maxPerFamily: number): BuildLeg[] {
  const byFam = new Map<string, BuildLeg[]>();
  for (const leg of legs) {
    const k = legDiversityFamily(leg);
    let arr = byFam.get(k);
    if (!arr) {
      arr = [];
      byFam.set(k, arr);
    }
    arr.push(leg);
  }
  const out: BuildLeg[] = [];
  const famKeys = [...byFam.keys()].sort((a, b) => a.localeCompare(b));
  for (const k of famKeys) {
    const arr = byFam.get(k)!;
    arr.sort(compareLegsForCrossMatchSearch);
    out.push(...arr.slice(0, maxPerFamily));
  }
  return out.sort(compareLegsForCrossMatchSearch);
}

export interface CrossMatchBoundedRunMetrics {
  legsInputBeforeFinalCap: number;
  legsAfterFinalCap: number;
  evaluatedLeaves: number;
  returnedAfterDistinct: number;
  returnedFinal: number;
  ms: number;
  truncatedEval: boolean;
  truncatedTime: boolean;
  steps: number;
  rejectedSameFamilyOverlap: number;
  /** Sum of soft-diversity reject reasons below (legacy aggregate). */
  rejectedDiversityConstraint: number;
  rejectedTooManySameFamily: number;
  rejectedRedundantLeg: number;
  rejectedDuplicateQuality: number;
  rejectedInsufficientFamilyMix: number;
}

export interface CrossFixtureComboPipelineMetrics {
  stratifiedPlayerLegsBuilt: number;
  stratifiedTeamLegsBuilt: number;
  legPoolSize: number;
  distinctFixturesInPool: number;
  generateCombos: GenerateCombosMetrics;
  afterDistinctFixtureFilter: number;
  finalRenderedCap: number;
  bounded?: CrossMatchBoundedRunMetrics;
  comboSearchTruncated: boolean;
}

function comboDiversityUniqueCount(combo: BuildCombo): number {
  return new Set(combo.legs.map((l) => legDiversityFamily(l))).size;
}

function comboTypeBreadth(combo: BuildCombo): number {
  return new Set(combo.legs.map((l) => l.type)).size;
}

/** Penalise repeated diversity families in sort only (stored `comboScore` / EV unchanged). */
function comboDiversityRepeatSortPenalty(combo: BuildCombo): number {
  const counts = new Map<string, number>();
  for (const leg of combo.legs) {
    const k = legDiversityFamily(leg);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let extra = 0;
  for (const c of counts.values()) {
    if (c > 1) extra += c - 1;
  }
  return extra * COMBO_DIVERSITY_REPEAT_SORT_PENALTY;
}

function adjustedComboScoreForSort(combo: BuildCombo): number {
  return combo.comboScore - comboDiversityRepeatSortPenalty(combo);
}

/** Cross-match final ranking: distance → EV → diversity → player/team mix → combo score (EV math unchanged). */
function finalizeRankedCombosCrossMatch(combos: BuildCombo[], maxCombos: number, minComboEV: number): BuildCombo[] {
  const evFiltered = combos.filter((c) => c.comboEV >= minComboEV);
  const baseCombos = evFiltered.length > 0 ? evFiltered : combos;
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
    if (a.distanceFromTarget !== b.distanceFromTarget) return a.distanceFromTarget - b.distanceFromTarget;
    if (a.comboEV !== b.comboEV) return b.comboEV - a.comboEV;
    const divA = comboDiversityUniqueCount(a);
    const divB = comboDiversityUniqueCount(b);
    if (divA !== divB) return divB - divA;
    const brA = comboTypeBreadth(a);
    const brB = comboTypeBreadth(b);
    if (brA !== brB) return brB - brA;
    const adjA = adjustedComboScoreForSort(a);
    const adjB = adjustedComboScoreForSort(b);
    if (adjA !== adjB) return adjB - adjA;
    return (a.fingerprint ?? "").localeCompare(b.fingerprint ?? "");
  });
  return rankedSource.slice(0, maxCombos);
}

function yieldToMain(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * Bounded async search: max evaluated leaves, time limit, yield every N steps, branch pruning.
 * Deterministic for a fixed leg order and caps; time limit may truncate earlier on slow devices.
 */
export async function generateCrossMatchCombosBoundedAsync(
  legs: BuildLeg[],
  targetOdds: number,
  options: {
    maxCombos?: number;
    maxLegs?: number;
    minComboEV?: number;
    maxEvaluated?: number;
    timeLimitMs?: number;
    yieldEvery?: number;
    metrics?: CrossMatchBoundedRunMetrics;
    /** Leg count before final per-fixture/global cap (cross-match pool only). */
    legsInputBeforeCap?: number;
  } = {}
): Promise<BuildCombo[]> {
  const maxCombos = options.maxCombos ?? 20;
  const maxLegs = Math.min(options.maxLegs ?? 3, 3);
  const maxEvaluated = options.maxEvaluated ?? CROSS_MAX_COMBOS_EVALUATED;
  const timeLimitMs = options.timeLimitMs ?? CROSS_COMBO_TIME_LIMIT_MS;
  const yieldEvery = options.yieldEvery ?? CROSS_YIELD_EVERY_STEPS;
  const minComboEV = options.minComboEV ?? 0;

  if (legs.length < 2 || !Number.isFinite(targetOdds) || targetOdds <= 1) {
    return [];
  }

  const validOdds = legs.map((l) => l.odds).filter((o) => o > 1 && Number.isFinite(o));
  const globalMaxO = validOdds.length ? Math.max(...validOdds) : 15;
  const globalMinO = validOdds.length ? Math.min(...validOdds) : 1.01;

  const combos: BuildCombo[] = [];
  const used = new Set<string>();
  let rejectedOverlap = 0;
  let rejectedTooManySameFamily = 0;
  let rejectedRedundantLeg = 0;
  let rejectedDuplicateQuality = 0;
  let rejectedInsufficientFamilyMix = 0;
  let evaluatedLeaves = 0;
  let steps = 0;
  let truncatedEval = false;
  let truncatedTime = false;
  const t0 = performance.now();

  const indices: number[] = [];

  async function maybeYield(): Promise<void> {
    steps++;
    if (yieldEvery > 0 && steps % yieldEvery === 0) {
      await yieldToMain();
    }
  }

  function hitTimeLimit(): boolean {
    if (performance.now() - t0 > timeLimitMs) {
      truncatedTime = true;
      return true;
    }
    return false;
  }

  function partialProduct(idxs: number[]): number {
    let p = 1;
    for (const i of idxs) p *= legs[i]!.odds;
    return p;
  }

  function prunePartial(curProduct: number, need: number): boolean {
    if (need <= 0) return false;
    if (curProduct > Math.max(targetOdds * 60, 8000)) return true;
    const maxReach = curProduct * Math.pow(globalMaxO, need);
    if (maxReach < targetOdds * 0.82) return true;
    const minReach = curProduct * Math.pow(globalMinO, need);
    if (minReach > Math.max(targetOdds * 45, 5000)) return true;
    return false;
  }

  function bumpDiversityReject(reason: CrossMatchDiversityRejectReason): void {
    if (reason === "too_many_same_family") rejectedTooManySameFamily += 1;
    else if (reason === "redundant") rejectedRedundantLeg += 1;
    else if (reason === "quality_second") rejectedDuplicateQuality += 1;
    else if (reason === "insufficient_family_mix") rejectedInsufficientFamilyMix += 1;
  }

  async function recurse(start: number, n: number): Promise<void> {
    await maybeYield();
    if (hitTimeLimit()) return;
    if (evaluatedLeaves >= maxEvaluated) {
      truncatedEval = true;
      return;
    }

    const depth = indices.length;
    if (depth === n) {
      evaluatedLeaves++;
      const selected = indices.map((i) => legs[i]!);
      if (hasSameFamilyOverlap(selected)) {
        rejectedOverlap++;
        return;
      }
      const key = indices.slice().sort((a, b) => a - b).join(",");
      if (!used.has(key)) {
        used.add(key);
        combos.push(buildComboFromSelectedLegs(selected, targetOdds));
      }
      return;
    }

    const cur = partialProduct(indices);
    const need = n - depth;
    if (prunePartial(cur, need)) return;

    for (let i = start; i < legs.length; i++) {
      if (hitTimeLimit() || evaluatedLeaves >= maxEvaluated) {
        if (evaluatedLeaves >= maxEvaluated) truncatedEval = true;
        return;
      }
      const append = tryAppendLegForCrossMatch(indices, i, legs, n);
      if (!append.ok) {
        bumpDiversityReject(append.reason);
        continue;
      }
      indices.push(i);
      const nextCur = cur * legs[i]!.odds;
      const nextNeed = n - depth - 1;
      if (!prunePartial(nextCur, nextNeed)) {
        await recurse(i + 1, n);
      }
      indices.pop();
    }
  }

  for (let n = 2; n <= maxLegs; n++) {
    indices.length = 0;
    if (hitTimeLimit() || evaluatedLeaves >= maxEvaluated) break;
    await recurse(0, n);
  }

  const ms = performance.now() - t0;
  const distinct = combos.filter(isDistinctFixtureCombo);
  const finalized = finalizeRankedCombosCrossMatch(distinct, maxCombos, minComboEV);

  const rejectedDiversityConstraint =
    rejectedTooManySameFamily + rejectedRedundantLeg + rejectedDuplicateQuality + rejectedInsufficientFamilyMix;

  if (import.meta.env.DEV) {
    const combosWithDuplicates = distinct.filter((c) => {
      const m = new Map<string, number>();
      for (const l of c.legs) {
        const k = legDiversityFamily(l);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return [...m.values()].some((v) => v > 1);
    }).length;
    const avgFamilies =
      distinct.length > 0
        ? distinct.reduce((s, c) => s + comboDiversityUniqueCount(c), 0) / distinct.length
        : 0;
    console.log("[cross-match] diversity debug", {
      combosWithDuplicates,
      rejectedForTooManySameType: rejectedTooManySameFamily,
      rejectedRedundantLeg,
      rejectedDuplicateQuality,
      rejectedInsufficientFamilyMix,
      avgFamiliesPerCombo: avgFamilies,
      totalCombos: distinct.length,
    });
  }

  if (options.metrics) {
    options.metrics.legsInputBeforeFinalCap = options.legsInputBeforeCap ?? legs.length;
    options.metrics.legsAfterFinalCap = legs.length;
    options.metrics.evaluatedLeaves = evaluatedLeaves;
    options.metrics.returnedAfterDistinct = distinct.length;
    options.metrics.returnedFinal = finalized.length;
    options.metrics.ms = ms;
    options.metrics.truncatedEval = truncatedEval;
    options.metrics.truncatedTime = truncatedTime;
    options.metrics.steps = steps;
    options.metrics.rejectedSameFamilyOverlap = rejectedOverlap;
    options.metrics.rejectedDiversityConstraint = rejectedDiversityConstraint;
    options.metrics.rejectedTooManySameFamily = rejectedTooManySameFamily;
    options.metrics.rejectedRedundantLeg = rejectedRedundantLeg;
    options.metrics.rejectedDuplicateQuality = rejectedDuplicateQuality;
    options.metrics.rejectedInsufficientFamilyMix = rejectedInsufficientFamilyMix;
  }

  if (import.meta.env.DEV) {
    console.log(
      `[cross-match] combos: evaluated=${evaluatedLeaves}, returned=${finalized.length}, time=${ms.toFixed(0)}ms`,
      {
        truncatedEval,
        truncatedTime,
        distinct: distinct.length,
        pool: legs.length,
        rejectedDiversity: rejectedDiversityConstraint,
      }
    );
  }

  return finalized;
}

export function buildStratifiedCrossMatchLegPool(
  rankedPlayers: CrossMatchPlayerSingle[],
  rankedTeams: CrossMatchTeamSingle[],
  marketMode: CrossMatchComboMarketMode
): {
  legs: BuildLeg[];
  stratifiedPlayerLegsBuilt: number;
  stratifiedTeamLegsBuilt: number;
  legsBeforeFinalCap: number;
} {
  const out: BuildLeg[] = [];
  let stratifiedPlayerLegsBuilt = 0;
  let stratifiedTeamLegsBuilt = 0;

  if (marketMode !== "team") {
    const pSlice = stratifyPreRankedByFixture(
      rankedPlayers,
      (r) => r.fixtureId,
      CROSS_STRATIFY_MAX_PER_FIXTURE,
      CROSS_STRATIFY_MAX_PLAYER
    );
    for (const row of pSlice) {
      const legs = filterPlayerCandidates([valueBetRowToCandidate(row)], null);
      const l = legs[0];
      if (l) {
        out.push(tagLegForCrossFixture(l, row.fixtureId));
        stratifiedPlayerLegsBuilt += 1;
      }
    }
  }

  if (marketMode !== "player") {
    const tSlice = stratifyPreRankedByFixture(
      rankedTeams,
      (t) => t.fixtureId,
      CROSS_STRATIFY_MAX_PER_FIXTURE,
      CROSS_STRATIFY_MAX_TEAM
    );
    for (const t of tSlice) {
      out.push(tagLegForCrossFixture(t.leg, t.fixtureId));
      stratifiedTeamLegsBuilt += 1;
    }
  }

  const afterStratify = out.length;
  const diversityCapped = capLegsPerDiversityFamily(out, CROSS_MAX_LEGS_PER_DIVERSITY_FAMILY);
  const legsBeforeFinalCap = diversityCapped.length;
  const legs = applyPerFixtureAndGlobalLegCap(diversityCapped, CROSS_LEGS_PER_FIXTURE_MAX, CROSS_LEG_POOL_GLOBAL_MAX);
  return { legs, stratifiedPlayerLegsBuilt, stratifiedTeamLegsBuilt, legsBeforeFinalCap: afterStratify };
}

/**
 * Async cross-match combo pipeline (distinct fixtures only). Does not call sync `generateCombos`.
 */
export async function buildCrossFixtureCombosAsync(
  legs: BuildLeg[],
  targetOdds: number,
  options: {
    maxCombos?: number;
    maxLegs?: number;
    metrics?: CrossFixtureComboPipelineMetrics;
    stratifiedLegCounts?: { player: number; team: number };
    legsBeforeFinalCap?: number;
    maxEvaluated?: number;
    timeLimitMs?: number;
  } = {}
): Promise<BuildCombo[]> {
  if (!Number.isFinite(targetOdds) || targetOdds <= 1) return [];
  const maxCombos = options.maxCombos ?? 20;

  const bounded: CrossMatchBoundedRunMetrics = {
    legsInputBeforeFinalCap: options.legsBeforeFinalCap ?? legs.length,
    legsAfterFinalCap: legs.length,
    evaluatedLeaves: 0,
    returnedAfterDistinct: 0,
    returnedFinal: 0,
    ms: 0,
    truncatedEval: false,
    truncatedTime: false,
    steps: 0,
    rejectedSameFamilyOverlap: 0,
    rejectedDiversityConstraint: 0,
    rejectedTooManySameFamily: 0,
    rejectedRedundantLeg: 0,
    rejectedDuplicateQuality: 0,
    rejectedInsufficientFamilyMix: 0,
  };

  const sliced = await generateCrossMatchCombosBoundedAsync(legs, targetOdds, {
    maxCombos,
    maxLegs: options.maxLegs ?? 3,
    minComboEV: 0,
    maxEvaluated: options.maxEvaluated,
    timeLimitMs: options.timeLimitMs,
    metrics: bounded,
    legsInputBeforeCap: options.legsBeforeFinalCap,
  });

  if (options.metrics) {
    const poolFixtures = new Set<number>();
    for (const leg of legs) {
      const m = /^xf:(\d+):/.exec(leg.marketFamily);
      if (m) poolFixtures.add(Number(m[1]));
    }
    if (options.stratifiedLegCounts) {
      options.metrics.stratifiedPlayerLegsBuilt = options.stratifiedLegCounts.player;
      options.metrics.stratifiedTeamLegsBuilt = options.stratifiedLegCounts.team;
    }
    options.metrics.legPoolSize = legs.length;
    options.metrics.distinctFixturesInPool = poolFixtures.size;
    options.metrics.afterDistinctFixtureFilter = bounded.returnedAfterDistinct;
    options.metrics.finalRenderedCap = sliced.length;
    options.metrics.bounded = bounded;
    options.metrics.comboSearchTruncated = bounded.truncatedEval || bounded.truncatedTime;
    options.metrics.generateCombos = {
      preEvComboCount: bounded.evaluatedLeaves,
      postMinEvComboCount: bounded.evaluatedLeaves,
      afterPositiveNearFilterCount: bounded.returnedAfterDistinct,
      returnedCount: sliced.length,
      rejectedSameFamilyOverlap: bounded.rejectedSameFamilyOverlap,
    };
  }

  return sliced;
}
