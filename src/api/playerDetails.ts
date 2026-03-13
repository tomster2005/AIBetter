/**
 * Sportmonks player-by-ID API for player profile.
 * GET /v3/football/players/{id}
 */

const PLAYER_BASE = "https://api.sportmonks.com/v3/football/players";

/** Exact include for player stats: only statistics.details.type. No team, league, participant, or other unsupported includes. */
const PLAYER_INCLUDES = "statistics.details.type";

function getApiToken(): string {
  const token = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
  if (!token || typeof token !== "string") {
    throw new Error(
      "Missing Sportmonks API token. Set SPORTMONKS_API_TOKEN or SPORTMONKS_TOKEN in your environment."
    );
  }
  return token;
}

export interface RawPlayerResponse {
  id: number;
  name?: string;
  display_name?: string;
  image_path?: string;
  date_of_birth?: string;
  height?: number;
  weight?: number;
  preferred_foot?: string;
  position_id?: number;
  [key: string]: unknown;
}

export interface GetPlayerDetailsOptions {
  /** When set, request only statistics for this season (filters=playerStatisticSeasons:{seasonId}). */
  seasonId?: number;
}

/**
 * Fetches player details by ID with profile includes.
 * @param playerId - Sportmonks player ID
 * @param options - optional season filter for statistics
 * @returns Raw player response (API data wrapper may contain .data)
 */
export async function getPlayerDetails(playerId: number, options?: GetPlayerDetailsOptions): Promise<RawPlayerResponse> {
  const token = getApiToken();
  const params = new URLSearchParams({
    api_token: token,
    include: PLAYER_INCLUDES,
  });
  if (options?.seasonId != null && options.seasonId > 0) {
    params.set("filters", `playerStatisticSeasons:${options.seasonId}`);
  }
  const url = `${PLAYER_BASE}/${playerId}?${params.toString()}`;
  const res = await fetch(url);
  const bodyText = await res.text();
  if (!res.ok) {
    const message = bodyText?.trim() || res.statusText || String(res.status);
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  let data: RawPlayerResponse;
  try {
    const json = JSON.parse(bodyText) as { data?: RawPlayerResponse };
    data = json?.data ?? (json as unknown as RawPlayerResponse);
  } catch {
    throw new Error("Sportmonks API returned invalid JSON");
  }
  if (!data || typeof data.id === "undefined") {
    throw new Error("Sportmonks API returned invalid player data");
  }
  return data;
}
