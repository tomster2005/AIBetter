/**
 * Orchestrates multi-fixture scans by reusing the same data paths as LineupModal
 * (lineup → player props → season stats → buildValueBetRows) and optional team legs
 * from fixture odds (getTeamLegsFromOdds), without touching the single-fixture UI.
 */

import type { Fixture } from "../types/fixture.js";
import type { RawFixtureDetails } from "../api/fixture-details-types.js";
import type { RawLineupEntry } from "../api/fixture-details-types.js";
import { getLineupForFixture } from "../api/index.js";
import {
  buildValueBetRows,
  getStartingPlayerIds,
  getStartingPlayerNames,
  getNameToPlayerIdMap,
  type ValueBetRow,
} from "../components/LineupModal.js";
import {
  loadPlayerPropsForFixture,
  type PlayerOddsResponse as ServicePlayerOddsResponse,
} from "./playerPropsService.js";
import { loadPlayerSeasonStats, fetchLeagueCurrentSeason, type PlayerSeasonStats } from "./playerStatsService.js";
import { getTeamLegsFromOdds, type OddsBookmakerInput, type BuildLeg } from "../lib/valueBetBuilder.js";
import type { CrossMatchPlayerSingle, CrossMatchTeamSingle } from "../lib/crossMatchRanking.js";

export type CrossMatchMarketMode = "player" | "team" | "both";

export interface FixtureScanTrace {
  fixtureId: number;
  matchLabel: string;
  ok: boolean;
  reason?: string;
}

export interface CrossMatchScanResult {
  traces: FixtureScanTrace[];
  playerRows: CrossMatchPlayerSingle[];
  teamItems: CrossMatchTeamSingle[];
}

function getApiOrigin(): string {
  const base = typeof import.meta.env !== "undefined" && import.meta.env?.VITE_API_ORIGIN;
  return typeof base === "string" && base !== "" ? base.replace(/\/$/, "") : "";
}

async function fetchFixtureDetailsRaw(fixtureId: number): Promise<RawFixtureDetails | null> {
  try {
    const origin = getApiOrigin();
    const url = `${origin}/api/fixtures/${fixtureId}`;
    const res = await fetch(url);
    const text = await res.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    if (!res.ok) return null;
    return body as RawFixtureDetails;
  } catch {
    return null;
  }
}

async function fetchFixtureOddsBookmakers(fixtureId: number): Promise<OddsBookmakerInput[] | null> {
  try {
    const origin = getApiOrigin();
    const url = `${origin}/api/fixtures/${fixtureId}/odds`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { bookmakers?: OddsBookmakerInput[] }; bookmakers?: OddsBookmakerInput[] };
    const data = json?.data ?? json;
    const bookmakers = data?.bookmakers;
    return Array.isArray(bookmakers) ? bookmakers : null;
  } catch {
    return null;
  }
}

function matchLabelOf(f: Fixture): string {
  return `${f.homeTeam.name} vs ${f.awayTeam.name}`;
}

async function scanPlayerSide(fixture: Fixture): Promise<{
  rows: ValueBetRow[];
  trace: FixtureScanTrace;
}> {
  const label = matchLabelOf(fixture);
  const details = await fetchFixtureDetailsRaw(fixture.id);
  if (!details) {
    return {
      rows: [],
      trace: { fixtureId: fixture.id, matchLabel: label, ok: false, reason: "Fixture details unavailable" },
    };
  }
  const lineup = getLineupForFixture(details);
  const entries = lineup?.data as RawLineupEntry[] | undefined;
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      rows: [],
      trace: { fixtureId: fixture.id, matchLabel: label, ok: false, reason: "No lineup data" },
    };
  }

  let data: ServicePlayerOddsResponse;
  try {
    data = await loadPlayerPropsForFixture(fixture.id);
  } catch {
    return {
      rows: [],
      trace: { fixtureId: fixture.id, matchLabel: label, ok: false, reason: "Player props request failed" },
    };
  }

  const leagueSeason = fixture.league?.name
    ? await fetchLeagueCurrentSeason(fixture.league.name).catch(() => null)
    : null;

  const startingPlayerIds = getStartingPlayerIds(entries);
  const startingPlayerNames = getStartingPlayerNames(entries);
  const nameToPlayerId = getNameToPlayerIdMap(entries);
  const statsByPlayerId = new Map<number, PlayerSeasonStats>();
  const seasonId = leagueSeason?.currentSeasonId;
  if (seasonId != null && seasonId > 0) {
    await Promise.all(
      Array.from(startingPlayerIds).map(async (playerId) => {
        try {
          const stats = await loadPlayerSeasonStats(playerId, seasonId);
          if (stats) statsByPlayerId.set(playerId, stats);
        } catch {
          // ignore per player
        }
      })
    );
  }

  const fixtureShape = {
    homeTeam: { id: fixture.homeTeam.id },
    awayTeam: { id: fixture.awayTeam.id },
  };

  const result = buildValueBetRows(
    data,
    entries,
    fixtureShape,
    lineup?.lineupConfirmed === true,
    startingPlayerIds,
    startingPlayerNames,
    statsByPlayerId,
    nameToPlayerId
  );

  return {
    rows: result.rows,
    trace: { fixtureId: fixture.id, matchLabel: label, ok: true },
  };
}

async function scanTeamSide(fixture: Fixture): Promise<{ legs: BuildLeg[]; trace: FixtureScanTrace }> {
  const label = matchLabelOf(fixture);
  const bookmakers = await fetchFixtureOddsBookmakers(fixture.id);
  if (!bookmakers) {
    return {
      legs: [],
      trace: { fixtureId: fixture.id, matchLabel: label, ok: false, reason: "Odds unavailable" },
    };
  }
  const legs = getTeamLegsFromOdds(bookmakers, null, null);
  return {
    legs,
    trace: {
      fixtureId: fixture.id,
      matchLabel: label,
      ok: true,
      ...(legs.length === 0 ? { reason: "No team builder legs from odds" } : {}),
    },
  };
}

async function scanOneFixture(
  fixture: Fixture,
  mode: CrossMatchMarketMode
): Promise<{
  playerRows: CrossMatchPlayerSingle[];
  teamItems: CrossMatchTeamSingle[];
  traces: FixtureScanTrace[];
}> {
  const traces: FixtureScanTrace[] = [];
  const playerRows: CrossMatchPlayerSingle[] = [];
  const teamItems: CrossMatchTeamSingle[] = [];
  const kickoff = fixture.startingAt?.trim() ?? "";
  const leagueName = fixture.league?.name ?? "";

  if (mode === "team") {
    const { legs, trace } = await scanTeamSide(fixture);
    traces.push(trace);
    for (const leg of legs) {
      teamItems.push({
        kind: "team",
        fixtureId: fixture.id,
        matchLabel: matchLabelOf(fixture),
        leagueName,
        kickoff,
        leg,
      });
    }
    return { playerRows, teamItems, traces };
  }

  const { rows, trace } = await scanPlayerSide(fixture);
  traces.push(trace);
  if (trace.ok) {
    for (const r of rows) {
      playerRows.push({
        ...r,
        fixtureId: fixture.id,
        matchLabel: matchLabelOf(fixture),
        leagueName,
        kickoff,
      });
    }
  }

  if (mode === "both") {
    const teamRes = await scanTeamSide(fixture);
    traces.push(teamRes.trace);
    for (const leg of teamRes.legs) {
      teamItems.push({
        kind: "team",
        fixtureId: fixture.id,
        matchLabel: matchLabelOf(fixture),
        leagueName,
        kickoff,
        leg,
      });
    }
  }

  return { playerRows, teamItems, traces };
}

export interface ScanCrossMatchOptions {
  marketMode: CrossMatchMarketMode;
  maxConcurrent?: number;
  onProgress?: (done: number, total: number, lastLabel: string) => void;
}

/**
 * Runs fixture scans with bounded concurrency. Failures are per-fixture; others still return.
 */
export async function scanCrossMatchFixtures(
  fixtures: Fixture[],
  options: ScanCrossMatchOptions
): Promise<CrossMatchScanResult> {
  const maxConcurrent = Math.max(1, Math.min(5, options.maxConcurrent ?? 3));
  const total = fixtures.length;
  const allPlayer: CrossMatchPlayerSingle[] = [];
  const allTeam: CrossMatchTeamSingle[] = [];
  const traces: FixtureScanTrace[] = [];

  let index = 0;
  let done = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = index++;
      if (i >= fixtures.length) return;
      const f = fixtures[i]!;
      const { playerRows, teamItems, traces: t } = await scanOneFixture(f, options.marketMode);
      allPlayer.push(...playerRows);
      allTeam.push(...teamItems);
      traces.push(...t);
      done += 1;
      options.onProgress?.(done, total, matchLabelOf(f));
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrent, fixtures.length) }, () => worker());
  await Promise.all(workers);

  return { traces, playerRows: allPlayer, teamItems: allTeam };
}
