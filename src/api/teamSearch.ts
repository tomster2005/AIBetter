/**
 * Sportmonks team search by name.
 * GET /v3/football/teams/search/{name}
 */

const TEAM_SEARCH_BASE = "https://api.sportmonks.com/v3/football/teams/search";

function getApiToken(): string {
  const token = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
  if (!token || typeof token !== "string") {
    throw new Error("Missing Sportmonks API token. Set SPORTMONKS_API_TOKEN or SPORTMONKS_TOKEN in your environment.");
  }
  return token;
}

export interface TeamSearchResult {
  id: number;
  name?: string;
  short_code?: string;
  image_path?: string;
}

export async function searchTeamsByName(name: string): Promise<TeamSearchResult[]> {
  const trimmed = name?.trim();
  if (!trimmed) return [];

  const token = getApiToken();
  const searchSlug = encodeURIComponent(trimmed);
  const params = new URLSearchParams({
    api_token: token,
  });
  const url = `${TEAM_SEARCH_BASE}/${searchSlug}?${params.toString()}`;
  const res = await fetch(url);
  const bodyText = await res.text();
  if (!res.ok) return [];

  let json: { data?: TeamSearchResult[] };
  try {
    json = JSON.parse(bodyText) as { data?: TeamSearchResult[] };
  } catch {
    return [];
  }
  return Array.isArray(json?.data) ? json.data : [];
}
