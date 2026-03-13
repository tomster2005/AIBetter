/**
 * Sportmonks league search: resolve league name to current season id.
 * GET /v3/football/leagues/search/{name}?include=currentSeason
 */

const LEAGUE_SEARCH_BASE = "https://api.sportmonks.com/v3/football/leagues/search";

/** Map country or common league alias to main domestic league name for search. */
const DOMESTIC_LEAGUE_MAP: Record<string, string> = {
  england: "Premier League",
  english: "Premier League",
  uk: "Premier League",
  spain: "La Liga",
  spanish: "La Liga",
  germany: "Bundesliga",
  german: "Bundesliga",
  italy: "Serie A",
  italian: "Serie A",
  france: "Ligue 1",
  french: "Ligue 1",
  netherlands: "Eredivisie",
  dutch: "Eredivisie",
  "premier league": "Premier League",
  "la liga": "La Liga",
  bundesliga: "Bundesliga",
  "serie a": "Serie A",
  "ligue 1": "Ligue 1",
  eredivisie: "Eredivisie",
};

/**
 * Resolve a team name, country, or league name to a domestic league name for search.
 * Returns the input if it looks like a league name, otherwise a mapped league or null.
 */
export function resolveDomesticLeagueName(teamOrCountryOrLeague: string): string | null {
  const t = teamOrCountryOrLeague?.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (DOMESTIC_LEAGUE_MAP[lower]) return DOMESTIC_LEAGUE_MAP[lower];
  return t;
}

function getApiToken(): string {
  const token = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
  if (!token || typeof token !== "string") {
    throw new Error(
      "Missing Sportmonks API token. Set SPORTMONKS_API_TOKEN or SPORTMONKS_TOKEN in your environment."
    );
  }
  return token;
}

export interface LeagueCurrentSeasonResult {
  leagueId: number;
  leagueName: string;
  currentSeasonId: number;
  currentSeasonName: string;
}

interface LeagueSearchItem {
  id: number;
  name?: string;
  currentSeason?: { id: number; name?: string };
  currentseason?: { id: number; name?: string };
}

/**
 * Search leagues by name and return the first match's current season.
 * Returns null if no match or current season not available.
 */
export async function getLeagueCurrentSeason(leagueName: string): Promise<LeagueCurrentSeasonResult | null> {
  const trimmed = leagueName?.trim();
  if (!trimmed) return null;

  const token = getApiToken();
  const searchSlug = encodeURIComponent(trimmed);
  const params = new URLSearchParams({
    api_token: token,
    include: "currentSeason",
  });
  const url = `${LEAGUE_SEARCH_BASE}/${searchSlug}?${params.toString()}`;
  const res = await fetch(url);
  const text = await res.text();

  if (!res.ok) return null;

  let json: { data?: LeagueSearchItem[] };
  try {
    json = JSON.parse(text) as { data?: LeagueSearchItem[] };
  } catch {
    return null;
  }

  const list = Array.isArray(json?.data) ? json.data : [];
  const league = list[0];
  if (!league || typeof league.id !== "number") return null;

  const currentSeason = league.currentSeason ?? league.currentseason;
  if (!currentSeason || typeof currentSeason.id !== "number") return null;

  return {
    leagueId: league.id,
    leagueName: league.name ?? trimmed,
    currentSeasonId: currentSeason.id,
    currentSeasonName: typeof currentSeason.name === "string" ? currentSeason.name : "Current",
  };
}
