/**
 * Cross-fixture combo helpers: tag legs with fixture scope so generateCombos
 * can run on a merged pool without false same-player correlation, then keep only
 * combos whose legs come from distinct fixtures.
 */

import {
  generateCombos,
  filterPlayerCandidates,
  type BuildCombo,
  type BuildLeg,
  type GenerateCombosMetrics,
} from "./valueBetBuilder.js";
import type { CrossMatchPlayerSingle, CrossMatchTeamSingle } from "./crossMatchRanking.js";
import { valueBetRowToCandidate } from "./crossMatchRanking.js";

export type CrossMatchComboMarketMode = "player" | "team" | "both";

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

/**
 * True when each leg maps to a different fixture (cross-match), using xf:{id}: tags.
 */
export function isDistinctFixtureCombo(combo: BuildCombo): boolean {
  const n = combo.legs.length;
  if (n < 2) return false;
  return extractFixtureIdsFromCombo(combo).size === n;
}

/**
 * Round-robin across fixtures so the combo pool is not dominated by one match’s top legs
 * (which makes distinct-fixture combos impossible).
 */
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

const CROSS_MAX_PLAYER_LEGS = 72;
const CROSS_MAX_TEAM_LEGS = 48;
const CROSS_MAX_PER_FIXTURE_PLAYER = 12;
const CROSS_MAX_PER_FIXTURE_TEAM = 10;
const CROSS_LEG_POOL_CAP = 96;
const CROSS_RAW_COMBO_MULTIPLIER = 10;

export interface CrossFixtureComboPipelineMetrics {
  stratifiedPlayerLegsBuilt: number;
  stratifiedTeamLegsBuilt: number;
  legPoolSize: number;
  distinctFixturesInPool: number;
  generateCombos: GenerateCombosMetrics;
  afterDistinctFixtureFilter: number;
  finalRenderedCap: number;
}

export function buildStratifiedCrossMatchLegPool(
  rankedPlayers: CrossMatchPlayerSingle[],
  rankedTeams: CrossMatchTeamSingle[],
  marketMode: CrossMatchComboMarketMode
): { legs: BuildLeg[]; stratifiedPlayerLegsBuilt: number; stratifiedTeamLegsBuilt: number } {
  const out: BuildLeg[] = [];
  let stratifiedPlayerLegsBuilt = 0;
  let stratifiedTeamLegsBuilt = 0;

  if (marketMode !== "team") {
    const pSlice = stratifyPreRankedByFixture(
      rankedPlayers,
      (r) => r.fixtureId,
      CROSS_MAX_PER_FIXTURE_PLAYER,
      CROSS_MAX_PLAYER_LEGS
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
      CROSS_MAX_PER_FIXTURE_TEAM,
      CROSS_MAX_TEAM_LEGS
    );
    for (const t of tSlice) {
      out.push(tagLegForCrossFixture(t.leg, t.fixtureId));
      stratifiedTeamLegsBuilt += 1;
    }
  }

  out.sort((a, b) => b.score - a.score);
  const legs = out.slice(0, CROSS_LEG_POOL_CAP);
  return { legs, stratifiedPlayerLegsBuilt, stratifiedTeamLegsBuilt };
}

/**
 * Build 2–3 leg combos near target odds from a merged, tagged leg pool.
 * Filters to genuine cross-match combos only (each leg from a different fixture).
 */
export function buildCrossFixtureCombos(
  legs: BuildLeg[],
  targetOdds: number,
  options: {
    maxCombos?: number;
    maxLegs?: number;
    rawCandidateMultiplier?: number;
    metrics?: CrossFixtureComboPipelineMetrics;
    /** Filled into `metrics` when present (from {@link buildStratifiedCrossMatchLegPool}). */
    stratifiedLegCounts?: { player: number; team: number };
  } = {}
): BuildCombo[] {
  if (!Number.isFinite(targetOdds) || targetOdds <= 1) return [];
  const maxCombos = options.maxCombos ?? 36;
  const maxLegs = options.maxLegs ?? 3;
  const mult = options.rawCandidateMultiplier ?? CROSS_RAW_COMBO_MULTIPLIER;

  const genMetrics: GenerateCombosMetrics = {
    preEvComboCount: 0,
    postMinEvComboCount: 0,
    afterPositiveNearFilterCount: 0,
    returnedCount: 0,
    rejectedSameFamilyOverlap: 0,
  };

  const raw = generateCombos(legs, targetOdds, {
    maxCombos: maxCombos * mult,
    maxLegs,
    minComboEV: 0,
    metrics: genMetrics,
  });
  const distinct = raw.filter(isDistinctFixtureCombo);
  const sliced = distinct.slice(0, maxCombos);

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
    options.metrics.generateCombos = genMetrics;
    options.metrics.afterDistinctFixtureFilter = distinct.length;
    options.metrics.finalRenderedCap = sliced.length;
  }

  if (import.meta.env.DEV) {
    console.log("[cross-match-combos] pipeline", {
      legPoolSize: legs.length,
      distinctFixturesInPool: options.metrics?.distinctFixturesInPool,
      preEvCombos: genMetrics.preEvComboCount,
      postMinEvCombos: genMetrics.postMinEvComboCount,
      afterPositiveNearFilter: genMetrics.afterPositiveNearFilterCount,
      generateCombosReturned: genMetrics.returnedCount,
      afterDistinctFixture: distinct.length,
      finalSlice: sliced.length,
    });
  }

  return sliced;
}
