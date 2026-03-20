/**
 * Recent match-by-match player stats for the Build Value Bets evidence API.
 * Populated from Sportmonks (past fixtures + lineup details). No synthetic sequences.
 */

import {
  fetchRecentStatsForPlayers,
  clearSportmonksRecentStatsCache,
  type RecentStatsForPlayer,
  type PlayerRecentLookup,
} from "./sportmonksRecentPlayerStats.js";

export type { RecentStatsForPlayer };

export interface RecentPlayerStatsRequestBody {
  /** @deprecated No longer used for data; prefer `players` with IDs. */
  playerNames?: string[];
  players?: Array<{ playerName: string; playerId: number; teamId: number }>;
  excludeFixtureId?: number;
  limit?: number;
}

function normalizeName(name: string): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Resolve recent stat arrays keyed by normalized player name (same as valueBetBuilder / client).
 */
export async function resolveRecentPlayerStats(
  body: RecentPlayerStatsRequestBody
): Promise<Record<string, RecentStatsForPlayer>> {
  console.log("=== resolveRecentPlayerStats CALLED ===", {
    time: new Date().toISOString(),
    pid: process.pid,
  });
  // Debug/testing: ensure new Sportmonks include / parser changes are reflected immediately.
  if (process.env.NODE_ENV !== "production") {
    clearSportmonksRecentStatsCache();
  }

  const players: PlayerRecentLookup[] = [];
  const seen = new Set<string>();
  if (Array.isArray(body.players)) {
    for (const p of body.players) {
      const key = normalizeName(p.playerName);
      if (!key || seen.has(key)) continue;
      if (typeof p.playerId !== "number" || typeof p.teamId !== "number") continue;
      if (!Number.isFinite(p.playerId) || !Number.isFinite(p.teamId)) continue;
      seen.add(key);
      players.push({ normalizedName: key, playerId: p.playerId, teamId: p.teamId, playerName: p.playerName });
    }
  }
  return fetchRecentStatsForPlayers(players, {
    limit: typeof body.limit === "number" && body.limit > 0 ? body.limit : 10,
    excludeFixtureId: typeof body.excludeFixtureId === "number" ? body.excludeFixtureId : undefined,
  });
}

export function clearRecentPlayerStatsCache(): void {
  clearSportmonksRecentStatsCache();
}
