type ResolutionPlayerStats = {
  playerId: number;
  playerName: string;
  shots?: number;
  shotsOnTarget?: number;
  foulsCommitted?: number;
  foulsWon?: number;
  tackles?: number;
};

export interface FixtureResolutionData {
  isFinished: boolean;
  playerResults: ResolutionPlayerStats[];
  playerStatsById: Record<number, Omit<ResolutionPlayerStats, "playerId" | "playerName">>;
  /** Full-time (or max CURRENT) goals when `scores` include is present on fixture details. */
  homeGoals: number | null;
  awayGoals: number | null;
}

function getApiOrigin(): string {
  const base = typeof import.meta.env !== "undefined" ? import.meta.env?.VITE_API_ORIGIN : undefined;
  return typeof base === "string" && base !== "" ? base.replace(/\/$/, "") : "";
}

function getFixtureDetailsApiUrl(fixtureId: number): string {
  return `${getApiOrigin()}/api/fixtures/${fixtureId}`;
}

function normalizeDetailName(name: string): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, " ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ");
}

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (v && typeof v === "object" && "total" in (v as object)) {
    const t = (v as { total?: unknown }).total;
    if (typeof t === "number" && Number.isFinite(t)) return t;
    if (typeof t === "string") {
      const n = parseFloat(t);
      return Number.isFinite(n) ? n : 0;
    }
  }
  return 0;
}

function unwrapArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && "data" in (value as object)) {
    const d = (value as { data?: unknown }).data;
    if (Array.isArray(d)) return d;
  }
  return [];
}

/** Sportmonks often nests included entities as `{ data: { ... } }`. */
function unwrapEntity<T extends Record<string, unknown>>(value: unknown): T | null {
  if (value == null || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (o.data != null && typeof o.data === "object" && !Array.isArray(o.data)) {
    return o.data as T;
  }
  return o as T;
}

/**
 * If API returns `{ data: { state, scores, … } }` (extra wrap), use inner object as fixture.
 */
function normalizeFixturePayload(root: unknown): Record<string, unknown> {
  const d = (root ?? {}) as Record<string, unknown>;
  const inner = d.data;
  if (
    inner &&
    typeof inner === "object" &&
    !Array.isArray(inner) &&
    ("state" in inner || "lineups" in inner || "scores" in inner || "participants" in inner || "state_id" in inner)
  ) {
    return inner as Record<string, unknown>;
  }
  return d;
}

/**
 * Finished fixture detection for `/api/fixtures/:id` raw Sportmonks payload (tolerant of nesting).
 */
export function isFixtureFinishedFromDetails(details: unknown): boolean {
  const fixture = normalizeFixturePayload(details);
  const rawState = fixture.state;
  if (typeof rawState === "number" && Number.isFinite(rawState)) {
    return rawState === 5 || rawState === 7;
  }
  const state = unwrapEntity<Record<string, unknown>>(rawState);
  const stateValues = [state?.name_short, state?.short_name, state?.developer_name, state?.code, state?.name]
    .filter(Boolean)
    .map((v) => String(v).toUpperCase().replace(/-/g, " "));

  const textFinished = stateValues.some((v) => {
    if (v === "FT" || v === "AOT") return true;
    return ["FULL TIME", "FINISHED", "AFTER EXTRA TIME", "PENALTIES"].some((key) => v.includes(key));
  });

  const sid = typeof state?.id === "number" && Number.isFinite(state.id) ? state.id : null;
  const rootSid = typeof fixture.state_id === "number" && Number.isFinite(fixture.state_id) ? fixture.state_id : null;

  return (
    textFinished ||
    (sid != null && [5, 7].includes(sid)) ||
    (rootSid != null && [5, 7].includes(rootSid))
  );
}

function buildParticipantIdToSide(details: unknown): Map<number, "home" | "away"> {
  const map = new Map<number, "home" | "away">();
  const parts = unwrapArray((details as { participants?: unknown }).participants);
  let fallback = 0;
  for (const p of parts) {
    const po = p as { id?: number; meta?: { location?: string } };
    const id = po.id;
    if (typeof id !== "number" || !Number.isFinite(id)) continue;
    const loc = po.meta?.location;
    let side: "home" | "away" | null = loc === "home" || loc === "away" ? loc : null;
    if (side == null) {
      side = fallback === 0 ? "home" : fallback === 1 ? "away" : null;
    }
    if (side) map.set(id, side);
    fallback += 1;
  }
  return map;
}

function finiteGoal(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function scoreRowGoals(row: Record<string, unknown>): number | null {
  const score = row.score as Record<string, unknown> | undefined;
  if (score && typeof score === "object") {
    const g = finiteGoal(score.goals);
    if (g != null) return g;
  }
  return finiteGoal(row.goals);
}

function getSideFromScoreRow(row: Record<string, unknown>, idToSide: Map<number, "home" | "away">): "home" | "away" | null {
  const scoreObj = row.score as Record<string, unknown> | undefined;
  const partRaw = scoreObj?.participant ?? row.participant;
  if (partRaw === "home" || partRaw === "away") return partRaw;
  if (typeof partRaw === "number" && Number.isFinite(partRaw)) return idToSide.get(partRaw) ?? null;
  if (partRaw && typeof partRaw === "object" && !Array.isArray(partRaw)) {
    const po = partRaw as { id?: number; location?: string; meta?: { location?: string } };
    const loc = po.location ?? po.meta?.location;
    if (loc === "home" || loc === "away") return loc;
    if (typeof po.id === "number") return idToSide.get(po.id) ?? null;
  }
  if (typeof row.participant_id === "number") return idToSide.get(row.participant_id) ?? null;
  return null;
}

/**
 * Merge lineup rows that share the same player_id (Sportmonks can repeat a player) so stats from all detail rows apply.
 */
export function parseResolutionPlayerStats(details: unknown): ResolutionPlayerStats[] {
  const lineups = unwrapArray((details as { lineups?: unknown })?.lineups);
  type Acc = { playerId: number; playerName: string; details: unknown[] };
  const byId = new Map<number, Acc>();
  for (const entry of lineups) {
    const e = entry as {
      player_id?: number;
      player_name?: string;
      player?: { id?: number; name?: string };
      details?: unknown;
    };
    const playerId = e.player_id ?? e.player?.id ?? 0;
    if (!Number.isFinite(playerId) || playerId <= 0) continue;
    const playerName = String(e.player_name ?? e.player?.name ?? "").trim();
    const detailsList = unwrapArray(e.details);
    const prev = byId.get(playerId);
    if (!prev) {
      byId.set(playerId, { playerId, playerName, details: [...detailsList] });
    } else {
      prev.details.push(...detailsList);
      if (playerName.length > prev.playerName.length) prev.playerName = playerName;
    }
  }
  const out: ResolutionPlayerStats[] = [];
  for (const { playerId, playerName, details: allDetails } of byId.values()) {
    const stats: ResolutionPlayerStats = { playerId, playerName };
    for (const d of allDetails) {
      const detail = d as { type?: { name?: string }; value?: unknown };
      const n = normalizeDetailName(detail?.type?.name ?? "");
      const v = toNum(detail?.value);
      if (!n) continue;
      if (n === "shots total" || n === "total shots" || n === "shots") stats.shots = v;
      else if (n === "shots on target" || n === "shots on goal" || n === "on target shots") stats.shotsOnTarget = v;
      else if (n.includes("foul") && (n.includes("commit") || n.includes("committed") || n === "fouls")) stats.foulsCommitted = v;
      else if (n.includes("foul") && (n.includes("won") || n.includes("drawn") || n.includes("suffered"))) stats.foulsWon = v;
      else if (
        n === "tackles" ||
        n === "total tackles" ||
        (n.includes("tackle") && !n.includes("dribbled") && !n.includes("interception"))
      ) {
        stats.tackles = v;
      }
    }
    out.push(stats);
  }
  return out;
}

/**
 * Home/away goals: `scores` array first, then `result` / `results` / `periods` fallbacks (Sportmonks shapes vary).
 */
export function extractFixtureGoals(details: unknown): { homeGoals: number | null; awayGoals: number | null } {
  const fixture = normalizeFixturePayload(details);
  const idToSide = buildParticipantIdToSide(fixture);
  const scores = unwrapArray(fixture.scores);
  let homeGoals: number | null = null;
  let awayGoals: number | null = null;

  for (const s of scores) {
    const row = s as Record<string, unknown>;
    const goals = scoreRowGoals(row);
    if (goals == null) continue;
    const side = getSideFromScoreRow(row, idToSide);
    if (side === "home") homeGoals = homeGoals == null ? goals : Math.max(homeGoals, goals);
    else if (side === "away") awayGoals = awayGoals == null ? goals : Math.max(awayGoals, goals);
  }

  if (homeGoals == null || awayGoals == null) {
    const resultLike = fixture.result ?? fixture.results ?? fixture.periods;
    if (resultLike != null) {
      const arr = unwrapArray(resultLike);
      if (arr.length > 0) {
        for (const item of arr) {
          const o = item as Record<string, unknown>;
          const h = finiteGoal(o.home ?? o.home_score ?? o.home_goals ?? o.localteam_score);
          const a = finiteGoal(o.away ?? o.away_score ?? o.away_goals ?? o.visitorteam_score);
          if (h != null) homeGoals = homeGoals == null ? h : Math.max(homeGoals, h);
          if (a != null) awayGoals = awayGoals == null ? a : Math.max(awayGoals, a);
        }
      } else {
        const o = (unwrapEntity(resultLike) ?? resultLike) as Record<string, unknown>;
        if (o && typeof o === "object" && !Array.isArray(o)) {
          const h = finiteGoal(o.home ?? o.localteam_score ?? o.home_score ?? o.home_goals);
          const a = finiteGoal(o.away ?? o.visitorteam_score ?? o.away_score ?? o.away_goals);
          if (h != null) homeGoals = homeGoals ?? h;
          if (a != null) awayGoals = awayGoals ?? a;
          const nested = o.goals as Record<string, unknown> | undefined;
          if (nested && typeof nested === "object") {
            const h2 = finiteGoal(nested.home ?? nested.local);
            const a2 = finiteGoal(nested.away ?? nested.visitor);
            if (h2 != null) homeGoals = homeGoals ?? h2;
            if (a2 != null) awayGoals = awayGoals ?? a2;
          }
        }
      }
    }
  }

  return { homeGoals, awayGoals };
}

/** @returns Both goals only when both are known (legacy helper). */
export function parseFullTimeGoalsFromFixtureDetails(details: unknown): { homeGoals: number; awayGoals: number } | null {
  const g = extractFixtureGoals(details);
  if (g.homeGoals != null && g.awayGoals != null) return { homeGoals: g.homeGoals, awayGoals: g.awayGoals };
  return null;
}

export async function fetchFixtureResolutionData(fixtureId: number): Promise<FixtureResolutionData> {
  const empty = (): FixtureResolutionData => ({
    isFinished: false,
    playerResults: [],
    playerStatsById: {},
    homeGoals: null,
    awayGoals: null,
  });
  try {
    const res = await fetch(getFixtureDetailsApiUrl(fixtureId));
    if (!res.ok) return empty();
    const json = (await res.json()) as { data?: unknown };
    const root = json?.data ?? json;
    const fixture = normalizeFixturePayload(root);

    if (import.meta.env.DEV && fixtureId === 19427188) {
      try {
        console.log("[fixture FULL RAW]", JSON.stringify(fixture, null, 2));
      } catch {
        console.log("[fixture FULL RAW]", "(could not stringify)", fixture);
      }
    }

    const isFinished = isFixtureFinishedFromDetails(fixture);
    const playerResults = parseResolutionPlayerStats(fixture);
    const playerStatsById: Record<number, Omit<ResolutionPlayerStats, "playerId" | "playerName">> = {};
    for (const p of playerResults) {
      playerStatsById[p.playerId] = {
        shots: p.shots,
        shotsOnTarget: p.shotsOnTarget,
        foulsCommitted: p.foulsCommitted,
        foulsWon: p.foulsWon,
      };
    }
    const { homeGoals, awayGoals } = extractFixtureGoals(fixture);

    if (import.meta.env.DEV) {
      console.log("[fixture-resolution-final]", {
        fixtureId,
        isFinished,
        homeGoals,
        awayGoals,
      });
    }

    return {
      isFinished,
      playerResults,
      playerStatsById,
      homeGoals,
      awayGoals,
    };
  } catch {
    return empty();
  }
}
