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

function getApiOrigin(): string {
  const base =
    typeof import.meta.env !== "undefined" && import.meta.env?.VITE_API_ORIGIN;
  return typeof base === "string" && base !== "" ? base.replace(/\/$/, "") : "";
}

function getPlayerOddsApiUrl(fixtureId: number): string {
  const origin = getApiOrigin();
  return `${origin}/api/fixtures/${fixtureId}/player-odds`;
}

/**
 * Fetches player prop odds for a fixture. Same endpoint as OddsPage / LineupModal.
 */
export async function loadPlayerPropsForFixture(fixtureId: number): Promise<PlayerOddsResponse> {
  const apiOrigin = getApiOrigin();
  const finalUrl = getPlayerOddsApiUrl(fixtureId);
  if (import.meta.env.DEV) {
    if (!apiOrigin) {
      console.warn("[player-props] missing VITE_API_ORIGIN");
    }
    console.log("[player-props] request debug", { fixtureId, apiOrigin: apiOrigin || "(empty)", finalUrl });
  }
  try {
    const res = await fetch(finalUrl);
    if (!res.ok) throw new Error("Player odds unavailable");
    const json = (await res.json()) as { data?: PlayerOddsResponse };
    const data = json?.data ?? json;
    const resp = data as PlayerOddsResponse;
    if (data && typeof data === "object" && Array.isArray(resp?.markets)) {
      if (import.meta.env.DEV) {
        console.log("[player-props frontend] player-odds response received", {
          fixtureId,
          marketCount: resp.markets.length,
        });
      }
      return {
        fixtureId,
        markets: resp.markets,
        lineupSource: resp?.lineupSource,
        playerCount: resp?.playerCount,
      };
    }
    if (import.meta.env.DEV) {
      console.log("[player-props frontend] player-odds response received (no markets)", { fixtureId, marketCount: 0 });
    }
    return { fixtureId, markets: [], lineupSource: "none", playerCount: 0 };
  } catch (err) {
    if (import.meta.env.DEV) {
      console.error("[player-props] fetch failed", {
        fixtureId,
        apiOrigin: apiOrigin || "(empty)",
        finalUrl,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }
}
