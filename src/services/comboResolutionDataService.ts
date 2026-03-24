import { debugLog } from "../lib/debugLog.js";

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
  const ts = Date.now();
  return `${getApiOrigin()}/api/fixtures/${fixtureId}?ts=${ts}`;
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
  const rootStateId = typeof fixture.state_id === "number" && Number.isFinite(fixture.state_id) ? fixture.state_id : null;
  if (rootStateId != null) {
    return rootStateId === 5;
  }

  const state = unwrapEntity<Record<string, unknown>>(fixture.state);
  const stateId = typeof state?.id === "number" && Number.isFinite(state.id) ? state.id : null;
  if (stateId != null) {
    return stateId === 5;
  }

  // Safety fallback when state_id is absent: treat as finished only if we have both goals and minute >= 90.
  const minute = getFixtureMinute(fixture);
  const g = extractFixtureGoals(fixture);
  const haveGoals = g.homeGoals != null && g.awayGoals != null;
  if (haveGoals && minute != null && minute >= 90) return true;

  return false;
}

function getFixtureMinute(fixture: Record<string, unknown>): number | null {
  const readMinute = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  const direct = readMinute(fixture.minute);
  if (direct != null) return direct;

  const time = unwrapEntity<Record<string, unknown>>(fixture.time);
  if (time) {
    const m1 = readMinute(time.minute);
    if (m1 != null) return m1;
    const m2 = readMinute(time.minutes);
    if (m2 != null) return m2;
    const status = unwrapEntity<Record<string, unknown>>(time.status);
    if (status) {
      const m3 = readMinute(status.minute);
      if (m3 != null) return m3;
      const m4 = readMinute(status.minutes);
      if (m4 != null) return m4;
    }
  }
  return null;
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
 * Parse player stats from fixture statistics (post-match source of truth).
 * Supports nested statistics[].details[] when present, or flat rows with statistics[].type + value (Sportmonks v3).
 * No lineup-derived stat extraction here — lineups are not reliable for final stat settlement.
 */
export function parseResolutionPlayerStats(details: unknown): ResolutionPlayerStats[] {
  const fixtureObj = normalizeFixturePayload(details);
  const fixtureId =
    typeof fixtureObj.id === "number" && Number.isFinite(fixtureObj.id) ? fixtureObj.id : null;
  const statsRows = unwrapArray((details as { statistics?: unknown })?.statistics);
  debugLog("playerStats", "[player-stats-shape]", {
    fixtureId,
    hasStatistics: Array.isArray(statsRows) && statsRows.length > 0,
    statisticsLength: statsRows.length,
    firstStatisticSample:
      statsRows.length > 0
        ? (() => {
            const first = unwrapEntity<Record<string, unknown>>(statsRows[0]) ?? {};
            const firstParticipant = unwrapEntity<Record<string, unknown>>(first.participant);
            const firstPlayer = unwrapEntity<Record<string, unknown>>(first.player);
            const detailsList = unwrapArray(first.details);
            const typeObj = unwrapEntity<Record<string, unknown>>(first.type);
            return {
              player_id: first.player_id ?? null,
              participant_id: first.participant_id ?? null,
              participantId: firstParticipant?.id ?? null,
              playerId: firstPlayer?.id ?? null,
              detailsLength: detailsList.length,
              hasTopLevelType: Boolean(typeObj && Object.keys(typeObj).length > 0),
            };
          })()
        : null,
  });
  type Acc = { playerId: number; playerName: string; stats: Omit<ResolutionPlayerStats, "playerId" | "playerName"> };
  const byId = new Map<number, Acc>();

  for (const rowRaw of statsRows) {
    const row = unwrapEntity<Record<string, unknown>>(rowRaw) ?? {};
    const playerObj = unwrapEntity<Record<string, unknown>>(row.player);
    const participant = unwrapEntity<Record<string, unknown>>(row.participant);
    const playerIdRaw =
      row.player_id ??
      row.participant_id ??
      playerObj?.id ??
      participant?.id ??
      null;
    const playerId = typeof playerIdRaw === "number" ? playerIdRaw : typeof playerIdRaw === "string" ? parseInt(playerIdRaw, 10) : 0;
    if (!Number.isFinite(playerId) || playerId <= 0) continue;

    const playerName = String(
      row.player_name ??
        participant?.name ??
        participant?.display_name ??
        participant?.common_name ??
        ""
    ).trim();
    const nestedStats = unwrapEntity<Record<string, unknown>>(row.statistics);
    let detailsList = [
      ...unwrapArray(row.details),
      ...unwrapArray(nestedStats?.details),
    ];
    const typeOnRow = unwrapEntity<Record<string, unknown>>(row.type);
    if (detailsList.length === 0 && (typeOnRow != null || row.value != null)) {
      detailsList = [row];
    }
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
    debugLog("playerStats", "[player-stats]", {
      fixtureId,
      playersFound: statsRows.length,
      statsExtracted: out.length,
      missingPlayers: Math.max(0, statsRows.length - out.length),
      sample,
    });
    const playerStatsMap: Record<number, Omit<ResolutionPlayerStats, "playerId" | "playerName">> = {};
    for (const p of out) {
      playerStatsMap[p.playerId] = {
        shots: p.shots,
        shotsOnTarget: p.shotsOnTarget,
        foulsCommitted: p.foulsCommitted,
        foulsWon: p.foulsWon,
        tackles: p.tackles,
      };
    }
    debugLog("playerStats", "[player-stats-map-keys]", {
      fixtureId,
      keys: Object.keys(playerStatsMap),
      count: Object.keys(playerStatsMap).length,
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
    const res = await fetch(getFixtureDetailsApiUrl(fixtureId), { cache: "no-store" });
    if (!res.ok) return empty();
    const json = (await res.json()) as { data?: unknown };
    const root = json?.data ?? json;
    const fixture = normalizeFixturePayload(root);

    if (import.meta.env.DEV && fixtureId === 19427188) {
      try {
        debugLog("playerStats", "[fixture FULL RAW]", JSON.stringify(fixture, null, 2));
      } catch {
        debugLog("playerStats", "[fixture FULL RAW]", { note: "(could not stringify)", fixture });
      }
    }

    const stateObj = unwrapEntity<Record<string, unknown>>(fixture.state);
    const rootStateId = typeof fixture.state_id === "number" && Number.isFinite(fixture.state_id) ? fixture.state_id : null;
    const nestedStateId = typeof stateObj?.id === "number" && Number.isFinite(stateObj.id) ? stateObj.id : null;
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
    const minute = getFixtureMinute(fixture);
    if (import.meta.env.DEV) {
      const reason =
        rootStateId != null || nestedStateId != null
          ? `state_id check (${rootStateId ?? nestedStateId} === 5)`
          : minute != null && homeGoals != null && awayGoals != null
            ? "fallback: scores present and minute>=90"
            : "not finished by state_id or fallback";
      debugLog("fixtureStatus", "[fixture-status]", {
        fixtureId,
        state_id: rootStateId ?? nestedStateId,
        minute,
        homeGoals,
        awayGoals,
        isFinished,
        reason,
      });
    }

    if (import.meta.env.DEV) {
      debugLog("fixtureStatus", "[fixture-resolution-final]", {
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
