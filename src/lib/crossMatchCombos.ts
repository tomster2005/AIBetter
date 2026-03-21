/**
 * Cross-fixture combo helpers: tag legs with fixture scope so generateCombos
 * can run on a merged pool without false same-player correlation, then keep only
 * combos whose legs come from distinct fixtures.
 */

import type { BuildCombo, BuildLeg } from "./valueBetBuilder.js";
import { generateCombos } from "./valueBetBuilder.js";

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
 * Build 2–3 leg combos near target odds from a merged, tagged leg pool.
 * Filters to genuine cross-match combos only (each leg from a different fixture).
 */
export function buildCrossFixtureCombos(
  legs: BuildLeg[],
  targetOdds: number,
  options: { maxCombos?: number; maxLegs?: number } = {}
): BuildCombo[] {
  if (!Number.isFinite(targetOdds) || targetOdds <= 1) return [];
  const maxCombos = options.maxCombos ?? 36;
  const maxLegs = options.maxLegs ?? 3;
  const raw = generateCombos(legs, targetOdds, { maxCombos: maxCombos * 3, maxLegs });
  return raw.filter(isDistinctFixtureCombo).slice(0, maxCombos);
}
