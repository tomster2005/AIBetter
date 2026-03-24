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

/**
 * Lineup detail values: never coerce missing/null to 0 — that produced false leg losses on Over lines
 * when the stat was absent from the API payload.
 */
function toOptionalStatNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return undefined;
    const n = parseFloat(t.replace(",", "."));
    return Number.isFinite(n) ? n : undefined;
  }
  if (v && typeof v === "object" && "total" in (v as object)) {
    return toOptionalStatNumber((v as { total?: unknown }).total);
  }
  return undefined;
}

function unwrapArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && "data" in (value as object)) {
    const d = (value as { data?: unknown }).data;
    if (Array.isArray(d)) return d;
  }
  return [];
}

function normalizePlayerName(name: string): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ");
}

function readStatTypeKeys(detail: Record<string, unknown>): { name: string; dev: string } {
  const type = unwrapEntity<Record<string, unknown>>(detail.type) ?? {};
  const name = normalizeDetailName(String(type.name ?? detail.type_name ?? ""));
  const dev = normalizeDetailName(String(type.developer_name ?? type.developerName ?? detail.type_developer_name ?? ""));
  return { name, dev };
}

function mapStatKey(
  name: string,
  dev: string
): "shots" | "shotsOnTarget" | "foulsCommitted" | "foulsWon" | "tackles" | null {
  const d = dev.toUpperCase();
  if (d.includes("SHOTS_TOTAL")) return "shots";
  if (d.includes("SHOTS_ON_TARGET")) return "shotsOnTarget";
  if (d.includes("FOULS_COMMITTED")) return "foulsCommitted";
  if (d.includes("FOULS_WON")) return "foulsWon";
  if (d.includes("TACKLES")) return "tackles";

  if (name === "shots total" || name === "total shots" || name === "shots") return "shots";
  if (name === "shots on target" || name === "shots on goal" || name === "on target shots") return "shotsOnTarget";
  if (name.includes("foul") && (name.includes("commit") || name.includes("committed") || name === "fouls")) return "foulsCommitted";
  if (name.includes("foul") && (name.includes("won") || name.includes("drawn") || name.includes("suffered"))) return "foulsWon";
  if (
    name === "tackles" ||
    name === "total tackles" ||
    (name.includes("tackle") && !name.includes("dribbled") && !name.includes("interception"))
  ) {
    return "tackles";
  }
  return null;
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
 * Parse player stats from fixture statistics[].details[] (post-match source of truth).
 * No lineup-derived stat extraction here — lineups are not reliable for final stat settlement.
 */
export function parseResolutionPlayerStats(details: unknown): ResolutionPlayerStats[] {
  const fixtureObj = normalizeFixturePayload(details);
  const fixtureId =
    typeof fixtureObj.id === "number" && Number.isFinite(fixtureObj.id) ? fixtureObj.id : null;
  const statsRows = unwrapArray((details as { statistics?: unknown })?.statistics);
  type Acc = { playerId: number; playerName: string; stats: Omit<ResolutionPlayerStats, "playerId" | "playerName"> };
  const byId = new Map<number, Acc>();

  for (const rowRaw of statsRows) {
    const row = unwrapEntity<Record<string, unknown>>(rowRaw) ?? {};
    const participant = unwrapEntity<Record<string, unknown>>(row.participant);
    const playerIdRaw =
      row.player_id ??
      row.participant_id ??
      participant?.id ??
      row.id;
    const playerId = typeof playerIdRaw === "number" ? playerIdRaw : typeof playerIdRaw === "string" ? parseInt(playerIdRaw, 10) : 0;
    if (!Number.isFinite(playerId) || playerId <= 0) continue;

    const playerName = String(
      row.player_name ??
        participant?.name ??
        participant?.display_name ??
        participant?.common_name ??
        ""
    ).trim();
    const detailsList = unwrapArray(row.details);
    const prev = byId.get(playerId);
    if (!prev) {
      byId.set(playerId, { playerId, playerName, stats: {} });
    } else {
      if (playerName.length > prev.playerName.length) prev.playerName = playerName;
    }
    const acc = byId.get(playerId)!;

    for (const d of detailsList) {
      const detail = unwrapEntity<Record<string, unknown>>(d) ?? {};
      const { name, dev } = readStatTypeKeys(detail);
      const key = mapStatKey(name, dev);
      if (key == null) continue;
      const v = toOptionalStatNumber(detail.value);
      if (v === undefined) continue; // missing -> null/pending downstream, never implicit 0
      acc.stats[key] = v;
    }
  }

  const out: ResolutionPlayerStats[] = [];
  for (const { playerId, playerName, stats } of byId.values()) {
    const hasAny =
      stats.shots !== undefined ||
      stats.shotsOnTarget !== undefined ||
      stats.foulsCommitted !== undefined ||
      stats.foulsWon !== undefined ||
      stats.tackles !== undefined;
    if (!hasAny) continue;
    out.push({ playerId, playerName, ...stats });
  }

  if (import.meta.env.DEV) {
    const sample = out.slice(0, 8).map((p) => ({
      playerId: p.playerId,
      name: p.playerName,
      normalizedName: normalizePlayerName(p.playerName),
      shots: p.shots ?? null,
      shotsOnTarget: p.shotsOnTarget ?? null,
      foulsCommitted: p.foulsCommitted ?? null,
      foulsWon: p.foulsWon ?? null,
      tackles: p.tackles ?? null,
    }));
    console.log("[player-stats]", {
      fixtureId,
      playersFound: statsRows.length,
      statsExtracted: out.length,
      missingPlayers: Math.max(0, statsRows.length - out.length),
      sample,
    });
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
        tackles: p.tackles,
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
