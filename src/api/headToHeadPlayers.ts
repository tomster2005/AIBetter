/**
 * Sportmonks H2H fixtures with lineup player stats (for last-meeting context).
 */

import { parseFixtureDetailsToPlayerStats, type PlayerMatchStats } from "./fixtureSettlement.js";

const H2H_BASE = "https://api.sportmonks.com/v3/football/fixtures/head-to-head";
const H2H_INCLUDES = "participants;lineups;lineups.player;lineups.details;lineups.details.type;statistics.type";

function getApiToken(): string {
  const token = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
  if (!token || typeof token !== "string") {
    throw new Error("Missing Sportmonks API token. Set SPORTMONKS_API_TOKEN or SPORTMONKS_TOKEN in your environment.");
  }
  return token;
}

type RawH2hFixture = {
  id?: number;
  starting_at?: string;
  lineups?: unknown;
  [key: string]: unknown;
};

export interface HeadToHeadPlayerStatsFixture {
  fixtureId: number;
  startingAt?: string;
  playerStats: PlayerMatchStats[];
}

export interface HeadToHeadPlayerStatsResponse {
  team1Id: number;
  team2Id: number;
  fixtures: HeadToHeadPlayerStatsFixture[];
}

export interface HeadToHeadPlayersOptions {
  limit?: number;
  leagueId?: number;
}

function toDateMs(v?: string): number {
  if (!v) return 0;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

export async function getHeadToHeadPlayerStats(
  team1Id: number,
  team2Id: number,
  options: HeadToHeadPlayersOptions = {}
): Promise<HeadToHeadPlayerStatsResponse | null> {
  if (!Number.isFinite(team1Id) || team1Id <= 0 || !Number.isFinite(team2Id) || team2Id <= 0) return null;

  const token = getApiToken();
  const params = new URLSearchParams({
    api_token: token,
    include: H2H_INCLUDES,
  });
  if (options.leagueId != null && Number.isFinite(options.leagueId)) {
    params.set("filters", `fixtureLeagues:${options.leagueId}`);
  }
  const url = `${H2H_BASE}/${team1Id}/${team2Id}?${params.toString()}`;
  const res = await fetch(url);
  const bodyText = await res.text();
  if (!res.ok) return null;

  let fixtures: RawH2hFixture[] = [];
  try {
    const json = JSON.parse(bodyText) as { data?: unknown };
    fixtures = Array.isArray(json?.data) ? (json.data as RawH2hFixture[]) : [];
  } catch {
    return null;
  }
  if (fixtures.length === 0) return { team1Id, team2Id, fixtures: [] };

  const sorted = [...fixtures].sort((a, b) => toDateMs(b.starting_at) - toDateMs(a.starting_at));
  const limit = options.limit != null && Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 1;
  const selected = sorted.slice(0, limit);

  const debugFixtureEnv = process.env.H2H_DEBUG_FIXTURES ?? "";
  const debugFixtures = new Set(
    debugFixtureEnv
      .split(",")
      .map((v) => parseInt(v.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
  const debugPlayerName = typeof process.env.H2H_DEBUG_PLAYER === "string" ? process.env.H2H_DEBUG_PLAYER.trim() : "";

  const out: HeadToHeadPlayerStatsFixture[] = [];
  for (const f of selected) {
    const fixtureId = typeof f.id === "number" ? f.id : 0;
    if (!Number.isFinite(fixtureId) || fixtureId <= 0) continue;
    const debugOptions =
      debugPlayerName && debugFixtures.has(fixtureId)
        ? { targetFixtureId: fixtureId, targetPlayerName: debugPlayerName }
        : undefined;
    const playerStats = parseFixtureDetailsToPlayerStats(f, debugOptions);
    if (playerStats.length === 0) continue;
    out.push({
      fixtureId,
      startingAt: typeof f.starting_at === "string" ? f.starting_at : undefined,
      playerStats,
    });
  }

  return { team1Id, team2Id, fixtures: out };
}
