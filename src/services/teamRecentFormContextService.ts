import type { FixtureTeamFormContext, TeamSideRecentForm } from "../types/teamRecentFormContext.js";

export interface TeamRecentFormContextResponse {
  homeTeamId: number;
  awayTeamId: number;
  context: FixtureTeamFormContext;
}

function emptySide(teamId: number, name?: string): TeamSideRecentForm {
  return {
    teamId,
    teamName: name,
    sampleSize: 0,
    weakSample: true,
    avgMatchTotalGoals: null,
    avgGoalsFor: null,
    avgGoalsAgainst: null,
    bttsRate: null,
    bttsHits: 0,
    scoredInRate: null,
    concededInRate: null,
    homeSplit: { n: 0, avgGoalsFor: null, avgGoalsAgainst: null, avgMatchTotalGoals: null },
    awaySplit: { n: 0, avgGoalsFor: null, avgGoalsAgainst: null, avgMatchTotalGoals: null },
    recentMatchTotals: [],
    recentGoalsFor: [],
    recentGoalsAgainst: [],
  };
}

function failedContext(
  homeTeamId: number,
  awayTeamId: number,
  options?: { homeTeamName?: string; awayTeamName?: string }
): FixtureTeamFormContext {
  return {
    homeTeamId,
    awayTeamId,
    homeTeamName: options?.homeTeamName,
    awayTeamName: options?.awayTeamName,
    fetchFailed: true,
    home: emptySide(homeTeamId, options?.homeTeamName),
    away: emptySide(awayTeamId, options?.awayTeamName),
  };
}

function getApiOrigin(): string {
  const base =
    typeof import.meta.env !== "undefined" && import.meta.env?.VITE_API_ORIGIN;
  return typeof base === "string" && base !== "" ? base.replace(/\/$/, "") : "";
}

function buildTeamRecentFormUrl(
  homeTeamId: number,
  awayTeamId: number,
  options?: {
    excludeFixtureId?: number;
    homeTeamName?: string;
    awayTeamName?: string;
  }
): string {
  const origin = getApiOrigin();
  const q = new URLSearchParams();
  if (options?.excludeFixtureId != null && Number.isFinite(options.excludeFixtureId)) {
    q.set("excludeFixtureId", String(options.excludeFixtureId));
  }
  if (options?.homeTeamName?.trim()) q.set("homeTeamName", options.homeTeamName.trim());
  if (options?.awayTeamName?.trim()) q.set("awayTeamName", options.awayTeamName.trim());
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return `${origin}/api/team-recent-form/${homeTeamId}/${awayTeamId}${suffix}`;
}

/**
 * Recent league form for both sides (all opponents). Excluding the current fixture avoids
 * double-counting the upcoming match in recent samples.
 */
export async function loadFixtureTeamFormContext(
  homeTeamId: number,
  awayTeamId: number,
  options?: {
    excludeFixtureId?: number;
    homeTeamName?: string;
    awayTeamName?: string;
  }
): Promise<TeamRecentFormContextResponse> {
  const url = buildTeamRecentFormUrl(homeTeamId, awayTeamId, options);
  if (import.meta.env.DEV) {
    console.log("[team-form] frontend request", { homeTeamId, awayTeamId, url });
  }
  try {
    const res = await fetch(url);
    const json = (await res.json()) as { data?: TeamRecentFormContextResponse };
    const data = (json?.data ?? json) as TeamRecentFormContextResponse;
    const context = data?.context;
    const safe: TeamRecentFormContextResponse = {
      homeTeamId: typeof data?.homeTeamId === "number" ? data.homeTeamId : homeTeamId,
      awayTeamId: typeof data?.awayTeamId === "number" ? data.awayTeamId : awayTeamId,
      context: context ?? failedContext(homeTeamId, awayTeamId, options),
    };
    if (import.meta.env.DEV) {
      console.log("[team-form] frontend response", {
        homeTeamId: safe.homeTeamId,
        awayTeamId: safe.awayTeamId,
        fetchFailed: safe.context.fetchFailed,
        homeN: safe.context.home.sampleSize,
        awayN: safe.context.away.sampleSize,
      });
    }
    return safe;
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[team-form] frontend fetch failed", {
        homeTeamId,
        awayTeamId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    return {
      homeTeamId,
      awayTeamId,
      context: failedContext(homeTeamId, awayTeamId, options),
    };
  }
}
