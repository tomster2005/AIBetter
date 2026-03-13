/**
 * Sportmonks Football API v3 – fixtures by date range.
 * Reads API token from env; returns cleaned fixture objects.
 */

import type { Fixture, FixtureLeague, FixtureScoreEntry, FixtureState, FixtureTeam } from "../types/fixture.js";
import type { RawFixtureItem, RawLeague, RawParticipant, RawState, RawScoreItem } from "./sportmonks-types.js";

const BASE_URL = "https://api.sportmonks.com/v3/football/fixtures/between";
const DEFAULT_TIMEZONE = "Europe/London";
const INCLUDES = "participants;league;state;scores";

function getApiToken(): string {
  const token = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
  if (!token || typeof token !== "string") {
    throw new Error(
      "Missing Sportmonks API token. Set SPORTMONKS_API_TOKEN or SPORTMONKS_TOKEN in your environment."
    );
  }
  return token;
}

/**
 * Format a date as YYYY-MM-DD for the API.
 */
function formatDateForApi(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Infer home and away from participants using meta.location, then fallback to order.
 */
function splitHomeAway(participants: RawParticipant[] | undefined): { home: RawParticipant | null; away: RawParticipant | null } {
  if (!participants || participants.length === 0) {
    return { home: null, away: null };
  }
  const byLocation = { home: null as RawParticipant | null, away: null as RawParticipant | null };
  for (const p of participants) {
    const loc = p.meta?.location;
    if (loc === "home") byLocation.home = p;
    else if (loc === "away") byLocation.away = p;
  }
  if (byLocation.home && byLocation.away) return byLocation;
  if (participants.length >= 2) {
    return { home: participants[0], away: participants[1] };
  }
  return { home: participants[0] ?? null, away: null };
}

function toTeam(p: RawParticipant | null): FixtureTeam {
  if (!p) {
    return { id: 0, name: "TBD", logo: null };
  }
  return {
    id: p.id,
    name: p.name ?? "Unknown",
    logo: p.image_path ?? null,
  };
}

function toLeague(league: RawLeague | undefined): FixtureLeague {
  if (!league) {
    return { id: 0, name: "Unknown", logo: null };
  }
  return {
    id: league.id,
    name: league.name ?? "Unknown",
    logo: league.image_path ?? null,
  };
}

function toState(state: RawState | undefined): FixtureState {
  if (!state) {
    return { id: 0, name: "Unknown", nameShort: "?" };
  }
  const nameShort = state.name_short ?? state.short_name ?? state.name ?? "?";
  return {
    id: state.id,
    name: state.name ?? "Unknown",
    nameShort: String(nameShort),
  };
}

function toScores(scores: RawScoreItem[] | undefined): FixtureScoreEntry[] {
  if (!scores || !Array.isArray(scores)) return [];
  return scores
    .filter((s): s is RawScoreItem & { score: { goals?: number; participant?: "home" | "away" } } => s?.score != null)
    .map((s) => ({
      description: s.description ?? "",
      participant: (s.score.participant === "home" || s.score.participant === "away" ? s.score.participant : "home") as "home" | "away",
      goals: typeof s.score.goals === "number" ? s.score.goals : 0,
    }));
}

function parseDateTime(startingAt: string | null): { date: string; time: string } {
  if (!startingAt) return { date: "", time: "" };
  const trimmed = startingAt.trim();
  const [datePart, timePart] = trimmed.split(/\s+/);
  return {
    date: datePart ?? "",
    time: timePart ?? "",
  };
}

function cleanFixture(raw: RawFixtureItem): Fixture {
  const { home, away } = splitHomeAway(raw.participants);
  const { date, time } = parseDateTime(raw.starting_at);
  return {
    id: raw.id,
    startingAt: raw.starting_at ?? "",
    date,
    time,
    homeTeam: toTeam(home),
    awayTeam: toTeam(away),
    league: toLeague(raw.league),
    state: toState(raw.state),
    scores: toScores(raw.scores),
  };
}

const PER_PAGE = 50;

function isDev(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Fetches fixtures between two dates (inclusive) and returns a cleaned array.
 * Uses includes: participants;league;state;scores and timezone Europe/London.
 * Paginates with per_page=50 until has_more is false and merges all pages.
 *
 * @param startDate - Start of range (inclusive)
 * @param endDate - End of range (inclusive)
 * @returns Cleaned fixture array
 * @throws If API token is missing or request fails
 */
export async function getFixturesBetween(
  startDate: Date,
  endDate: Date
): Promise<Fixture[]> {
  const token = getApiToken();
  const start = formatDateForApi(startDate);
  const end = formatDateForApi(endDate);
  const allRaw: RawFixtureItem[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      api_token: token,
      include: INCLUDES,
      timezone: DEFAULT_TIMEZONE,
      per_page: String(PER_PAGE),
      page: String(page),
    });
    const url = `${BASE_URL}/${start}/${end}?${params.toString()}`;
    if (isDev()) {
      const safeUrl = `${BASE_URL}/${start}/${end}?api_token=***&include=${INCLUDES}&timezone=${DEFAULT_TIMEZONE}&per_page=${PER_PAGE}&page=${page}`;
      console.log("[fixtures] DEBUG request URL:", safeUrl);
    }
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Sportmonks API error ${res.status}: ${body || res.statusText}`);
    }
    let json: {
      data?: RawFixtureItem[];
      pagination?: { has_more?: boolean; current_page?: number; count?: number; next_page?: string };
    };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new Error("Sportmonks API returned invalid JSON");
    }
    const data = Array.isArray(json?.data) ? json.data : [];
    const pag = json?.pagination;
    if (isDev()) {
      console.log("[fixtures] DEBUG pagination this page:", {
        current_page: pag?.current_page ?? page,
        fixtures_on_page: data.length,
        has_more: pag?.has_more ?? false,
        next_page: pag?.next_page ?? null,
      });
    }
    allRaw.push(...data);
    hasMore = pag?.has_more === true;
    page += 1;
  }

  const totalPages = page - 1;
  if (isDev()) {
    console.log("[fixtures] DEBUG after all pages: total pages=" + totalPages + ", total raw fixtures=" + allRaw.length);
  }

  /* Temporary debug: raw fixture search - partial matches (no cleaned mapper) */
  if (isDev()) {
    const leagueName = (r: RawFixtureItem) => (r.league?.name ?? "").toLowerCase();
    const participantNames = (r: RawFixtureItem) =>
      (r.participants ?? []).map((p) => (p.name ?? "").toLowerCase());
    const partialMatches = allRaw.filter((raw) => {
      const ln = leagueName(raw);
      const names = participantNames(raw);
      return (
        ln.includes("fa") ||
        ln.includes("cup") ||
        names.some((n) => n.includes("west")) ||
        names.some((n) => n.includes("brent")) ||
        names.some((n) => n.includes("ham"))
      );
    });
    console.log("[fixtures] DEBUG raw fixtures with league 'FA' or 'Cup' or team 'West'/'Brent'/'Ham' (" + partialMatches.length + "):", partialMatches.map((r) => ({ id: r.id, starting_at: r.starting_at, league: r.league?.name, participants: (r.participants ?? []).map((p) => p.name) })));
    if (partialMatches.length > 0) {
      partialMatches.forEach((r, i) => console.log("[fixtures] DEBUG raw partial match full fixture " + (i + 1) + ":", JSON.stringify(r, null, 2)));
    }
  }

  /* Temporary debug: raw fixtures for 2026-03-09 with England / Cup / West|Ham|Brent */
  if (isDev()) {
    const targetDate = "2026-03-09";
    const forDate = allRaw.filter((raw) => (raw.starting_at ?? "").startsWith(targetDate));
    const leagueHasCup = (r: RawFixtureItem) => (r.league?.name ?? "").toLowerCase().includes("cup");
    const leagueCountryEngland = (r: RawFixtureItem) => (r.league as { country_id?: number } | undefined)?.country_id === 462;
    const participantMatches = (r: RawFixtureItem) => {
      const names = (r.participants ?? []).map((p) => (p.name ?? "").toLowerCase());
      return names.some((n) => n.includes("west") || n.includes("ham") || n.includes("brent"));
    };
    const filtered = forDate.filter((r) => leagueCountryEngland(r) || leagueHasCup(r) || participantMatches(r));
    console.log("[fixtures] DEBUG raw fixtures for " + targetDate + " (England OR league Cup OR participant West/Ham/Brent) (" + filtered.length + "):", filtered.map((r) => ({ id: r.id, starting_at: r.starting_at, league: r.league?.name, league_country_id: (r.league as { country_id?: number } | undefined)?.country_id, participants: (r.participants ?? []).map((p) => p.name) })));
    if (filtered.length > 0) {
      filtered.forEach((r, i) => console.log("[fixtures] DEBUG raw for " + targetDate + " full fixture " + (i + 1) + ":", JSON.stringify(r, null, 2)));
    }
  }

  const cleaned = allRaw.map(cleanFixture);

  /* Temporary debug: FA Cup West Ham vs Brentford 2026-03-09 */
  const rawMatchIndex = allRaw.findIndex((raw) => {
    const leagueName = (raw.league?.name ?? "").toLowerCase();
    if (!leagueName.includes("fa cup")) return false;
    const { home, away } = splitHomeAway(raw.participants);
    const homeName = (home?.name ?? "").toLowerCase();
    const awayName = (away?.name ?? "").toLowerCase();
    return homeName.includes("west ham") && awayName.includes("brentford");
  });
  if (rawMatchIndex >= 0 && isDev()) {
    const rawMatch = allRaw[rawMatchIndex];
    const cleanedMatch = cleaned[rawMatchIndex];
    console.log("[fixtures] DEBUG target fixture FOUND in API results");
    console.log("[fixtures] DEBUG raw fixture:", JSON.stringify(rawMatch, null, 2));
    console.log("[fixtures] DEBUG cleaned fixture:", JSON.stringify(cleanedMatch, null, 2));
    console.log("[fixtures] DEBUG date grouping: raw starting_at=%s, parsed date=%s, time=%s, grouped date key=%s", rawMatch.starting_at ?? "", cleanedMatch.date, cleanedMatch.time, cleanedMatch.date);
    console.log("[fixtures] DEBUG raw league/competition:", JSON.stringify(rawMatch.league ?? null, null, 2));
    console.log("[fixtures] DEBUG displayed league name from: league.name =", cleanedMatch.league.name);
  } else if (isDev()) {
    console.log("[fixtures] DEBUG target fixture (FA Cup, West Ham vs Brentford) NOT FOUND in API results");
  }

  return cleaned;
}
