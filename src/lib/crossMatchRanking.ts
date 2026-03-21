/**
 * Global ranking and filtering for cross-match value singles.
 */

import type { ValueBetRow } from "../components/LineupModal.js";
import type { BuildLeg } from "./valueBetBuilder.js";
import { filterPlayerCandidates, type PlayerCandidateInput } from "./valueBetBuilder.js";

export type CrossMatchPlayerSingle = ValueBetRow & {
  fixtureId: number;
  matchLabel: string;
  leagueName: string;
  kickoff: string;
};

export type CrossMatchTeamSingle = {
  kind: "team";
  fixtureId: number;
  matchLabel: string;
  leagueName: string;
  kickoff: string;
  leg: BuildLeg;
};

export type CrossMatchAnySingle = CrossMatchPlayerSingle | CrossMatchTeamSingle;

export function valueBetRowToCandidate(r: ValueBetRow): PlayerCandidateInput {
  return {
    playerName: r.playerName,
    marketName: r.marketName,
    line: r.line,
    outcome: r.outcome,
    odds: r.odds,
    bookmakerName: r.bookmakerName,
    modelEdge: r.modelEdge,
    modelInputs: r.modelInputs as PlayerCandidateInput["modelInputs"],
    betQualityScore: r.betQualityScore,
    dataConfidenceScore: r.dataConfidenceScore,
    isStrongBet: r.isStrongBet,
  };
}

/** Reuse builder leg copy for a consistent reasoning line (same style as Build modal). */
export function getPlayerSingleReason(row: CrossMatchPlayerSingle): string {
  const legs = filterPlayerCandidates([valueBetRowToCandidate(row)], null);
  const reason = legs[0]?.reason?.trim();
  if (reason) return reason;
  const edge = row.modelEdge ?? row.edge ?? 0;
  const q = row.betQualityScore;
  return `Model edge ${(edge * 100).toFixed(1)}%; bet quality score ${q.toFixed(0)} (${row.betQuality}).`;
}

export interface SingleFilters {
  minOdds: number;
  maxOdds: number;
  minEdge: number;
  minBetQualityScore: number;
  bookmaker: string;
}

function oddsInRange(odds: number, f: SingleFilters): boolean {
  return odds >= f.minOdds && odds <= f.maxOdds;
}

function passesBookmaker(name: string, f: SingleFilters): boolean {
  if (f.bookmaker === "all") return true;
  return name.trim().toLowerCase() === f.bookmaker.trim().toLowerCase();
}

export function filterPlayerSingles(rows: CrossMatchPlayerSingle[], f: SingleFilters): CrossMatchPlayerSingle[] {
  return rows.filter((r) => {
    if (!oddsInRange(r.odds, f)) return false;
    if (!passesBookmaker(r.bookmakerName, f)) return false;
    const edge = r.modelEdge ?? r.edge ?? -999;
    if (edge < f.minEdge) return false;
    if (r.betQualityScore < f.minBetQualityScore) return false;
    return true;
  });
}

export function filterTeamSingles(items: CrossMatchTeamSingle[], f: SingleFilters, minTeamLegScore: number): CrossMatchTeamSingle[] {
  return items.filter((x) => {
    const leg = x.leg;
    if (!oddsInRange(leg.odds, f)) return false;
    if (!passesBookmaker(leg.bookmakerName, f)) return false;
    if (leg.score < minTeamLegScore) return false;
    const edge = typeof leg.edge === "number" && Number.isFinite(leg.edge) ? leg.edge : null;
    if (edge != null && edge < f.minEdge) return false;
    return true;
  });
}

/**
 * Deterministic global sort. When targetOdds is set, break ties by closeness to target (singles odds).
 */
export function rankPlayerSingles(rows: CrossMatchPlayerSingle[], targetOdds: number | null): CrossMatchPlayerSingle[] {
  const t = targetOdds != null && Number.isFinite(targetOdds) && targetOdds > 1 ? targetOdds : null;
  const out = [...rows];
  out.sort((a, b) => {
    const edgeA = a.modelEdge ?? a.edge ?? -999;
    const edgeB = b.modelEdge ?? b.edge ?? -999;
    if (edgeA !== edgeB) return edgeB - edgeA;
    if (a.betQualityScore !== b.betQualityScore) return b.betQualityScore - a.betQualityScore;
    if (a.dataConfidenceScore !== b.dataConfidenceScore) return b.dataConfidenceScore - a.dataConfidenceScore;
    if (t != null) {
      const da = Math.abs(a.odds - t);
      const db = Math.abs(b.odds - t);
      if (da !== db) return da - db;
    }
    if (a.fixtureId !== b.fixtureId) return a.fixtureId - b.fixtureId;
    const mk = `${a.playerName}|${a.marketName}|${a.line}|${a.outcome}`.localeCompare(
      `${b.playerName}|${b.marketName}|${b.line}|${b.outcome}`
    );
    if (mk !== 0) return mk;
    return a.bookmakerName.localeCompare(b.bookmakerName);
  });
  return out;
}

export function rankTeamSingles(items: CrossMatchTeamSingle[], targetOdds: number | null): CrossMatchTeamSingle[] {
  const t = targetOdds != null && Number.isFinite(targetOdds) && targetOdds > 1 ? targetOdds : null;
  const out = [...items];
  out.sort((a, b) => {
    const sa = a.leg.score;
    const sb = b.leg.score;
    if (sa !== sb) return sb - sa;
    const ea = a.leg.edge ?? -999;
    const eb = b.leg.edge ?? -999;
    if (ea !== eb) return eb - ea;
    if (t != null) {
      const da = Math.abs(a.leg.odds - t);
      const db = Math.abs(b.leg.odds - t);
      if (da !== db) return da - db;
    }
    if (a.fixtureId !== b.fixtureId) return a.fixtureId - b.fixtureId;
    return a.leg.label.localeCompare(b.leg.label);
  });
  return out;
}
