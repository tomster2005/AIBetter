import type { HeadToHeadFixtureContext } from "../types/headToHeadContext.js";

const H2H_BASE = "https://api.sportmonks.com/v3/football/fixtures/head-to-head";
const H2H_INCLUDES = "participants;statistics";

function isDev(): boolean {
  return process.env.NODE_ENV !== "production";
}

function getApiToken(): string | null {
  const token = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
  return token && typeof token === "string" && token.trim() ? token.trim() : null;
}

type RawH2hParticipant = {
  id?: number;
  name?: string;
  meta?: { location?: string };
};

type RawH2hScore = {
  description?: string;
  score?: { goals?: number; participant?: "home" | "away" };
};

type RawH2hStatistic = {
  participant_id?: number;
  value?: unknown;
  type?: { name?: string };
};

type RawH2hFixture = {
  id?: number;
  starting_at?: string;
  participants?: RawH2hParticipant[] | { data?: RawH2hParticipant[] };
  scores?: RawH2hScore[] | { data?: RawH2hScore[] };
  statistics?: RawH2hStatistic[] | { data?: RawH2hStatistic[] };
};

function unwrapArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object" && "data" in (v as Record<string, unknown>)) {
    const d = (v as { data?: unknown }).data;
    return Array.isArray(d) ? (d as T[]) : [];
  }
  return [];
}

function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function getGoalsTotalFromFixture(f: RawH2hFixture): number | null {
  const scores = unwrapArray<RawH2hScore>(f.scores);
  if (scores.length === 0) return null;
  // Try to pick a reasonable "final-ish" score by taking max goals per side across available score rows.
  let home = 0;
  let away = 0;
  let hasAny = false;
  for (const s of scores) {
    const part = s.score?.participant;
    const g = s.score?.goals;
    if (typeof g !== "number" || !Number.isFinite(g)) continue;
    if (part === "home") {
      home = Math.max(home, g);
      hasAny = true;
    } else if (part === "away") {
      away = Math.max(away, g);
      hasAny = true;
    }
  }
  return hasAny ? home + away : null;
}

function getCornersTotalFromFixture(f: RawH2hFixture): number | null {
  const stats = unwrapArray<RawH2hStatistic>(f.statistics);
  if (stats.length === 0) return null;
  // Sum corners by participant_id, then total both sides. Keep robust to different type naming.
  const byParticipant = new Map<number, number>();
  for (const st of stats) {
    const typeName = (st.type?.name ?? "").toLowerCase();
    if (!typeName.includes("corner")) continue;
    const pid = st.participant_id;
    if (typeof pid !== "number" || pid <= 0) continue;
    const n = toNumberOrNull(st.value);
    if (n == null) continue;
    byParticipant.set(pid, Math.max(byParticipant.get(pid) ?? 0, n));
  }
  if (byParticipant.size === 0) return null;
  let total = 0;
  for (const v of byParticipant.values()) total += v;
  return Number.isFinite(total) ? total : null;
}

function resolveFixtureTeams(
  f: RawH2hFixture,
  team1Id: number,
  team2Id: number
): { team1Side: "home" | "away" | null; team2Side: "home" | "away" | null } {
  const participants = unwrapArray<RawH2hParticipant>(f.participants);
  const byId = new Map<number, RawH2hParticipant>();
  for (const p of participants) {
    if (typeof p.id === "number") byId.set(p.id, p);
  }
  const p1 = byId.get(team1Id);
  const p2 = byId.get(team2Id);
  const side = (p?: RawH2hParticipant): "home" | "away" | null => {
    const loc = p?.meta?.location;
    return loc === "home" ? "home" : loc === "away" ? "away" : null;
  };
  return { team1Side: side(p1), team2Side: side(p2) };
}

function getGoalsBySide(f: RawH2hFixture): { home: number | null; away: number | null } {
  const scores = unwrapArray<RawH2hScore>(f.scores);
  if (scores.length === 0) return { home: null, away: null };
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

export async function getHeadToHeadFixtureContext(
  team1Id: number,
  team2Id: number
): Promise<HeadToHeadFixtureContext | null> {
  if (!Number.isFinite(team1Id) || team1Id <= 0 || !Number.isFinite(team2Id) || team2Id <= 0) return null;

  const token = getApiToken();
  if (!token) {
    if (isDev()) console.log("[h2h] token missing; returning null context");
    return null;
  }

  const params = new URLSearchParams({
    api_token: token,
    include: H2H_INCLUDES,
  });
  const url = `${H2H_BASE}/${team1Id}/${team2Id}?${params.toString()}`;
  const safeUrl = `${H2H_BASE}/${team1Id}/${team2Id}?api_token=***&include=${H2H_INCLUDES}`;

  if (isDev()) {
    console.log("[h2h] request", { team1Id, team2Id, url: safeUrl });
  }

  let res: Response;
  let bodyText = "";
  try {
    res = await fetch(url);
    bodyText = await res.text();
  } catch (err) {
    if (isDev()) console.warn("[h2h] fetch failed", { team1Id, team2Id, errorMessage: err instanceof Error ? err.message : String(err) });
    return null;
  }

  if (!res.ok) {
    if (isDev()) {
      console.warn("[h2h] non-200 response", { team1Id, team2Id, status: res.status, bodyPreview: bodyText.slice(0, 160) });
    }
    return null;
  }

  let fixtures: RawH2hFixture[] = [];
  try {
    const json = JSON.parse(bodyText) as { data?: unknown };
    const data = json?.data;
    fixtures = Array.isArray(data) ? (data as RawH2hFixture[]) : [];
  } catch {
    if (isDev()) console.warn("[h2h] invalid JSON; returning null context", { team1Id, team2Id });
    return null;
  }

  if (fixtures.length === 0) {
    if (isDev()) console.log("[h2h] no fixtures returned; context=null", { team1Id, team2Id });
    return null;
  }

  const GOALS_LINES = [0.5, 1.5, 2.5, 3.5, 4.5] as const;
  const goalsLineOver = new Map<number, number>(GOALS_LINES.map((l) => [l, 0]));
  const goalsLineUnder = new Map<number, number>(GOALS_LINES.map((l) => [l, 0]));
  const goalsLineSample = new Map<number, number>(GOALS_LINES.map((l) => [l, 0]));

  let used = 0;
  let goalsSum = 0;
  let goalsCount = 0;
  let cornersSum = 0;
  let cornersCount = 0;
  let bttsYes = 0;
  let bttsCount = 0;
  let team1Wins = 0;
  let team2Wins = 0;
  let draws = 0;
  let resultCount = 0;
  let team1GoalsForSum = 0;
  let team1GoalsAgainstSum = 0;
  let team2GoalsForSum = 0;
  let team2GoalsAgainstSum = 0;
  let teamGoalsSample = 0;
  const recentTotalGoals: number[] = [];

  for (const f of fixtures) {
    used += 1;
    const totalGoals = getGoalsTotalFromFixture(f);
    if (totalGoals != null) {
      goalsSum += totalGoals;
      goalsCount += 1;
      if (recentTotalGoals.length < 5) recentTotalGoals.push(totalGoals);
      for (const line of GOALS_LINES) {
        goalsLineSample.set(line, (goalsLineSample.get(line) ?? 0) + 1);
        if (totalGoals > line) goalsLineOver.set(line, (goalsLineOver.get(line) ?? 0) + 1);
        else goalsLineUnder.set(line, (goalsLineUnder.get(line) ?? 0) + 1);
      }
    }

    const totalCorners = getCornersTotalFromFixture(f);
    if (totalCorners != null) {
      cornersSum += totalCorners;
      cornersCount += 1;
    }

    const { home, away } = getGoalsBySide(f);
    if (home != null && away != null) {
      bttsCount += 1;
      if (home > 0 && away > 0) bttsYes += 1;

      const teams = resolveFixtureTeams(f, team1Id, team2Id);
      const team1Goals = teams.team1Side === "home" ? home : teams.team1Side === "away" ? away : null;
      const team2Goals = teams.team2Side === "home" ? home : teams.team2Side === "away" ? away : null;
      if (team1Goals != null && team2Goals != null) {
        teamGoalsSample += 1;
        team1GoalsForSum += team1Goals;
        team1GoalsAgainstSum += team2Goals;
        team2GoalsForSum += team2Goals;
        team2GoalsAgainstSum += team1Goals;
        resultCount += 1;
        if (team1Goals > team2Goals) team1Wins += 1;
        else if (team2Goals > team1Goals) team2Wins += 1;
        else draws += 1;
      }
    }
  }

  const ctx: HeadToHeadFixtureContext = {
    sampleSize: used,
    averageTotalGoals: goalsCount > 0 ? goalsSum / goalsCount : null,
    averageTotalCorners: cornersCount > 0 ? cornersSum / cornersCount : null,
    bttsRate: bttsCount > 0 ? bttsYes / bttsCount : null,
    bttsYesCount: bttsCount > 0 ? bttsYes : undefined,
    bttsSampleSize: bttsCount > 0 ? bttsCount : undefined,
    team1WinRate: resultCount > 0 ? team1Wins / resultCount : null,
    team2WinRate: resultCount > 0 ? team2Wins / resultCount : null,
    drawRate: resultCount > 0 ? draws / resultCount : null,
    team1WinCount: resultCount > 0 ? team1Wins : undefined,
    team2WinCount: resultCount > 0 ? team2Wins : undefined,
    drawCount: resultCount > 0 ? draws : undefined,
    resultSampleSize: resultCount > 0 ? resultCount : undefined,
    goalsLineCounts:
      goalsCount > 0
        ? GOALS_LINES.map((line) => ({
            line,
            over: goalsLineOver.get(line) ?? 0,
            under: goalsLineUnder.get(line) ?? 0,
            sampleSize: goalsLineSample.get(line) ?? 0,
          }))
        : undefined,
    team1AvgGoalsScored: teamGoalsSample > 0 ? team1GoalsForSum / teamGoalsSample : null,
    team1AvgGoalsConceded: teamGoalsSample > 0 ? team1GoalsAgainstSum / teamGoalsSample : null,
    team2AvgGoalsScored: teamGoalsSample > 0 ? team2GoalsForSum / teamGoalsSample : null,
    team2AvgGoalsConceded: teamGoalsSample > 0 ? team2GoalsAgainstSum / teamGoalsSample : null,
    recentTotalGoals: recentTotalGoals.length > 0 ? recentTotalGoals : undefined,
  };

  if (isDev()) {
    console.log("[h2h] derived context", { team1Id, team2Id, ctx, fixturesReturned: fixtures.length, goalsCount, cornersCount, resultCount });
  }

  return ctx;
}

