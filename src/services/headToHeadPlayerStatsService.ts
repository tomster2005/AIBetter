export interface HeadToHeadPlayerStatRow {
  playerId: number;
  playerName: string;
  teamId?: number;
  shots?: number;
  shotsOnTarget?: number;
  foulsCommitted?: number;
  foulsWon?: number;
  tackles?: number;
}

export interface HeadToHeadPlayerStatsFixture {
  fixtureId: number;
  startingAt?: string;
  playerStats: HeadToHeadPlayerStatRow[];
}

export interface HeadToHeadPlayerStatsResponse {
  team1Id: number;
  team2Id: number;
  fixtures: HeadToHeadPlayerStatsFixture[];
}

function getApiOrigin(): string {
  const base = typeof import.meta.env !== "undefined" && import.meta.env?.VITE_API_ORIGIN;
  return typeof base === "string" && base !== "" ? base.replace(/\/$/, "") : "";
}

function getHeadToHeadPlayersApiUrl(team1Id: number, team2Id: number, params?: { limit?: number; leagueId?: number }): string {
  const origin = getApiOrigin();
  const qs = new URLSearchParams();
  if (params?.limit != null && Number.isFinite(params.limit)) qs.set("limit", String(params.limit));
  if (params?.leagueId != null && Number.isFinite(params.leagueId)) qs.set("leagueId", String(params.leagueId));
  const query = qs.toString();
  return `${origin}/api/head-to-head/${team1Id}/${team2Id}/players${query ? `?${query}` : ""}`;
}

export async function loadHeadToHeadPlayerStats(
  team1Id: number,
  team2Id: number,
  params?: { limit?: number; leagueId?: number }
): Promise<HeadToHeadPlayerStatsResponse | null> {
  const url = getHeadToHeadPlayersApiUrl(team1Id, team2Id, params);
  if (import.meta.env.DEV) {
    console.log("[h2h-player] frontend request", { team1Id, team2Id, url });
  }
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: HeadToHeadPlayerStatsResponse };
    const data = (json?.data ?? json) as HeadToHeadPlayerStatsResponse;
    if (!data || !Array.isArray(data.fixtures)) return null;
    return data;
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[h2h-player] frontend fetch failed", { team1Id, team2Id, errorMessage: err instanceof Error ? err.message : String(err) });
    }
    return null;
  }
}
