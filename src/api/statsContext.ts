/**
 * Resolve a player statistics row (season_id, team_id) to human-readable names
 * for the stats source label. Uses Sportmonks season (with league) and team endpoints.
 */

const SEASONS_BASE = "https://api.sportmonks.com/v3/football/seasons";
const TEAMS_BASE = "https://api.sportmonks.com/v3/football/teams";

function getApiToken(): string {
  const token = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
  if (!token || typeof token !== "string") {
    throw new Error(
      "Missing Sportmonks API token. Set SPORTMONKS_API_TOKEN or SPORTMONKS_TOKEN in your environment."
    );
  }
  return token;
}

export interface StatsContextResult {
  seasonName: string | null;
  leagueName: string | null;
  teamName: string | null;
}

/**
 * Fetch season by id with league include. Returns season name and league/competition name.
 */
async function fetchSeasonWithLeague(seasonId: number): Promise<{ seasonName: string | null; leagueName: string | null }> {
  const token = getApiToken();
  const params = new URLSearchParams({ api_token: token, include: "league" });
  const url = `${SEASONS_BASE}/${seasonId}?${params.toString()}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) return { seasonName: null, leagueName: null };
  let data: { name?: string; league?: { name?: string; data?: { name?: string } }; League?: { name?: string } };
  try {
    const json = JSON.parse(text) as { data?: unknown };
    data = (json?.data ?? json) as typeof data;
  } catch {
    return { seasonName: null, leagueName: null };
  }
  const league = data?.league ?? data?.League;
  const leagueObj = league?.data ?? league;
  const seasonName = typeof data?.name === "string" ? data.name.trim() || null : null;
  const leagueName =
    leagueObj && typeof leagueObj.name === "string" ? leagueObj.name.trim() || null : null;
  return { seasonName, leagueName };
}

/**
 * Fetch team by id. Returns team name.
 */
async function fetchTeam(teamId: number): Promise<string | null> {
  const token = getApiToken();
  const params = new URLSearchParams({ api_token: token });
  const url = `${TEAMS_BASE}/${teamId}?${params.toString()}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) return null;
  let data: { name?: string };
  try {
    const json = JSON.parse(text) as { data?: unknown };
    data = (json?.data ?? json) as typeof data;
  } catch {
    return null;
  }
  return typeof data?.name === "string" ? data.name.trim() || null : null;
}

/**
 * Resolve season_id and optional team_id to display names for the stats row label.
 */
export async function getStatsContext(seasonId: number, teamId?: number | null): Promise<StatsContextResult> {
  const [seasonResult, teamName] = await Promise.all([
    fetchSeasonWithLeague(seasonId),
    teamId != null && teamId > 0 ? fetchTeam(teamId) : Promise.resolve(null),
  ]);
  return {
    seasonName: seasonResult.seasonName,
    leagueName: seasonResult.leagueName,
    teamName: teamName ?? null,
  };
}
