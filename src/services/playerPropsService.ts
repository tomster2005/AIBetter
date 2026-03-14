/**
 * Shared client for loading player prop odds. Used by OddsPage and LineupModal.
 */

export interface PlayerOddsSelection {
  line: number;
  overOdds: number | null;
  underOdds: number | null;
  bookmakerId: number;
  bookmakerName: string;
}

export interface PlayerOddsPlayer {
  playerId: number;
  playerName: string;
  teamId: number;
  teamName: string;
  selections: PlayerOddsSelection[];
}

export interface PlayerOddsMarket {
  marketId: number;
  marketName: string;
  players: PlayerOddsPlayer[];
}

export type LineupSource = "confirmed" | "predicted" | "none";

export interface PlayerOddsResponse {
  fixtureId: number;
  markets: PlayerOddsMarket[];
  lineupSource?: LineupSource;
  playerCount?: number;
}

function getPlayerOddsApiUrl(fixtureId: number): string {
  const base =
    typeof import.meta.env !== "undefined" && import.meta.env?.VITE_API_ORIGIN;
  const origin = typeof base === "string" && base !== "" ? base.replace(/\/$/, "") : "";
  return `${origin}/api/fixtures/${fixtureId}/player-odds`;
}

/**
 * Fetches player prop odds for a fixture. Same endpoint as OddsPage / LineupModal.
 */
export async function loadPlayerPropsForFixture(fixtureId: number): Promise<PlayerOddsResponse> {
  const url = getPlayerOddsApiUrl(fixtureId);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Player odds unavailable");
  const json = (await res.json()) as { data?: PlayerOddsResponse };
  const data = json?.data ?? json;
  const resp = data as PlayerOddsResponse;
  if (data && typeof data === "object" && Array.isArray(resp?.markets)) {
    return {
      fixtureId,
      markets: resp.markets,
      lineupSource: resp?.lineupSource,
      playerCount: resp?.playerCount,
    };
  }
  return { fixtureId, markets: [], lineupSource: "none", playerCount: 0 };
}
