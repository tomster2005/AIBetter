/**
 * Team prop scoring + explanation using recent league form (all opponents) + H2H.
 * Used by Build Value Bets only; does not affect settlement.
 */

import type { HeadToHeadFixtureContext } from "../types/headToHeadContext.js";
import type { FixtureTeamFormContext } from "../types/teamRecentFormContext.js";

/** Structural subset of `BuildLeg` — avoids circular import with valueBetBuilder. */
export type TeamLegReasoningTarget = {
  type: "player" | "team";
  marketFamily: string;
  outcome: string;
  line: number;
  score: number;
  reason?: string;
  label: string;
};

/** Minimum finished matches with scores per side to treat recent form as usable. */
export const MIN_RECENT_FORM_MATCHES_PER_SIDE = 3;

/** Minimum H2H fixtures to lean on H2H alone when form is missing. */
export const MIN_H2H_FOR_SOLO_SUPPORT = 4;

const EPS = 1e-9;

export function isFormContextStrong(form: FixtureTeamFormContext | null | undefined): boolean {
  if (!form || form.fetchFailed) return false;
  return form.home.sampleSize >= MIN_RECENT_FORM_MATCHES_PER_SIDE && form.away.sampleSize >= MIN_RECENT_FORM_MATCHES_PER_SIDE;
}

export function shouldIncludeNonCornerTeamLegInPool(
  leg: Pick<TeamLegReasoningTarget, "marketFamily">,
  h2h: HeadToHeadFixtureContext | null | undefined,
  form: FixtureTeamFormContext | null | undefined
): boolean {
  if (leg.marketFamily === "team:alternative-corners") return true;
  const h2hOk = (h2h?.sampleSize ?? 0) >= MIN_H2H_FOR_SOLO_SUPPORT;
  return isFormContextStrong(form) || h2hOk;
}

function fmt1(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return x.toFixed(1);
}

/** Expected total goals for this fixture from venue-weighted attack vs defence. */
export function blendedExpectedTotalGoals(form: FixtureTeamFormContext): number | null {
  const h = form.home;
  const a = form.away;
  const hf =
    h.homeSplit.n >= 2 && h.homeSplit.avgGoalsFor != null ? h.homeSplit.avgGoalsFor : h.avgGoalsFor;
  const aa =
    a.awaySplit.n >= 2 && a.awaySplit.avgGoalsAgainst != null ? a.awaySplit.avgGoalsAgainst : a.avgGoalsAgainst;
  const af =
    a.awaySplit.n >= 2 && a.awaySplit.avgGoalsFor != null ? a.awaySplit.avgGoalsFor : a.avgGoalsFor;
  const ha =
    h.homeSplit.n >= 2 && h.homeSplit.avgGoalsAgainst != null ? h.homeSplit.avgGoalsAgainst : h.avgGoalsAgainst;
  if (hf != null && aa != null && af != null && ha != null) {
    return (hf + aa) / 2 + (af + ha) / 2;
  }
  if (h.avgMatchTotalGoals != null && a.avgMatchTotalGoals != null) {
    return (h.avgMatchTotalGoals + a.avgMatchTotalGoals) / 2;
  }
  return null;
}

function countOverUnder(totals: readonly number[], line: number, over: boolean): number {
  return totals.filter((t) => (over ? t > line - EPS : t < line + EPS)).length;
}

/**
 * Adjust team leg score using recent form (primary) and lightly reinforce with H2H when both exist.
 * Mutates `leg.score` and appends concise notes to `leg.reason`.
 */
export function applyFixtureTeamFormToLegScore(
  leg: TeamLegReasoningTarget,
  form: FixtureTeamFormContext | null | undefined,
  h2h: HeadToHeadFixtureContext | null | undefined,
  names: { home: string; away: string }
): void {
  if (!isFormContextStrong(form) || leg.type !== "team") return;

  const hn = names.home.trim() || "Home";
  const an = names.away.trim() || "Away";
  let delta = 0;
  const notes: string[] = [];

  const exp = blendedExpectedTotalGoals(form!);
  const h = form!.home;
  const a = form!.away;

  if (
    (leg.marketFamily === "team:match-goals" || leg.marketFamily === "team:alternative-total-goals") &&
    Number.isFinite(leg.line)
  ) {
    const line = leg.line;
    const hOver = countOverUnder(h.recentMatchTotals, line, true);
    const aOver = countOverUnder(a.recentMatchTotals, line, true);
    const hN = h.recentMatchTotals.length;
    const aN = a.recentMatchTotals.length;

    if (leg.outcome === "Over") {
      if (exp != null) {
        if (exp >= line + 0.35) {
          delta += 6;
          notes.push(`blended recent attack/defence ~${fmt1(exp)} goals vs ${line} line`);
        } else if (exp <= line - 0.35) {
          delta -= 8;
          notes.push(`blended recent profile ~${fmt1(exp)} goals vs ${line} line (caution on Over)`);
        }
      }
      if (hN > 0 && aN > 0) {
        notes.push(`${hOver}/${hN} ${hn} and ${aOver}/${aN} ${an} last-${hN} games over ${line} total goals`);
        const combinedRate = (hOver + aOver) / (hN + aN);
        if (combinedRate >= 0.65) delta += 4;
        else if (combinedRate <= 0.35) delta -= 5;
      }
    } else if (leg.outcome === "Under") {
      const hUnder = countOverUnder(h.recentMatchTotals, line, false);
      const aUnder = countOverUnder(a.recentMatchTotals, line, false);
      if (exp != null) {
        if (exp <= line - 0.35) {
          delta += 6;
          notes.push(`blended recent profile ~${fmt1(exp)} goals vs ${line} line`);
        } else if (exp >= line + 0.35) {
          delta -= 8;
          notes.push(`blended recent profile ~${fmt1(exp)} goals vs ${line} line (caution on Under)`);
        }
      }
      if (hN > 0 && aN > 0) {
        notes.push(`${hUnder}/${hN} ${hn} and ${aUnder}/${aN} ${an} under ${line} total goals`);
        const combinedRate = (hUnder + aUnder) / (hN + aN);
        if (combinedRate >= 0.65) delta += 4;
        else if (combinedRate <= 0.35) delta -= 5;
      }
    }
  }

  if (leg.marketFamily === "team:btts") {
    const hr = h.bttsRate;
    const ar = a.bttsRate;
    const sr = h.scoredInRate;
    const cr = h.concededInRate;
    const srA = a.scoredInRate;
    const crA = a.concededInRate;
    if (leg.outcome === "Yes") {
      if (hr != null && ar != null) {
        const bothHigh = hr >= 0.5 && ar >= 0.5;
        if (bothHigh) delta += 5;
        notes.push(`${hn} BTTS in ${h.bttsHits}/${h.sampleSize} recent; ${an} in ${a.bttsHits}/${a.sampleSize}`);
      }
      if (sr != null && cr != null && srA != null && crA != null) {
        notes.push(
          `${hn} scored in ${(sr * 100).toFixed(0)}% & conceded in ${(cr * 100).toFixed(0)}% of recent; ${an} scored in ${(srA * 100).toFixed(0)}% & conceded in ${(crA * 100).toFixed(0)}%.`
        );
      }
      if (hr != null && ar != null && (hr + ar) / 2 < 0.35) delta -= 7;
    } else if (leg.outcome === "No") {
      if (hr != null && ar != null) {
        notes.push(`${hn} BTTS ${h.bttsHits}/${h.sampleSize}; ${an} ${a.bttsHits}/${a.sampleSize}`);
        if (hr <= 0.35 && ar <= 0.35) delta += 5;
        if (hr >= 0.65 || ar >= 0.65) delta -= 6;
      }
    }
  }

  if (leg.marketFamily === "team:match-results") {
    const hw = h.recentMatchTotals.length
      ? h.recentGoalsFor.filter((g, i) => g > (h.recentGoalsAgainst[i] ?? -1)).length
      : 0;
    const aw = a.recentMatchTotals.length
      ? a.recentGoalsFor.filter((g, i) => g > (a.recentGoalsAgainst[i] ?? -1)).length
      : 0;
    const hN = h.sampleSize;
    const aN = a.sampleSize;
    const hGF = h.avgGoalsFor;
    const hGA = h.avgGoalsAgainst;
    const aGF = a.avgGoalsFor;
    const aGA = a.avgGoalsAgainst;
    if (hGF != null && hGA != null && aGF != null && aGA != null) {
      notes.push(
        `${hn} last-${hN}: ${fmt1(hGF)} for / ${fmt1(hGA)} against; ${an} last-${aN}: ${fmt1(aGF)} for / ${fmt1(aGA)} against`
      );
    }
    if (leg.outcome === "Home") {
      notes.push(`${hn} won ${hw}/${hN} in sample (all opponents)`);
      if (h.homeSplit.n >= 2 && h.homeSplit.avgGoalsFor != null) {
        notes.push(`${hn} at home: ${fmt1(h.homeSplit.avgGoalsFor)} for / ${fmt1(h.homeSplit.avgGoalsAgainst)} against`);
      }
      if (a.awaySplit.n >= 2 && a.awaySplit.avgGoalsAgainst != null) {
        notes.push(`${an} away conceded avg ${fmt1(a.awaySplit.avgGoalsAgainst)}`);
      }
    } else if (leg.outcome === "Away") {
      notes.push(`${an} won ${aw}/${aN} in sample (all opponents)`);
      if (a.awaySplit.n >= 2 && a.awaySplit.avgGoalsFor != null) {
        notes.push(`${an} away: ${fmt1(a.awaySplit.avgGoalsFor)} for / ${fmt1(a.awaySplit.avgGoalsAgainst)} against`);
      }
    } else if (leg.outcome === "Draw") {
      const close =
        hGF != null &&
        hGA != null &&
        aGF != null &&
        aGA != null &&
        Math.abs(hGF - hGA) < 0.35 &&
        Math.abs(aGF - aGA) < 0.35;
      if (close) delta += 3;
      notes.push(`recent goal profiles ${close ? "similarly balanced" : "mixed"} — match result is volatile`);
    }
  }

  // Light H2H reinforcement only when form already used (avoid double-counting as sole signal)
  if (h2h && (h2h.sampleSize ?? 0) >= MIN_H2H_FOR_SOLO_SUPPORT) {
    if (leg.marketFamily === "team:match-goals" || leg.marketFamily === "team:alternative-total-goals") {
      const ag = h2h.averageTotalGoals;
      if (ag != null && Number.isFinite(leg.line)) {
        if (leg.outcome === "Over" && ag > leg.line + 0.25) {
          delta += 2;
          notes.push(`H2H avg ${fmt1(ag)} goals (${h2h.sampleSize} meetings) supports higher totals`);
        }
        if (leg.outcome === "Under" && ag < leg.line - 0.25) {
          delta += 2;
          notes.push(`H2H avg ${fmt1(ag)} goals (${h2h.sampleSize} meetings) supports lower totals`);
        }
      }
    }
    if (leg.marketFamily === "team:btts" && h2h.bttsRate != null) {
      notes.push(`H2H BTTS rate ${(h2h.bttsRate * 100).toFixed(0)}% (${h2h.bttsSampleSize ?? h2h.sampleSize} games)`);
    }
  }

  if (delta !== 0) {
    leg.score = Math.max(0, leg.score + delta);
  }
  if (notes.length > 0) {
    const block = notes.join("; ");
    leg.reason = leg.reason?.trim() ? `${leg.reason}; ${block}` : block;
  }

  if (import.meta.env?.DEV) {
    console.log("[team-prop reasoning]", {
      marketFamily: leg.marketFamily,
      outcome: leg.outcome,
      line:
        leg.marketFamily === "team:match-goals" || leg.marketFamily === "team:alternative-total-goals"
          ? leg.line
          : undefined,
      blendedExpectedTotal: exp,
      scoreAfter: leg.score,
      delta,
      homeSample: h.sampleSize,
      awaySample: a.sampleSize,
      included: true,
    });
  }
}

/** When H2H was used but recent league form is thin, down-rank (still allowed if H2H sample is strong). */
export function applyThinRecentFormPenalty(
  leg: TeamLegReasoningTarget,
  form: FixtureTeamFormContext | null | undefined,
  h2hWasApplied: boolean
): void {
  if (!h2hWasApplied || leg.type !== "team") return;
  if (isFormContextStrong(form)) return;
  leg.score = Math.max(0, leg.score - 5);
  const note =
    "Down-ranked: fewer than 3 recent scored games per side in league — leaning mainly on H2H.";
  leg.reason = leg.reason?.trim() ? `${leg.reason}; ${note}` : note;
}

export function logTeamLegExclusion(leg: Pick<TeamLegReasoningTarget, "marketFamily" | "label">, reason: string): void {
  if (import.meta.env?.DEV) {
    console.log("[team-prop reasoning]", {
      marketFamily: leg.marketFamily,
      label: leg.label,
      included: false,
      exclusionReason: reason,
    });
  }
}

/**
 * Evidence-first explanation lines (no ✍️ header). Caller supplies team names.
 */
function isWeakOrPlaceholderReasonText(r: string): boolean {
  const x = (r ?? "").toLowerCase();
  return (
    x.includes("limited data available") ||
    x.includes("common total-goals line") ||
    x.includes("reasonable total-goals line") ||
    x.includes("fixture corners projection supports") ||
    x.includes("team market leg") ||
    x.includes("line sits close to model expectation")
  );
}

/** Max lines shown for team prop “Why this build” copy (display-only). */
export const MAX_TEAM_PROP_EXPLANATION_LINES = 3;

const STRUCTURED_TEAM_MARKETS = new Set([
  "team:match-goals",
  "team:alternative-total-goals",
  "team:btts",
  "team:match-results",
]);

function pct0(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${Math.round(x * 100)}%`;
}

function capUniqueLines(parts: Array<string | null | undefined>, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of parts) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Merge match-total average + venue-weighted expectation into one primary line. */
function primaryTotalGoalsLine(
  h: FixtureTeamFormContext["home"],
  a: FixtureTeamFormContext["away"],
  exp: number | null
): string | null {
  const combinedAvg =
    h.avgMatchTotalGoals != null && a.avgMatchTotalGoals != null
      ? (h.avgMatchTotalGoals + a.avgMatchTotalGoals) / 2
      : null;
  const n = `${h.sampleSize}+${a.sampleSize}`;
  if (combinedAvg != null && exp != null) {
    const d = Math.abs(combinedAvg - exp);
    if (d < 0.2) {
      return `Avg total goals ~${fmt1(combinedAvg)} (last ${n})`;
    }
    return `Avg total goals ~${fmt1(combinedAvg)} (last ${n}); venue-weighted ~${fmt1(exp)}`;
  }
  if (combinedAvg != null) {
    return `Avg total goals ~${fmt1(combinedAvg)} (last ${n})`;
  }
  if (exp != null) {
    return `Expected total goals ~${fmt1(exp)} (last ${n}, home/away-weighted)`;
  }
  return null;
}

function hitRateTotalsLine(
  leg: TeamLegReasoningTarget,
  h: FixtureTeamFormContext["home"],
  a: FixtureTeamFormContext["away"],
  hn: string,
  an: string
): string | null {
  if (!Number.isFinite(leg.line)) return null;
  const line = leg.line;
  const hN = h.recentMatchTotals.length;
  const aN = a.recentMatchTotals.length;
  if (hN <= 0 || aN <= 0) return null;
  if (leg.outcome === "Over") {
    const hc = countOverUnder(h.recentMatchTotals, line, true);
    const ac = countOverUnder(a.recentMatchTotals, line, true);
    return `${hc}/${hN} ${hn} & ${ac}/${aN} ${an} over ${line}`;
  }
  if (leg.outcome === "Under") {
    const hc = countOverUnder(h.recentMatchTotals, line, false);
    const ac = countOverUnder(a.recentMatchTotals, line, false);
    return `${hc}/${hN} ${hn} & ${ac}/${aN} ${an} under ${line}`;
  }
  return null;
}

function h2hTotalsOneLine(leg: TeamLegReasoningTarget, h2h: HeadToHeadFixtureContext): string | null {
  if ((h2h.sampleSize ?? 0) < MIN_H2H_FOR_SOLO_SUPPORT || !Number.isFinite(leg.line)) return null;
  const ag = h2h.averageTotalGoals;
  const bits: string[] = [];
  if (ag != null) bits.push(`~${fmt1(ag)} avg`);
  const r = Array.isArray(h2h.recentTotalGoals) ? h2h.recentTotalGoals.slice(0, 5) : [];
  if (r.length > 0) {
    const line = leg.line;
    const oh = r.filter((t) => t > line - EPS).length;
    const ou = r.filter((t) => t < line - EPS).length;
    if (leg.outcome === "Over") bits.push(`${oh}/${r.length} over ${line} in last H2H`);
    else if (leg.outcome === "Under") bits.push(`${ou}/${r.length} under ${line} in last H2H`);
    else bits.push(`${oh}/${r.length} over ${line} (last H2H)`);
  }
  if (bits.length === 0) return null;
  return `H2H (${h2h.sampleSize}): ${bits.join("; ")}`;
}

function primaryNumberFromLine(line: string): number | null {
  const m = line.match(/~([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  const v = parseFloat(m[1]!);
  return Number.isFinite(v) ? v : null;
}

function redundantH2hAvg(primaryLine: string | null, ag: number | null): boolean {
  if (primaryLine == null || ag == null) return false;
  const p = primaryNumberFromLine(primaryLine);
  return p != null && Math.abs(p - ag) < 0.2;
}

function venueSplitSupportLine(
  leg: TeamLegReasoningTarget,
  h: FixtureTeamFormContext["home"],
  a: FixtureTeamFormContext["away"]
): string | null {
  if (!Number.isFinite(leg.line)) return null;
  const line = leg.line;
  if (h.homeSplit.n < 2 || a.awaySplit.n < 2) return null;
  const hf = h.homeSplit.avgGoalsFor;
  const aa = a.awaySplit.avgGoalsAgainst;
  if (hf == null || aa == null) return null;
  const cross = hf + aa;
  if (leg.outcome === "Over" && cross > line + 0.35) {
    return "Home/away splits support a higher-total game.";
  }
  if (leg.outcome === "Under" && cross < line - 0.35) {
    return "Home/away splits support a lower-total game.";
  }
  return null;
}

function tertiaryTotalsLine(
  leg: TeamLegReasoningTarget,
  form: FixtureTeamFormContext,
  h2h: HeadToHeadFixtureContext | null | undefined,
  primaryLine: string | null
): string | null {
  const h = form.home;
  const a = form.away;
  const h2hLine = h2h ? h2hTotalsOneLine(leg, h2h) : null;
  const ag = h2h?.averageTotalGoals ?? null;
  if (h2hLine && !redundantH2hAvg(primaryLine, ag)) {
    return h2hLine;
  }
  return venueSplitSupportLine(leg, h, a);
}

function buildCompressedTotalGoalsLines(
  leg: TeamLegReasoningTarget,
  form: FixtureTeamFormContext,
  h2h: HeadToHeadFixtureContext | null | undefined,
  hn: string,
  an: string
): string[] {
  const exp = blendedExpectedTotalGoals(form);
  const h = form.home;
  const a = form.away;
  const primary = primaryTotalGoalsLine(h, a, exp);
  const hit = hitRateTotalsLine(leg, h, a, hn, an);
  const tertiary = tertiaryTotalsLine(leg, form, h2h, primary);
  return capUniqueLines([primary, hit, tertiary], MAX_TEAM_PROP_EXPLANATION_LINES);
}

function buildCompressedBttsLines(
  form: FixtureTeamFormContext,
  h2h: HeadToHeadFixtureContext | null | undefined,
  hn: string,
  an: string
): string[] {
  const h = form.home;
  const a = form.away;
  const l1 = `BTTS hit ${h.bttsHits}/${h.sampleSize} (${hn}) & ${a.bttsHits}/${a.sampleSize} (${an})`;
  const sr = h.scoredInRate;
  const cr = h.concededInRate;
  const srA = a.scoredInRate;
  const crA = a.concededInRate;
  let l2: string | null = null;
  if (sr != null && cr != null && srA != null && crA != null) {
    l2 = `Scored/conceded rates: ${hn} ${pct0(sr)}/${pct0(cr)} · ${an} ${pct0(srA)}/${pct0(crA)}`;
  }
  let l3: string | null = null;
  if (h2h && (h2h.sampleSize ?? 0) >= MIN_H2H_FOR_SOLO_SUPPORT && h2h.bttsRate != null) {
    const n = h2h.bttsSampleSize ?? h2h.sampleSize;
    l3 = `H2H BTTS ${pct0(h2h.bttsRate)} (${n} games)`;
  }
  return capUniqueLines([l1, l2, l3], MAX_TEAM_PROP_EXPLANATION_LINES);
}

function buildCompressedMatchResultLines(
  leg: TeamLegReasoningTarget,
  form: FixtureTeamFormContext,
  h2h: HeadToHeadFixtureContext | null | undefined,
  hn: string,
  an: string
): string[] {
  const h = form.home;
  const a = form.away;
  const hGF = h.avgGoalsFor;
  const hGA = h.avgGoalsAgainst;
  const aGF = a.avgGoalsFor;
  const aGA = a.avgGoalsAgainst;
  const l1 =
    hGF != null && hGA != null && aGF != null && aGA != null
      ? `Goals: ${hn} ${fmt1(hGF)}–${fmt1(hGA)}, ${an} ${fmt1(aGF)}–${fmt1(aGA)} (last ${h.sampleSize}+${a.sampleSize})`
      : null;

  const hN = h.sampleSize;
  const aN = a.sampleSize;
  const hw = h.recentMatchTotals.length
    ? h.recentGoalsFor.filter((g, i) => g > (h.recentGoalsAgainst[i] ?? -1)).length
    : 0;
  const aw = a.recentMatchTotals.length
    ? a.recentGoalsFor.filter((g, i) => g > (a.recentGoalsAgainst[i] ?? -1)).length
    : 0;

  let l2: string | null = null;
  if (leg.outcome === "Home") {
    const bits: string[] = [`${hn} won ${hw}/${hN} in sample`];
    if (h.homeSplit.n >= 2 && h.homeSplit.avgGoalsFor != null) {
      bits.push(`home ~${fmt1(h.homeSplit.avgGoalsFor)} for`);
    }
    l2 = bits.join("; ");
  } else if (leg.outcome === "Away") {
    const bits: string[] = [`${an} won ${aw}/${aN} in sample`];
    if (a.awaySplit.n >= 2 && a.awaySplit.avgGoalsFor != null) {
      bits.push(`away ~${fmt1(a.awaySplit.avgGoalsFor)} for`);
    }
    l2 = bits.join("; ");
  } else if (leg.outcome === "Draw") {
    l2 = "Draw: recent profiles balanced — result still volatile.";
  }

  let l3: string | null = null;
  if (h2h && (h2h.sampleSize ?? 0) >= MIN_H2H_FOR_SOLO_SUPPORT) {
    const n = h2h.resultSampleSize ?? h2h.sampleSize;
    l3 = `H2H: ${hn} ${h2h.team1WinCount ?? "—"}/${n} · D ${h2h.drawCount ?? "—"} · ${an} ${h2h.team2WinCount ?? "—"}/${n}`;
  }

  return capUniqueLines([l1, l2, l3], MAX_TEAM_PROP_EXPLANATION_LINES);
}

function cautionLineFromLegReason(reason: string | null | undefined): string | null {
  const r = reason?.trim() ?? "";
  if (r.includes("Down-ranked")) {
    return "Down-ranked: thin league form vs H2H-heavy read.";
  }
  return null;
}

export function buildTeamPropExplanationLines(
  leg: TeamLegReasoningTarget,
  form: FixtureTeamFormContext | null | undefined,
  h2h: HeadToHeadFixtureContext | null | undefined,
  names: { home: string; away: string }
): string[] {
  const hn = names.home.trim() || "Home";
  const an = names.away.trim() || "Away";

  if (!STRUCTURED_TEAM_MARKETS.has(leg.marketFamily)) {
    const r = leg.reason?.trim();
    const fromReason =
      r && r.length >= 12 && !isWeakOrPlaceholderReasonText(r) ? [r] : ([] as string[]);
    return capUniqueLines(fromReason, MAX_TEAM_PROP_EXPLANATION_LINES);
  }

  if (isFormContextStrong(form) && leg.marketFamily !== "team:alternative-corners") {
    const ctx = form!;
    if (leg.marketFamily === "team:match-goals" || leg.marketFamily === "team:alternative-total-goals") {
      return buildCompressedTotalGoalsLines(leg, ctx, h2h, hn, an);
    }
    if (leg.marketFamily === "team:btts") {
      return buildCompressedBttsLines(ctx, h2h, hn, an);
    }
    if (leg.marketFamily === "team:match-results") {
      return buildCompressedMatchResultLines(leg, ctx, h2h, hn, an);
    }
  }

  const thin =
    !form?.fetchFailed && (form?.home.sampleSize ?? 0) + (form?.away.sampleSize ?? 0) > 0
      ? `Thin form (${form?.home.sampleSize ?? 0}+${form?.away.sampleSize ?? 0} games) — cautious on team markets.`
      : null;
  const fetchFail = form?.fetchFailed ? "Recent league form unavailable — other signals only." : null;
  const caution = cautionLineFromLegReason(leg.reason);

  const weakHead = capUniqueLines([thin, fetchFail, caution], 2);

  const weakTail: string[] = [];
  if (h2h && (h2h.sampleSize ?? 0) >= MIN_H2H_FOR_SOLO_SUPPORT) {
    if (leg.marketFamily === "team:match-goals" || leg.marketFamily === "team:alternative-total-goals") {
      const one = h2hTotalsOneLine(leg, h2h);
      if (one) weakTail.push(one);
    } else if (leg.marketFamily === "team:btts" && h2h.bttsRate != null) {
      const n = h2h.bttsSampleSize ?? h2h.sampleSize;
      weakTail.push(`H2H BTTS ${pct0(h2h.bttsRate)} (${n} games)`);
    } else if (leg.marketFamily === "team:match-results") {
      const n = h2h.resultSampleSize ?? h2h.sampleSize;
      weakTail.push(
        `H2H: ${hn} ${h2h.team1WinCount ?? "—"}/${n} · D ${h2h.drawCount ?? "—"} · ${an} ${h2h.team2WinCount ?? "—"}/${n}`
      );
    }
  }

  return capUniqueLines([...weakHead, ...weakTail], MAX_TEAM_PROP_EXPLANATION_LINES);
}
