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
  if (leg.type !== "team") return;
  const useForm = isFormContextStrong(form);

  const hn = names.home.trim() || "Home";
  const an = names.away.trim() || "Away";
  let delta = 0;
  const notes: string[] = [];

  const exp = useForm ? blendedExpectedTotalGoals(form!) : null;
  const h = useForm ? form!.home : null;
  const a = useForm ? form!.away : null;

  if (
    useForm &&
    (leg.marketFamily === "team:match-goals" || leg.marketFamily === "team:alternative-total-goals") &&
    Number.isFinite(leg.line)
  ) {
    const line = leg.line;
    const hOver = countOverUnder(h!.recentMatchTotals, line, true);
    const aOver = countOverUnder(a!.recentMatchTotals, line, true);
    const hN = h!.recentMatchTotals.length;
    const aN = a!.recentMatchTotals.length;

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
      const hUnder = countOverUnder(h!.recentMatchTotals, line, false);
      const aUnder = countOverUnder(a!.recentMatchTotals, line, false);
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

  if (useForm && leg.marketFamily === "team:btts") {
    const hr = h!.bttsRate;
    const ar = a!.bttsRate;
    const sr = h!.scoredInRate;
    const cr = h!.concededInRate;
    const srA = a!.scoredInRate;
    const crA = a!.concededInRate;
    if (leg.outcome === "Yes") {
      if (hr != null && ar != null) {
        const bothHigh = hr >= 0.5 && ar >= 0.5;
        if (bothHigh) delta += 5;
        notes.push(`${hn} BTTS in ${h!.bttsHits}/${h!.sampleSize} recent; ${an} in ${a!.bttsHits}/${a!.sampleSize}`);
      }
      if (sr != null && cr != null && srA != null && crA != null) {
        notes.push(
          `${hn} scored in ${(sr * 100).toFixed(0)}% & conceded in ${(cr * 100).toFixed(0)}% of recent; ${an} scored in ${(srA * 100).toFixed(0)}% & conceded in ${(crA * 100).toFixed(0)}%.`
        );
      }
      if (hr != null && ar != null && (hr + ar) / 2 < 0.35) delta -= 7;
    } else if (leg.outcome === "No") {
      if (hr != null && ar != null) {
        notes.push(`${hn} BTTS ${h!.bttsHits}/${h!.sampleSize}; ${an} ${a!.bttsHits}/${a!.sampleSize}`);
        if (hr <= 0.35 && ar <= 0.35) delta += 5;
        if (hr >= 0.65 || ar >= 0.65) delta -= 6;
      }
    }
  }

  if (useForm && leg.marketFamily === "team:match-results") {
    const hw = h!.recentMatchTotals.length
      ? h!.recentGoalsFor.filter((g, i) => g > (h!.recentGoalsAgainst[i] ?? -1)).length
      : 0;
    const aw = a!.recentMatchTotals.length
      ? a!.recentGoalsFor.filter((g, i) => g > (a!.recentGoalsAgainst[i] ?? -1)).length
      : 0;
    const hN = h!.sampleSize;
    const aN = a!.sampleSize;
    const hGF = h!.avgGoalsFor;
    const hGA = h!.avgGoalsAgainst;
    const aGF = a!.avgGoalsFor;
    const aGA = a!.avgGoalsAgainst;
    if (hGF != null && hGA != null && aGF != null && aGA != null) {
      notes.push(
        `${hn} last-${hN}: ${fmt1(hGF)} for / ${fmt1(hGA)} against; ${an} last-${aN}: ${fmt1(aGF)} for / ${fmt1(aGA)} against`
      );
    }
    if (leg.outcome === "Home") {
      notes.push(`${hn} won ${hw}/${hN} in sample (all opponents)`);
      if (h!.homeSplit.n >= 2 && h!.homeSplit.avgGoalsFor != null) {
        notes.push(`${hn} at home: ${fmt1(h!.homeSplit.avgGoalsFor)} for / ${fmt1(h!.homeSplit.avgGoalsAgainst)} against`);
      }
      if (a!.awaySplit.n >= 2 && a!.awaySplit.avgGoalsAgainst != null) {
        notes.push(`${an} away conceded avg ${fmt1(a!.awaySplit.avgGoalsAgainst)}`);
      }
    } else if (leg.outcome === "Away") {
      notes.push(`${an} won ${aw}/${aN} in sample (all opponents)`);
      if (a!.awaySplit.n >= 2 && a!.awaySplit.avgGoalsFor != null) {
        notes.push(`${an} away: ${fmt1(a!.awaySplit.avgGoalsFor)} for / ${fmt1(a!.awaySplit.avgGoalsAgainst)} against`);
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
      const line = leg.line;
      if (ag != null && Number.isFinite(line)) {
        if (leg.outcome === "Over" && ag > line + 0.25) {
          delta += 5;
          notes.push(`H2H avg ${fmt1(ag)} goals (${h2h.sampleSize} meetings) supports higher totals`);
        }
        if (leg.outcome === "Under" && ag < line - 0.25) {
          delta += 5;
          notes.push(`H2H avg ${fmt1(ag)} goals (${h2h.sampleSize} meetings) supports lower totals`);
        }
      }
      if (Number.isFinite(line) && Array.isArray(h2h.goalsLineCounts)) {
        const row = h2h.goalsLineCounts.find((r) => Math.abs(r.line - line) < EPS);
        if (row && row.sampleSize > 0) {
          const overRate = row.over / row.sampleSize;
          const underRate = row.under / row.sampleSize;
          if (leg.outcome === "Over") {
            notes.push(`H2H ${row.over}/${row.sampleSize} over ${line}`);
            if (overRate >= 0.65) delta += 4;
            else if (overRate <= 0.35) delta -= 4;
          }
          if (leg.outcome === "Under") {
            notes.push(`H2H ${row.under}/${row.sampleSize} under ${line}`);
            if (underRate >= 0.65) delta += 4;
            else if (underRate <= 0.35) delta -= 4;
          }
        }
      }
    }
    if (leg.marketFamily === "team:btts" && h2h.bttsRate != null) {
      notes.push(`H2H BTTS rate ${(h2h.bttsRate * 100).toFixed(0)}% (${h2h.bttsSampleSize ?? h2h.sampleSize} games)`);
      if (leg.outcome === "Yes" && h2h.bttsRate >= 0.6) delta += 4;
      if (leg.outcome === "No" && h2h.bttsRate <= 0.45) delta += 4;
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
  leg.score = Math.max(0, leg.score - 2);
  const note =
    "Recent league form sample thin — leaning mainly on H2H.";
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

/** H2H samples with fewer meetings are still shown (no “limited sample” wording). */
const H2H_STRONG_MIN_N = 3;

/**
 * Intended line patterns (display):
 * - Avg total goals ~2.5 (last 5 matches each)
 * - 4/5 Como & 3/5 Pisa over 1.5
 * - H2H (5): ~2.8 avg, 4/5 over 1.5
 * - H2H (2): 1/2 over 1.5
 * (Never emit a bare `H2H (n)` with no stat.)
 */

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

/** Human-readable scope for recent league form (replaces “5+5” shorthand). */
function recentFormScopePhrase(
  h: FixtureTeamFormContext["home"],
  a: FixtureTeamFormContext["away"],
  hn: string,
  an: string
): string {
  const hs = h.sampleSize;
  const as = a.sampleSize;
  if (hs > 0 && as > 0 && hs === as) {
    return `last ${hs} matches each`;
  }
  if (hs > 0 && as > 0) {
    return `last ${hs} for ${hn}, ${as} for ${an}`;
  }
  if (hs > 0) return `last ${hs} for ${hn}`;
  if (as > 0) return `last ${as} for ${an}`;
  return "recent matches";
}

function hasH2hData(h2h: HeadToHeadFixtureContext | null | undefined): boolean {
  return Boolean(h2h && (h2h.sampleSize ?? 0) > 0);
}

/**
 * Keep ≤2 non-H2H lines, then append one H2H line when present (line 3), still max 3 overall.
 */
function mergeWithReservedH2h(
  orderedNonH2h: Array<string | null | undefined>,
  h2hLine: string | null
): string[] {
  const non: string[] = [];
  const seen = new Set<string>();
  for (const raw of orderedNonH2h) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!s || seen.has(s)) continue;
    seen.add(s);
    non.push(s);
  }
  const h2hTrim = h2hLine?.trim() ?? "";
  if (!h2hTrim) {
    return capUniqueLines(non, MAX_TEAM_PROP_EXPLANATION_LINES);
  }
  const head = non.slice(0, 2);
  return capUniqueLines([...head, h2hTrim], MAX_TEAM_PROP_EXPLANATION_LINES);
}

/** Merge match-total average + venue-weighted expectation into one primary line. */
function primaryTotalGoalsLine(
  h: FixtureTeamFormContext["home"],
  a: FixtureTeamFormContext["away"],
  exp: number | null,
  hn: string,
  an: string
): string | null {
  const scope = recentFormScopePhrase(h, a, hn, an);
  const combinedAvg =
    h.avgMatchTotalGoals != null && a.avgMatchTotalGoals != null
      ? (h.avgMatchTotalGoals + a.avgMatchTotalGoals) / 2
      : null;
  if (combinedAvg != null && exp != null) {
    const d = Math.abs(combinedAvg - exp);
    if (d < 0.2) {
      return `Avg total goals ~${fmt1(combinedAvg)} (${scope})`;
    }
    return `Avg total goals ~${fmt1(combinedAvg)} (${scope}); venue-weighted ~${fmt1(exp)}`;
  }
  if (combinedAvg != null) {
    return `Avg total goals ~${fmt1(combinedAvg)} (${scope})`;
  }
  if (exp != null) {
    return `Expected total goals ~${fmt1(exp)} (${scope}, venue-weighted)`;
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

/** O/U hit rate from H2H aggregates when recent totals array is missing. */
function h2hGoalsLineRatePart(
  h2h: HeadToHeadFixtureContext,
  lineVal: number,
  outcome: string
): string | null {
  const rows = h2h.goalsLineCounts;
  if (!Array.isArray(rows) || !Number.isFinite(lineVal)) return null;
  const row = rows.find((x) => Math.abs(x.line - lineVal) < EPS);
  if (!row || row.sampleSize <= 0) return null;
  if (outcome === "Over") return `${row.over}/${row.sampleSize} over ${lineVal}`;
  if (outcome === "Under") return `${row.under}/${row.sampleSize} under ${lineVal}`;
  return `${row.over}/${row.sampleSize} over ${lineVal}`;
}

/**
 * One H2H line for total-goals markets. Never returns a bare `H2H (n)` — needs avg and/or O-U rate from real data.
 */
function formatH2hTotalsLine(leg: TeamLegReasoningTarget, h2h: HeadToHeadFixtureContext): string | null {
  const n = h2h.sampleSize ?? 0;
  if (n <= 0) return null;
  const weak = n < H2H_STRONG_MIN_N;
  const ag = h2h.averageTotalGoals;
  const r = Array.isArray(h2h.recentTotalGoals) ? h2h.recentTotalGoals.slice(0, 5) : [];
  const lineVal = leg.line;
  const hasLine = Number.isFinite(lineVal);

  let ratePart: string | null = null;
  if (hasLine && r.length > 0) {
    const oh = r.filter((t) => t > lineVal - EPS).length;
    const ou = r.filter((t) => t < lineVal - EPS).length;
    if (leg.outcome === "Over") ratePart = `${oh}/${r.length} over ${lineVal}`;
    else if (leg.outcome === "Under") ratePart = `${ou}/${r.length} under ${lineVal}`;
    else ratePart = `${oh}/${r.length} over ${lineVal}`;
  }
  if (ratePart == null && hasLine) {
    ratePart = h2hGoalsLineRatePart(h2h, lineVal, leg.outcome);
  }

  const hasStat = ag != null || ratePart != null;
  if (!hasStat) return null;

  if (weak) {
    if (ag != null && ratePart) {
      return `H2H (${n}): ~${fmt1(ag)} avg, ${ratePart}`;
    }
    if (ratePart) {
      return `H2H (${n}): ${ratePart}`;
    }
    if (ag != null) {
      return `H2H (${n}): ~${fmt1(ag)} avg goals`;
    }
    return null;
  }

  if (ag != null && ratePart) {
    return `H2H (${n}): ~${fmt1(ag)} avg, ${ratePart}`;
  }
  if (ratePart) {
    return `H2H (${n}): ${ratePart}`;
  }
  if (ag != null) {
    return `H2H (${n}): ~${fmt1(ag)} avg goals`;
  }
  return null;
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
  const primary = primaryTotalGoalsLine(h, a, exp, hn, an);
  const hit = hitRateTotalsLine(leg, h, a, hn, an);
  const venue = venueSplitSupportLine(leg, h, a);
  const h2hLine = hasH2hData(h2h) ? formatH2hTotalsLine(leg, h2h!) : null;
  return mergeWithReservedH2h([primary, hit, venue], h2hLine);
}

/** Needs yes/count or BTTS rate — never a bare `H2H (n)`. */
function formatH2hBttsLine(h2h: HeadToHeadFixtureContext): string | null {
  const n = h2h.sampleSize ?? 0;
  if (n <= 0) return null;
  const weak = n < H2H_STRONG_MIN_N;
  const denom = h2h.bttsSampleSize ?? 0;
  const yes = h2h.bttsYesCount;
  if (yes != null && typeof yes === "number" && denom > 0) {
    if (weak) {
      return `H2H (${n}): ${yes}/${denom} BTTS`;
    }
    return `H2H (${n}): ${yes}/${denom} BTTS`;
  }
  if (h2h.bttsRate != null && Number.isFinite(h2h.bttsRate)) {
    if (weak) {
      return `H2H (${n}): ${pct0(h2h.bttsRate)} BTTS rate`;
    }
    return `H2H (${n}): ${pct0(h2h.bttsRate)} BTTS rate`;
  }
  return null;
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
  const h2hLine = hasH2hData(h2h) ? formatH2hBttsLine(h2h!) : null;
  return mergeWithReservedH2h([l1, l2], h2hLine);
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
  const scope = recentFormScopePhrase(h, a, hn, an);
  const l1 =
    hGF != null && hGA != null && aGF != null && aGA != null
      ? `Goals: ${hn} ${fmt1(hGF)}–${fmt1(hGA)}, ${an} ${fmt1(aGF)}–${fmt1(aGA)} (${scope})`
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

  const h2hLine = hasH2hData(h2h) ? formatH2hResultsLine(h2h!, hn, an) : null;
  return mergeWithReservedH2h([l1, l2], h2hLine);
}

/** W/D/L counts or win/draw/loss rates — never `—` placeholders only, never bare `H2H (n)`. */
function formatH2hResultsLine(h2h: HeadToHeadFixtureContext, hn: string, an: string): string | null {
  let n = h2h.resultSampleSize ?? 0;
  if (n <= 0) n = h2h.sampleSize ?? 0;
  if (n <= 0) return null;
  const weak = n < H2H_STRONG_MIN_N;

  const w1 = h2h.team1WinCount;
  const w2 = h2h.team2WinCount;
  const dr = h2h.drawCount;
  const haveAllCounts =
    typeof w1 === "number" && typeof w2 === "number" && typeof dr === "number";

  const r1 = h2h.team1WinRate;
  const rd = h2h.drawRate;
  const r2 = h2h.team2WinRate;
  const rs = h2h.resultSampleSize ?? 0;
  const haveRates =
    r1 != null &&
    rd != null &&
    r2 != null &&
    Number.isFinite(r1) &&
    Number.isFinite(rd) &&
    Number.isFinite(r2) &&
    rs > 0;

  let body: string | null = null;
  if (haveAllCounts) {
    body = `${hn} ${w1}, Draw ${dr}, ${an} ${w2}`;
  } else if (haveRates) {
    body = `${hn} ${pct0(r1)}, Draw ${pct0(rd)}, ${an} ${pct0(r2)} (${rs} with results)`;
  }

  if (body == null) return null;

  if (weak) {
    return `H2H (${n}): ${body}`;
  }
  return `H2H (${n}): ${body}`;
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
    form && !form.fetchFailed && (form.home.sampleSize ?? 0) + (form.away.sampleSize ?? 0) > 0
      ? `Thin form (${recentFormScopePhrase(form.home, form.away, hn, an)}) — cautious on team markets.`
      : null;
  const fetchFail = form?.fetchFailed ? "Recent league form unavailable — other signals only." : null;
  const caution = cautionLineFromLegReason(leg.reason);

  const h2hLineWeak = ((): string | null => {
    if (!hasH2hData(h2h)) return null;
    if (leg.marketFamily === "team:match-goals" || leg.marketFamily === "team:alternative-total-goals") {
      return formatH2hTotalsLine(leg, h2h!);
    }
    if (leg.marketFamily === "team:btts") {
      return formatH2hBttsLine(h2h!);
    }
    if (leg.marketFamily === "team:match-results") {
      return formatH2hResultsLine(h2h!, hn, an);
    }
    return null;
  })();

  return mergeWithReservedH2h([thin, fetchFail, caution], h2hLineWeak);
}
