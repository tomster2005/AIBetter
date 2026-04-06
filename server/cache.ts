/**
 * In-memory cache for API responses. Used to reduce Sportmonks API calls.
 */

type CacheEntry<T> = {
  data: T;
  storedAt: number;
  ttlMs: number;
};

const cache = new Map<string, CacheEntry<unknown>>();

const TTL = {
  /** 60 seconds in ms */
  TODAY_FIXTURES: 60 * 1000,
  /** 10 minutes in ms */
  FUTURE_FIXTURES: 10 * 60 * 1000,
  /** Lineups: 30 seconds */
  LINEUP: 30 * 1000,
  /** Player profile: 5 minutes */
  PLAYER: 5 * 60 * 1000,
  /** Stats context (season/team names): 5 minutes */
  STATS_CONTEXT: 5 * 60 * 1000,
  /** Player odds (Phase 1): 45 seconds */
  PLAYER_ODDS: 45 * 1000,
  /** Head-to-head context: 30 minutes (stable, low urgency) */
  H2H_CONTEXT: 30 * 60 * 1000,
  /** Per-team recent form (all opponents): 20 minutes */
  TEAM_FORM_CONTEXT: 20 * 60 * 1000,
  /** Team season stats (goal-line): 30 minutes */
  TEAM_STATS: 30 * 60 * 1000,
  /** Past fixtures: never expire (use a very large number for "indefinite") */
  INDEFINITE: Number.MAX_SAFE_INTEGER,
} as const;

/** Get today's date key (YYYY-MM-DD) in UTC for consistent TTL across server timezones. */
function getTodayDateKey(): string {
  const t = new Date();
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Compute TTL in ms for a fixtures request (start/end date range).
 * - Range includes today → 60s
 * - Range includes any future date → 10min
 * - All past → indefinite
 */
export function getFixturesTtlMs(startParam: string, endParam: string): number {
  const today = getTodayDateKey();
  if (startParam <= today && endParam >= today) return TTL.TODAY_FIXTURES;
  if (endParam >= today) return TTL.FUTURE_FIXTURES;
  return TTL.INDEFINITE;
}

export function getLineupTtlMs(): number {
  return TTL.LINEUP;
}

export function getFixturesCacheKey(start: string, end: string): string {
  return `fixtures-${start}-${end}`;
}

export function getLineupCacheKey(fixtureId: number): string {
  return `lineup-${fixtureId}`;
}

export function getPlayerTtlMs(): number {
  return TTL.PLAYER;
}

export function getPlayerCacheKey(playerId: number, seasonId?: number): string {
  if (seasonId != null && seasonId > 0) {
    return `player-${playerId}-season-${seasonId}`;
  }
  return `player-${playerId}`;
}

export function getStatsContextTtlMs(): number {
  return TTL.STATS_CONTEXT;
}

export function getStatsContextCacheKey(seasonId: number, teamId?: number): string {
  return teamId != null && teamId > 0
    ? `stats-context-${seasonId}-${teamId}`
    : `stats-context-${seasonId}`;
}

export function getPlayerOddsTtlMs(): number {
  return TTL.PLAYER_ODDS;
}

export function getPlayerOddsCacheKey(fixtureId: number): string {
  return `player-odds-${fixtureId}`;
}

export function getHeadToHeadContextTtlMs(): number {
  return TTL.H2H_CONTEXT;
}

export function getHeadToHeadContextCacheKey(team1Id: number, team2Id: number): string {
  const a = Math.min(team1Id, team2Id);
  const b = Math.max(team1Id, team2Id);
  return `h2h-context-${a}-${b}`;
}

export function getTeamRecentFormContextTtlMs(): number {
  return TTL.TEAM_FORM_CONTEXT;
}

export function getTeamStatsTtlMs(): number {
  return TTL.TEAM_STATS;
}

/** Order-independent key; include excludeFixtureId so current-fixture builds stay correct. */
export function getTeamRecentFormContextCacheKey(
  team1Id: number,
  team2Id: number,
  excludeFixtureId?: number
): string {
  const a = Math.min(team1Id, team2Id);
  const b = Math.max(team1Id, team2Id);
  const ex = excludeFixtureId != null && Number.isFinite(excludeFixtureId) ? excludeFixtureId : 0;
  return `team-recent-form-${a}-${b}-${ex}`;
}

export function getTeamStatsCacheKey(teamId: number, seasonId?: number): string {
  const season = seasonId != null && Number.isFinite(seasonId) ? seasonId : 0;
  return `team-stats-${teamId}-${season}`;
}

export function get<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (entry.ttlMs !== TTL.INDEFINITE && Date.now() - entry.storedAt >= entry.ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

export function set<T>(key: string, data: T, ttlMs: number): void {
  cache.set(key, { data, storedAt: Date.now(), ttlMs });
}
