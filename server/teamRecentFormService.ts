/**
 * Recent finished fixtures per team (all opponents) with scores — Sportmonks fixtures/between.
 * One fetch per team; cached at route layer.
 */

import type { FixtureTeamFormContext, TeamSideRecentForm, TeamVenueSplitForm } from "../src/types/teamRecentFormContext.js";
import type { RawFixtureItem, RawScoreItem } from "../src/api/sportmonks-types.js";

const FIXTURE_BASE = "https://api.sportmonks.com/v3/football/fixtures";
const DEFAULT_TIMEZONE = "Europe/London";
const MAX_RECENT = 5;
const LOOKBACK_DAYS = 200;

function getApiToken(): string | null {
  const token = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
  return token && typeof token === "string" ? token.trim() : null;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isFinishedState(raw: RawFixtureItem): boolean {
  const st = raw.state;
  if (!st) return false;
  const short = String((st as { name_short?: string }).name_short ?? "").toUpperCase();
  const name = String((st as { name?: string }).name ?? "").toLowerCase();
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

function unwrapScores(scores: RawFixtureItem["scores"]): RawScoreItem[] {
  if (Array.isArray(scores)) return scores as RawScoreItem[];
  if (scores && typeof scores === "object" && "data" in scores) {
    const d = (scores as { data?: unknown }).data;
    return Array.isArray(d) ? (d as RawScoreItem[]) : [];
  }
  return [];
}

function getGoalsBySide(f: RawFixtureItem): { home: number | null; away: number | null } {
  const scores = unwrapScores(f.scores);
  let home: number | null = null;
  let away: number | null = null;
  for (const s of scores) {
    const part = s.score?.participant;
    const g = s.score?.goals;
    if (typeof g !== "number" || !Number.isFinite(g)) continue;
    if (part === "home") home = home == null ? g : Math.max(home, g);
    if (part === "away") away = away == null ? g : Math.max(away, g);
  }
  return { home, away };
}

function unwrapParticipants(
  participants: RawFixtureItem["participants"]
): Array<{ id?: number; meta?: { location?: string } }> {
  if (Array.isArray(participants)) return participants as Array<{ id?: number; meta?: { location?: string } }>;
  if (participants && typeof participants === "object" && "data" in participants) {
    const d = (participants as { data?: unknown }).data;
    return Array.isArray(d) ? (d as Array<{ id?: number; meta?: { location?: string } }>) : [];
  }
  return [];
}

function getParticipantSide(participants: RawFixtureItem["participants"], teamId: number): "home" | "away" | null {
  for (const p of unwrapParticipants(participants)) {
    if (p.id === teamId) {
      const loc = p.meta?.location;
      if (loc === "home" || loc === "away") return loc;
    }
  }
  return null;
}

type SliceRow = {
  goalsFor: number;
  goalsAgainst: number;
  total: number;
  btts: boolean;
  wasHome: boolean;
};

function buildSliceForTeam(
  fixtures: RawFixtureItem[],
  teamId: number,
  excludeFixtureId: number | undefined,
  teamNameFromRequest: string | undefined
): TeamSideRecentForm {
  const finished = fixtures.filter(
    (f) => f.id != null && isFinishedState(f) && (excludeFixtureId == null || f.id !== excludeFixtureId)
  );
  finished.sort((a, b) => String(a.starting_at ?? "").localeCompare(String(b.starting_at ?? "")));
  const last = finished.slice(-MAX_RECENT);

  const rows: SliceRow[] = [];
  for (const f of last) {
    const side = getParticipantSide(f.participants, teamId);
    const { home, away } = getGoalsBySide(f);
    if (side == null || home == null || away == null) continue;
    const gf = side === "home" ? home : away;
    const ga = side === "home" ? away : home;
    rows.push({
      goalsFor: gf,
      goalsAgainst: ga,
      total: home + away,
      btts: home > 0 && away > 0,
      wasHome: side === "home",
    });
  }

  const n = rows.length;
  const weakSample = n < 3;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const avg = (xs: number[]) => (xs.length > 0 ? sum(xs) / xs.length : null);

  const totals = rows.map((r) => r.total);
  const gfs = rows.map((r) => r.goalsFor);
  const gas = rows.map((r) => r.goalsAgainst);
  const bttsHits = rows.filter((r) => r.btts).length;
  const scoredHits = rows.filter((r) => r.goalsFor > 0).length;
  const concHits = rows.filter((r) => r.goalsAgainst > 0).length;

  const homeRows = rows.filter((r) => r.wasHome);
  const awayRows = rows.filter((r) => !r.wasHome);

  const splitAgg = (rs: SliceRow[]): TeamVenueSplitForm => {
    if (rs.length === 0) return { n: 0, avgGoalsFor: null, avgGoalsAgainst: null, avgMatchTotalGoals: null };
    return {
      n: rs.length,
      avgGoalsFor: avg(rs.map((r) => r.goalsFor)),
      avgGoalsAgainst: avg(rs.map((r) => r.goalsAgainst)),
      avgMatchTotalGoals: avg(rs.map((r) => r.total)),
    };
  };

  const recentTotals = [...totals].reverse();
  const recentGF = [...gfs].reverse();
  const recentGA = [...gas].reverse();

  return {
    teamId,
    teamName: teamNameFromRequest,
    sampleSize: n,
    weakSample,
    avgMatchTotalGoals: avg(totals),
    avgGoalsFor: avg(gfs),
    avgGoalsAgainst: avg(gas),
    bttsRate: n > 0 ? bttsHits / n : null,
    bttsHits,
    scoredInRate: n > 0 ? scoredHits / n : null,
    concededInRate: n > 0 ? concHits / n : null,
    homeSplit: splitAgg(homeRows),
    awaySplit: splitAgg(awayRows),
    recentMatchTotals: recentTotals,
    recentGoalsFor: recentGF,
    recentGoalsAgainst: recentGA,
  };
}

async function fetchTeamFixturesBetween(teamId: number): Promise<RawFixtureItem[]> {
  const token = getApiToken();
  if (!token) return [];

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - LOOKBACK_DAYS);

  const params = new URLSearchParams({
    api_token: token,
    include: "participants;scores;state",
    timezone: DEFAULT_TIMEZONE,
    per_page: "50",
  });

  const url = `${FIXTURE_BASE}/between/${formatDate(start)}/${formatDate(end)}/${teamId}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[team-form] between fetch non-OK", { teamId, status: res.status });
    }
    return [];
  }
  const json = (await res.json()) as { data?: RawFixtureItem[] };
  return Array.isArray(json?.data) ? json.data! : [];
}

/**
 * Load recent form for both teams. `homeTeamId` / `awayTeamId` must match fixture sides.
 */
export async function fetchFixtureTeamFormContext(
  homeTeamId: number,
  awayTeamId: number,
  options?: {
    excludeFixtureId?: number;
    homeTeamName?: string;
    awayTeamName?: string;
  }
): Promise<FixtureTeamFormContext> {
  const excludeFixtureId = options?.excludeFixtureId;
  if (!getApiToken()) {
    return {
      homeTeamId,
      awayTeamId,
      homeTeamName: options?.homeTeamName,
      awayTeamName: options?.awayTeamName,
      fetchFailed: true,
      home: emptySide(homeTeamId, options?.homeTeamName),
      away: emptySide(awayTeamId, options?.awayTeamName),
    };
  }

  const fail = (): FixtureTeamFormContext => ({
    homeTeamId,
    awayTeamId,
    homeTeamName: options?.homeTeamName,
    awayTeamName: options?.awayTeamName,
    fetchFailed: true,
    home: emptySide(homeTeamId, options?.homeTeamName),
    away: emptySide(awayTeamId, options?.awayTeamName),
  });

  if (!Number.isFinite(homeTeamId) || homeTeamId <= 0 || !Number.isFinite(awayTeamId) || awayTeamId <= 0) {
    return fail();
  }

  try {
    const [homeFixtures, awayFixtures] = await Promise.all([
      fetchTeamFixturesBetween(homeTeamId),
      fetchTeamFixturesBetween(awayTeamId),
    ]);

    if (homeFixtures.length === 0 && awayFixtures.length === 0) {
      return fail();
    }

    const home = buildSliceForTeam(homeFixtures, homeTeamId, excludeFixtureId, options?.homeTeamName);
    const away = buildSliceForTeam(awayFixtures, awayTeamId, excludeFixtureId, options?.awayTeamName);

    const ctx: FixtureTeamFormContext = {
      homeTeamId,
      awayTeamId,
      homeTeamName: options?.homeTeamName,
      awayTeamName: options?.awayTeamName,
      fetchFailed: false,
      home,
      away,
    };

    if (process.env.NODE_ENV !== "production") {
      console.log("[team-form] built context", {
        homeTeamId,
        awayTeamId,
        homeN: home.sampleSize,
        awayN: away.sampleSize,
        homeAvgTotal: home.avgMatchTotalGoals,
        awayAvgTotal: away.avgMatchTotalGoals,
      });
    }

    return ctx;
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[team-form] error", { homeTeamId, awayTeamId, message: e instanceof Error ? e.message : String(e) });
    }
    return fail();
  }
}

function emptySide(teamId: number, name?: string): TeamSideRecentForm {
  return {
    teamId,
    teamName: name,
    sampleSize: 0,
    weakSample: true,
    avgMatchTotalGoals: null,
    avgGoalsFor: null,
    avgGoalsAgainst: null,
    bttsRate: null,
    bttsHits: 0,
    scoredInRate: null,
    concededInRate: null,
    homeSplit: { n: 0, avgGoalsFor: null, avgGoalsAgainst: null, avgMatchTotalGoals: null },
    awaySplit: { n: 0, avgGoalsFor: null, avgGoalsAgainst: null, avgMatchTotalGoals: null },
    recentMatchTotals: [],
    recentGoalsFor: [],
    recentGoalsAgainst: [],
  };
}
