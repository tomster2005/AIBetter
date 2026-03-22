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

export function buildTeamPropExplanationLines(
  leg: TeamLegReasoningTarget,
  form: FixtureTeamFormContext | null | undefined,
  h2h: HeadToHeadFixtureContext | null | undefined,
  names: { home: string; away: string }
): string[] {
  const lines: string[] = [];
  const hn = names.home.trim() || "Home";
  const an = names.away.trim() || "Away";

  const r = leg.reason?.trim();
  if (r && r.length >= 12 && !isWeakOrPlaceholderReasonText(r)) {
    lines.push(r);
  }

  if (isFormContextStrong(form) && leg.marketFamily !== "team:alternative-corners") {
    const h = form!.home;
    const a = form!.away;
    const exp = blendedExpectedTotalGoals(form!);

    if (
      (leg.marketFamily === "team:match-goals" || leg.marketFamily === "team:alternative-total-goals") &&
      Number.isFinite(leg.line)
    ) {
      const line = leg.line;
      const combinedAvg =
        h.avgMatchTotalGoals != null && a.avgMatchTotalGoals != null
          ? (h.avgMatchTotalGoals + a.avgMatchTotalGoals) / 2
          : null;
      if (combinedAvg != null) {
        lines.push(`Combined recent match-total average ${fmt1(combinedAvg)} goals (last ${h.sampleSize} + ${a.sampleSize} games, all opponents).`);
      }
      if (exp != null) {
        lines.push(`Venue-weighted expectation ~${fmt1(exp)} total goals (attack vs defence from home/away splits where available).`);
      }
      const hOver = countOverUnder(h.recentMatchTotals, line, true);
      const aOver = countOverUnder(a.recentMatchTotals, line, true);
      const hN = h.recentMatchTotals.length;
      const aN = a.recentMatchTotals.length;
      if (hN > 0 && aN > 0) {
        lines.push(`${hOver}/${hN} ${hn} and ${aOver}/${aN} ${an} recent games went over ${line} total goals.`);
      }
    }

    if (leg.marketFamily === "team:btts") {
      lines.push(
        `${hn}: BTTS in ${h.bttsHits}/${h.sampleSize} recent; scored in ${h.scoredInRate != null ? `${(h.scoredInRate * 100).toFixed(0)}%` : "n/a"}; conceded in ${h.concededInRate != null ? `${(h.concededInRate * 100).toFixed(0)}%` : "n/a"}.`
      );
      lines.push(
        `${an}: BTTS in ${a.bttsHits}/${a.sampleSize} recent; scored in ${a.scoredInRate != null ? `${(a.scoredInRate * 100).toFixed(0)}%` : "n/a"}; conceded in ${a.concededInRate != null ? `${(a.concededInRate * 100).toFixed(0)}%` : "n/a"}.`
      );
    }

    if (leg.marketFamily === "team:match-results") {
      if (h.avgGoalsFor != null && h.avgGoalsAgainst != null) {
        lines.push(`${hn} (last ${h.sampleSize}): ${fmt1(h.avgGoalsFor)} scored / ${fmt1(h.avgGoalsAgainst)} conceded per game.`);
      }
      if (a.avgGoalsFor != null && a.avgGoalsAgainst != null) {
        lines.push(`${an} (last ${a.sampleSize}): ${fmt1(a.avgGoalsFor)} scored / ${fmt1(a.avgGoalsAgainst)} conceded per game.`);
      }
    }
  } else if (!form?.fetchFailed && (form?.home.sampleSize ?? 0) + (form?.away.sampleSize ?? 0) > 0) {
    lines.push(
      `Recent-form sample is thin (${form?.home.sampleSize ?? 0} + ${form?.away.sampleSize ?? 0} usable matches) — treat team markets cautiously.`
    );
  } else if (form?.fetchFailed) {
    lines.push("Recent league form could not be loaded; relying on other signals only.");
  }

  if (h2h && (h2h.sampleSize ?? 0) >= MIN_H2H_FOR_SOLO_SUPPORT) {
    if (leg.marketFamily === "team:match-goals" || leg.marketFamily === "team:alternative-total-goals") {
      const ag = h2h.averageTotalGoals;
      if (ag != null && Number.isFinite(leg.line)) {
        lines.push(`H2H secondary: average ${fmt1(ag)} total goals across ${h2h.sampleSize} meetings.`);
      }
      if (Array.isArray(h2h.recentTotalGoals) && h2h.recentTotalGoals.length > 0 && Number.isFinite(leg.line)) {
        const r = h2h.recentTotalGoals.slice(0, 5);
        const oh = r.filter((t) => t > leg.line - EPS).length;
        lines.push(`H2H last totals (${r.length}): ${r.join(", ")} — ${oh}/${r.length} over ${leg.line}.`);
      }
    }
    if (leg.marketFamily === "team:btts" && h2h.bttsRate != null) {
      const n = h2h.bttsSampleSize ?? h2h.sampleSize;
      lines.push(`H2H secondary: BTTS in ${h2h.bttsYesCount ?? "—"}/${n} (${(h2h.bttsRate * 100).toFixed(0)}%).`);
    }
    if (leg.marketFamily === "team:match-results") {
      const n = h2h.resultSampleSize ?? h2h.sampleSize;
      lines.push(
        `H2H secondary: ${hn} ${h2h.team1WinCount ?? "—"}/${n} wins, draws ${h2h.drawCount ?? "—"}, ${an} ${h2h.team2WinCount ?? "—"}/${n}.`
      );
    }
  }

  const dedup = [...new Set(lines.map((s) => s.trim()).filter(Boolean))];
  return dedup;
}
