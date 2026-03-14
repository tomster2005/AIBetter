/**
 * Frontend service for player season statistics (for value-bet model).
 */

export interface PlayerSeasonStats {
  playerId: number;
  seasonId: number;
  shots: number;
  shotsOnTarget: number;
  foulsCommitted?: number;
  foulsWon?: number;
  minutesPlayed: number;
  appearances: number;
}

function getApiOrigin(): string {
  const base = typeof import.meta.env !== "undefined" && import.meta.env?.VITE_API_ORIGIN;
  return typeof base === "string" && base !== "" ? base.replace(/\/$/, "") : "";
}

/**
 * Load player season stats from backend (proxies Sportmonks).
 */
export async function loadPlayerSeasonStats(
  playerId: number,
  seasonId: number
): Promise<PlayerSeasonStats | null> {
  const origin = getApiOrigin();
  const url = `${origin}/api/player-stats/${playerId}?season=${seasonId}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to load player statistics");
  const data = (await res.json()) as PlayerSeasonStats | { error?: string };
  if (data && typeof data === "object" && "error" in data) return null;
  return data as PlayerSeasonStats;
}

export interface LeagueCurrentSeasonResult {
  currentSeasonId: number;
  leagueName: string;
  currentSeasonName: string;
}

/**
 * Resolve league name to current season ID (for fixture context).
 */
export async function fetchLeagueCurrentSeason(leagueName: string): Promise<LeagueCurrentSeasonResult | null> {
  const origin = getApiOrigin();
  const url = `${origin}/api/league-current-season?league=${encodeURIComponent(leagueName)}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to resolve league season");
  return res.json() as Promise<LeagueCurrentSeasonResult>;
}
