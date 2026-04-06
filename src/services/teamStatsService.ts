import type { TeamSeasonGoalLineStats } from "../types/teamSeasonStats.js";

function getApiOrigin(): string {
  const base = typeof import.meta.env !== "undefined" && import.meta.env?.VITE_API_ORIGIN;
  return typeof base === "string" && base !== "" ? base.replace(/\/$/, "") : "";
}

function getTeamStatsApiUrl(teamId: number, seasonId?: number): string {
  const origin = getApiOrigin();
  const params = new URLSearchParams();
  if (seasonId != null && Number.isFinite(seasonId)) {
    params.set("seasonId", String(seasonId));
  }
  const query = params.toString();
  return `${origin}/api/teams/${teamId}/stats${query ? `?${query}` : ""}`;
}

export async function loadTeamSeasonGoalLineStats(
  teamId: number,
  seasonId?: number
): Promise<TeamSeasonGoalLineStats | null> {
  const url = getTeamStatsApiUrl(teamId, seasonId);
  if (import.meta.env.DEV) {
    console.log("[team-stats] frontend request", { teamId, seasonId, url });
  }
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: TeamSeasonGoalLineStats };
    const data = (json?.data ?? json) as TeamSeasonGoalLineStats;
    if (!data || !Array.isArray(data.goalLineStats)) return null;
    return data;
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[team-stats] frontend fetch failed", { teamId, seasonId, errorMessage: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }
}
