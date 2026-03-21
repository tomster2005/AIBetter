/**
 * Recent match-by-match player stats from Sportmonks (lineups.details on past fixtures).
 * Cached per fixture id and per team fixture list. No synthetic / backtest filler.
 */

import type { RawFixtureDetails } from "../src/api/fixture-details-types.js";
import { parseFixtureDetailsToPlayerStats } from "../src/api/fixtureSettlement.js";

const FIXTURE_BASE = "https://api.sportmonks.com/v3/football/fixtures";
const DEFAULT_TIMEZONE = "Europe/London";
/**
 * Recent-stats require fixture lineups *with* detailed stat rows.
 * Use explicit include (comma-separated) to avoid missing `lineups.details`.
 */
// Sportmonks include strings use semicolon-separated syntax (same style as other fixture endpoints).
const RECENT_STATS_INCLUDES =
  "participants;state;lineups;lineups.player;lineups.type;lineups.details;lineups.details.type";

/** Minimum minutes to count an appearance in recent sequences (when minutes are present). */
const MIN_MINUTES_RECENT = 30;

/**
 * Sportmonks lineup `details[].type.id` reference (shots/SOT are widely used; fouls vary by feed).
 * Actual extraction uses `parseFixtureDetailsToStats` (type names) — adjust IDs when you confirm from your API.
 */
export const LINEUP_DETAIL_TYPE_IDS = {
  shots: 84,
  shotsOnTarget: 86,
  foulsCommitted: null as number | null,
  foulsWon: null as number | null,
  tackles: null as number | null,
} as const;

export type RecentStatCategory = keyof typeof LINEUP_DETAIL_TYPE_IDS;

function getApiToken(): string | null {
  const token = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
  return token && typeof token === "string" ? token : null;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isFinishedState(raw: { state?: { id?: number; name_short?: string; name?: string } }): boolean {
  const short = (raw.state?.name_short ?? "").toUpperCase();
  const name = (raw.state?.name ?? "").toLowerCase();
  return (
    short === "FT" ||
    short === "AET" ||
    short === "PEN" ||
    name.includes("full time") ||
    name.includes("finished") ||
    name.includes("after extra") ||
    name.includes("penalties")
  );
}

/** In-memory caches */
const fixtureDetailsCache = new Map<number, Promise<any>>();
const teamFixtureIdsCache = new Map<string, Promise<number[]>>();

function cacheKeyTeam(teamId: number, limit: number, excludeFixtureId: number | undefined): string {
  return `${teamId}|${limit}|${excludeFixtureId ?? 0}`;
}

async function fetchFixtureDetailsCached(fixtureId: number): Promise<any | null> {
  const existing = fixtureDetailsCache.get(fixtureId);
  if (existing) {
    try {
      return await existing;
    } catch {
      fixtureDetailsCache.delete(fixtureId);
    }
  }
  const token = getApiToken();
  if (!token) {
    console.log("=== FIXTURE DETAIL FETCH NULL RETURN ===", {
      fixtureId,
      reason: "missing-token",
      pid: process.pid,
    });
    return null;
  }

  const p = (async () => {
    console.log("=== FIXTURE DETAIL FETCH START ===", {
      fixtureId,
      pid: process.pid,
    });
    const params = new URLSearchParams({
      api_token: token,
      include: RECENT_STATS_INCLUDES,
    });
    const url = `${FIXTURE_BASE}/${fixtureId}?${params.toString()}`;
    const res = await fetch(url);
    console.log("=== FIXTURE DETAIL FETCH RESPONSE ===", {
      fixtureId,
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      pid: process.pid,
    });
    const text = await res.text();
    if (!res.ok) {
      console.log("=== FIXTURE DETAIL ERROR BODY ===", {
        fixtureId,
        body: text ? String(text).slice(0, 2000) : "",
      });
      console.log("=== FIXTURE DETAIL FETCH NULL RETURN ===", {
        fixtureId,
        reason: "non-200-response",
        pid: process.pid,
      });
      return null;
    }

    let json: any = null;
    try {
      json = JSON.parse(text) as { data?: RawFixtureDetails };
    } catch {
      console.log("=== FIXTURE DETAIL PARSE JSON FAILED ===", {
        fixtureId,
        body: text ? String(text).slice(0, 2000) : "",
      });
      console.log("=== FIXTURE DETAIL FETCH NULL RETURN ===", {
        fixtureId,
        reason: "invalid-json",
        pid: process.pid,
      });
      return null;
    }

    console.log("=== FIXTURE DETAIL FETCH JSON ===", {
      fixtureId,
      hasData: Boolean(json?.data),
      topKeys: json ? Object.keys(json) : [],
      dataKeys: json?.data ? Object.keys(json.data) : [],
      hasLineups: Boolean(json?.data?.lineups),
      pid: process.pid,
    });

    if (!json?.data) {
      console.log("=== FIXTURE DETAIL FETCH NULL RETURN ===", {
        fixtureId,
        reason: "missing-json.data",
        pid: process.pid,
      });
      console.log("=== FIXTURE DETAIL ERROR BODY ===", {
        fixtureId,
        body: json,
      });
      return null;
    }

    const data = json.data;
    if (!data || typeof data.id !== "number") {
      console.log("=== FIXTURE DETAIL FETCH NULL RETURN ===", {
        fixtureId,
        reason: "invalid-fixture-id",
        pid: process.pid,
      });
      return null;
    }

    // Return full wrapper so debug logs can inspect raw?.data.*
    return json as any;
  })();

  fixtureDetailsCache.set(fixtureId, p);
  try {
    return await p;
  } catch {
    fixtureDetailsCache.delete(fixtureId);
    return null;
  }
}

/**
 * Last `limit` finished fixture IDs for the team (chronological: oldest → newest).
 * Uses GET /fixtures/between/{start}/{end}/{teamId} when token present.
 */
async function fetchTeamRecentFinishedFixtureIds(
  teamId: number,
  limit: number,
  excludeFixtureId?: number
): Promise<number[]> {
  const token = getApiToken();
  if (!token) return [];

  const key = cacheKeyTeam(teamId, limit, excludeFixtureId);
  const hit = teamFixtureIdsCache.get(key);
  if (hit) return hit;

  const promise = (async () => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 200);

    const params = new URLSearchParams({
      api_token: token,
      include: "state",
      timezone: DEFAULT_TIMEZONE,
      per_page: String(Math.min(100, limit * 4)),
    });

    const betweenUrl = `${FIXTURE_BASE}/between/${formatDate(start)}/${formatDate(end)}/${teamId}?${params.toString()}`;
    let res = await fetch(betweenUrl);
    let items: Array<{ id?: number; starting_at?: string; state?: unknown }> = [];

    if (res.ok) {
      const json = (await res.json()) as { data?: unknown[] };
      items = Array.isArray(json?.data) ? (json.data as typeof items) : [];
    } else {
      const alt = new URLSearchParams({
        api_token: token,
        filters: `fixtureTeams:${teamId}`,
        include: "state",
        per_page: String(Math.min(100, limit * 4)),
      });
      res = await fetch(`${FIXTURE_BASE}?${alt.toString()}`);
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: unknown[] };
      items = Array.isArray(json?.data) ? (json.data as typeof items) : [];
    }

    const finished = items.filter((f) => f.id != null && isFinishedState(f as { state?: { name_short?: string; name?: string } }));
    if (excludeFixtureId != null) {
      for (let i = finished.length - 1; i >= 0; i--) {
        if (finished[i]!.id === excludeFixtureId) finished.splice(i, 1);
      }
    }

    finished.sort((a, b) => (a.starting_at ?? "").localeCompare(b.starting_at ?? ""));
    const ids = finished
      .map((f) => f.id)
      .filter((id): id is number => typeof id === "number" && Number.isFinite(id));
    if (process.env.NODE_ENV !== "production") {
      console.log("[recent-fixture-ids fetch-team]", {
        teamId,
        limit,
        excludeFixtureId: excludeFixtureId ?? null,
        fixtureCount: ids.length,
        sample: finished.slice(-Math.min(5, finished.length)).map((f) => ({
          id: f.id,
          starting_at: (f as any).starting_at ?? null,
          stateName: (f as any).state?.name_short ?? (f as any).state?.name ?? null,
        })),
      });
    }
    return ids.slice(-limit);
  })();

  teamFixtureIdsCache.set(key, promise);
  return promise;
}

function pickStat(row: ReturnType<typeof parseFixtureDetailsToPlayerStats>[0], category: RecentStatCategory): number {
  switch (category) {
    case "shots":
      return row.shots ?? 0;
    case "shotsOnTarget":
      return row.shotsOnTarget ?? 0;
    case "foulsCommitted":
      return row.foulsCommitted ?? 0;
    case "foulsWon":
      return row.foulsWon ?? 0;
    case "tackles":
      return row.tackles ?? 0;
    default:
      return 0;
  }
}

async function buildSeriesForPlayer(
  playerId: number,
  teamId: number,
  category: RecentStatCategory,
  limit: number,
  excludeFixtureId?: number,
  playerName?: string
): Promise<number[]> {
  // Original fixture selection behavior:
  // fetch the last `limit` finished fixtures first, then process/filter within that set.
  const fixtureIds = await fetchTeamRecentFinishedFixtureIds(teamId, limit, excludeFixtureId);
  if (process.env.NODE_ENV !== "production") {
    console.log("[recent-series fixture-ids]", {
      playerId,
      teamId,
      category,
      fixtureIds,
      fixtureCount: fixtureIds.length,
    });
  }

  const values: number[] = [];
  const debugFoulsCommitted = process.env.NODE_ENV !== "production" && category === "foulsCommitted";
  const debugTruffert = debugFoulsCommitted && (playerName ?? "").toLowerCase().includes("truffert");
  const selectedFixturesForTruffert: Array<{
    fixtureId: number;
    startingAt: string | null;
    minutesPlayed: number | null;
    rawValue: number | null;
    value: number;
    finalValue: number;
    zeroFilled: boolean;
    started: boolean | null;
    typeId: number | null;
    typeName: string | null;
  }> = [];
  let truffertLastSelectedRaw: any | null = null;

  for (let idx = 0; idx < fixtureIds.length; idx++) {
    const fid = fixtureIds[idx]!;
    const raw = await fetchFixtureDetailsCached(fid);
    if (!raw) continue;

    const rows = parseFixtureDetailsToPlayerStats(raw);
    const row = rows.find((r) => r.playerId === playerId);

    const startingAt = typeof raw?.data?.starting_at === "string" ? raw.data.starting_at : null;
    const minutesPlayed = row?.minutesPlayed ?? null;
    const started = row?.started ?? null;
    const typeId =
      category === "foulsCommitted" ? row?.foulsCommittedDetailTypeId ?? null : null;
    const typeName =
      category === "foulsCommitted" ? row?.foulsCommittedDetailTypeName ?? null : null;

    if (!row) {
      if (debugFoulsCommitted) {
        console.log("[foulsCommitted debug]", {
          playerId,
          playerName: playerName ?? null,
          fixtureId: fid,
          startingAt,
          minutesPlayed,
          started,
          rawValue: null,
          finalValue: null,
          typeId,
          typeName,
        });
      }
      continue;
    }

    // Minutes filter (original behavior):
    // reject only when we have finite minutes and they are below MIN_MINUTES_RECENT.
    // allow missing/null minutes so they don't break fixture alignment.
    const minutesOk = !(minutesPlayed != null && Number.isFinite(minutesPlayed) && minutesPlayed < MIN_MINUTES_RECENT);
    if (!minutesOk) {
      if (debugFoulsCommitted) {
        console.log("[foulsCommitted debug]", {
          playerId,
          playerName: playerName ?? null,
          fixtureId: fid,
          startingAt,
          minutesPlayed: minutesPlayed ?? null,
          started,
          rawValue: category === "foulsCommitted" ? row.foulsCommitted ?? null : null,
          finalValue: null,
          typeId,
          typeName,
        });
      }
      continue;
    }

    const valueRaw =
      category === "shots"
        ? row.shots
        : category === "shotsOnTarget"
          ? row.shotsOnTarget
          : category === "foulsCommitted"
            ? row.foulsCommitted
            : category === "foulsWon"
              ? row.foulsWon
              : category === "tackles"
                ? row.tackles
                : undefined;

    let finalValue: number | null = null;

    if (typeof valueRaw === "number" && Number.isFinite(valueRaw)) {
      finalValue = valueRaw;
    } else {
      // Sportmonks may omit stat rows when the value is 0.
      // Fill 0 only when we can tell the player actually played.
      // Zero-fill safeguard for missing stat rows:
      // if minutes are < 30 or missing, skip this fixture (do not inject 0).
      const minutesOkForZeroFill =
        typeof row.minutesPlayed === "number" && Number.isFinite(row.minutesPlayed) && row.minutesPlayed >= MIN_MINUTES_RECENT;
      if (minutesOkForZeroFill) {
        finalValue = 0;
        if (process.env.NODE_ENV !== "production") {
          console.log("[recent-series zero-fill]", {
            fixtureId: fid,
            originalValue: valueRaw,
            filledValue: finalValue,
            minutesPlayed: row.minutesPlayed,
          });
        }
      }
    }

    // Safeguard: do not push anything unless we end up with a numeric value (including 0).
    if (finalValue !== null) {
      values.push(finalValue);
      if (debugTruffert) {
        const rawValueDebug = valueRaw ?? null;
        const zeroFilled = rawValueDebug === null && finalValue === 0;
        console.log("[truffert-fouls fixture-detail]", {
          fixtureId: fid,
          startingAt,
          minutesPlayed: row.minutesPlayed ?? null,
          started: row.started ?? null,
          rawValue: rawValueDebug,
          finalValue,
          zeroFilled,
          typeId,
          typeName,
        });
        truffertLastSelectedRaw = raw;
        selectedFixturesForTruffert.push({
          fixtureId: fid,
          startingAt,
          minutesPlayed: row.minutesPlayed ?? null,
          rawValue: valueRaw ?? null,
          value: finalValue,
          finalValue,
          zeroFilled,
          started: row.started ?? null,
          typeId,
          typeName,
        });
      }
    }

    if (debugFoulsCommitted) {
      console.log("[foulsCommitted debug]", {
        playerId,
        playerName: playerName ?? null,
        fixtureId: fid,
        startingAt,
        minutesPlayed: row.minutesPlayed ?? null,
        started,
        rawValue: valueRaw ?? null,
        finalValue,
        typeId,
        typeName,
      });
    }
  }

  // Filter-first => now slice last N.
  const slicedValues = values.slice(-limit);
  const slicedSelectedFixturesForTruffert = debugTruffert ? selectedFixturesForTruffert.slice(-limit) : [];

  if (process.env.NODE_ENV !== "production") {
    console.log("[recent-series final]", {
      playerId,
      teamId,
      category,
      values: slicedValues,
      valuesLength: slicedValues.length,
    });
  }

  if (debugTruffert) {
    console.log("[truffert-fouls final-fixture-ids]", {
      selectedFixtures: slicedSelectedFixturesForTruffert.map((f) => ({
        fixtureId: f.fixtureId,
        startingAt: f.startingAt,
        value: f.finalValue,
      })),
    });

    const last = slicedSelectedFixturesForTruffert[slicedSelectedFixturesForTruffert.length - 1];
    console.log("[truffert-fouls last-fixture-check]", {
      fixtureId: last?.fixtureId ?? null,
      startingAt: last?.startingAt ?? null,
      finalValue: last?.finalValue ?? null,
      rawValue: last?.rawValue ?? null,
      zeroFilled: last ? last.zeroFilled : false,
      minutesPlayed: last?.minutesPlayed ?? null,
      started: last?.started ?? null,
    });

    console.log("[truffert-fouls compare]", {
      finalValues: slicedValues,
      selectedFixtures: slicedSelectedFixturesForTruffert.map((f) => ({
        fixtureId: f.fixtureId,
        startingAt: f.startingAt,
        minutesPlayed: f.minutesPlayed,
        rawValue: f.rawValue,
        finalValue: f.finalValue,
        zeroFilled: f.zeroFilled,
        started: f.started,
        typeId: f.typeId,
        typeName: f.typeName,
      })),
    });

    // Re-parse only the final selected fixture with Truffert-only debug,
    // so fixtureSettlement.ts prints ALL foul-like raw detail rows for that fixture.
    const targetFixtureId = last?.fixtureId ?? null;
    if (targetFixtureId != null && truffertLastSelectedRaw) {
      parseFixtureDetailsToPlayerStats(truffertLastSelectedRaw, {
        targetFixtureId,
        targetPlayerId: playerId,
        targetPlayerName: playerName ?? "",
      });
    }
  }

  return slicedValues;
}

export interface PlayerRecentLookup {
  /** Normalised name key (same rules as server recentPlayerStats). */
  normalizedName: string;
  playerId: number;
  teamId: number;
  playerName?: string;
}

const seriesCache = new Map<string, Promise<number[]>>();

function seriesCacheKey(playerId: number, teamId: number, category: RecentStatCategory, limit: number, exclude?: number): string {
  return `${playerId}|${teamId}|${category}|${limit}|${exclude ?? 0}`;
}

/**
 * Match-by-match values (newest → oldest) for one player and stat category.
 */
export async function getRecentPlayerStatSeries(
  playerId: number,
  teamId: number,
  category: RecentStatCategory,
  limit = 10,
  excludeFixtureId?: number,
  playerName?: string
): Promise<number[]> {
  const ck = seriesCacheKey(playerId, teamId, category, limit, excludeFixtureId);
  const existing = seriesCache.get(ck);
  if (existing) return existing;

  const p = buildSeriesForPlayer(playerId, teamId, category, limit, excludeFixtureId, playerName);
  seriesCache.set(ck, p);
  const values = await p;
  if (process.env.NODE_ENV !== "production") {
    console.log("[series-build]", {
      playerId,
      teamId,
      category,
      valuesLength: values.length,
    });
  }
  return values;
}

export interface RecentStatsForPlayer {
  shots: number[];
  shotsOnTarget: number[];
  foulsCommitted: number[];
  foulsWon: number[];
  tackles: number[];
}

/**
 * For each unique player (normalized name), fill all stat series from Sportmonks.
 */
export async function fetchRecentStatsForPlayers(
  players: PlayerRecentLookup[],
  options: { limit?: number; excludeFixtureId?: number } = {}
): Promise<Record<string, RecentStatsForPlayer>> {
  console.log("=== fetchRecentStatsForPlayers CALLED ===", {
    time: new Date().toISOString(),
    pid: process.pid,
    playersCount: players.length,
  });
  const token = getApiToken();
  const out: Record<string, RecentStatsForPlayer> = {};
  if (!token || players.length === 0) return out;

  const { limit = 10, excludeFixtureId } = options;
  const seen = new Set<string>();

  for (const p of players) {
    const key = p.normalizedName.trim().toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!Number.isFinite(p.playerId) || !Number.isFinite(p.teamId)) continue;

    const [shots, shotsOnTarget, foulsCommitted, foulsWon, tackles] = await Promise.all([
      getRecentPlayerStatSeries(p.playerId, p.teamId, "shots", limit, excludeFixtureId, p.playerName),
      getRecentPlayerStatSeries(p.playerId, p.teamId, "shotsOnTarget", limit, excludeFixtureId, p.playerName),
      getRecentPlayerStatSeries(p.playerId, p.teamId, "foulsCommitted", limit, excludeFixtureId, p.playerName),
      getRecentPlayerStatSeries(p.playerId, p.teamId, "foulsWon", limit, excludeFixtureId, p.playerName),
      getRecentPlayerStatSeries(p.playerId, p.teamId, "tackles", limit, excludeFixtureId, p.playerName),
    ]);

    out[key] = { shots, shotsOnTarget, foulsCommitted, foulsWon, tackles };
  }

  return out;
}

export function clearSportmonksRecentStatsCache(): void {
  fixtureDetailsCache.clear();
  teamFixtureIdsCache.clear();
  seriesCache.clear();
}
