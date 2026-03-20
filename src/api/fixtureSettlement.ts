/**
 * Fixture settlement: determine if a fixture is finished and get post-match player stats.
 * Used by the backtest settlement script to fill actualCount / actualOutcome.
 *
 * Sportmonks note:
 * - fixture.statistics are team-level only
 * - player match stats live under fixture.lineups[].details
 */

import type { RawFixtureDetails, RawLineupEntry } from "./fixture-details-types.js";

const FIXTURE_BASE = "https://api.sportmonks.com/v3/football/fixtures";
export const SETTLEMENT_INCLUDES =
  "participants;state;lineups;lineups.player;lineups.type;lineups.details;lineups.details.type";

export interface PlayerMatchStats {
  playerId: number;
  playerName: string;
  /** Minutes played in the fixture when present in lineup details. */
  minutesPlayed?: number;
  /** Whether the player was in the starting XI (when lineup type is present). */
  started?: boolean;
  /** Team id from lineup entry when present (useful for debug / scope). */
  teamId?: number;
  shots?: number;
  shotsOnTarget?: number;
  foulsCommitted?: number;
  foulsWon?: number;
  /** Debug: detail type that produced `foulsCommitted`. */
  foulsCommittedDetailTypeId?: number;
  /** Debug: detail type name that produced `foulsCommitted`. */
  foulsCommittedDetailTypeName?: string;
}

export interface FixtureOutcome {
  isFinished: boolean;
  playerResults: PlayerMatchStats[];
}

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === "object" && v != null && "total" in (v as object)) {
    const t = (v as { total?: unknown }).total;
    if (typeof t === "number" && Number.isFinite(t)) return t;
    if (typeof t === "string") {
      const n = parseFloat(t);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }
  return 0;
}

function getApiToken(): string {
  const token = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
  if (!token || typeof token !== "string") {
    throw new Error("Missing Sportmonks API token. Set SPORTMONKS_API_TOKEN or SPORTMONKS_TOKEN in your environment.");
  }
  return token;
}

async function getFixtureDetailsForSettlement(fixtureId: number): Promise<RawFixtureDetails> {
  const token = getApiToken();
  const params = new URLSearchParams({ api_token: token, include: SETTLEMENT_INCLUDES });
  const url = `${FIXTURE_BASE}/${fixtureId}?${params.toString()}`;
  const res = await fetch(url);
  const bodyText = await res.text();
  if (!res.ok) {
    const message = bodyText?.trim() || res.statusText || String(res.status);
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const json = JSON.parse(bodyText) as { data?: RawFixtureDetails };
  return (json?.data ?? (json as unknown as RawFixtureDetails)) as RawFixtureDetails;
}

/** Debug helper to confirm the exact include string + raw shape used for settlement. */
export async function getFixtureDetailsForSettlementDebug(fixtureId: number): Promise<RawFixtureDetails> {
  return await getFixtureDetailsForSettlement(fixtureId);
}

function unwrapArray(v: unknown): unknown[] {
  if (Array.isArray(v) && v.length > 0) return v as unknown[];
  if (v && typeof v === "object" && "data" in (v as object)) {
    const d = (v as { data?: unknown }).data;
    if (Array.isArray(d) && d.length > 0) return d as unknown[];
  }
  return [];
}

function unwrapLineups(lineups: unknown): RawLineupEntry[] {
  const arr = unwrapArray(lineups);
  return arr as RawLineupEntry[];
}

function normalizeDetailName(name: string): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, " ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ");
}

// If you later confirm Sportmonks type_ids for fouls, add them here.
const KNOWN_FOUL_TYPE_IDS = new Set<number>();

function getDetailTypeFields(detail: any): {
  typeId: number;
  typeName: string;
  typeCode: string;
  typeDeveloperName: string;
} {
  const typeName =
    detail?.type?.name ??
    detail?.type?.developer_name ??
    detail?.type?.code ??
    detail?.type?.developerName ??
    detail?.type?.label ??
    detail?.type_name ??
    detail?.typeName ??
    detail?.name ??
    "";

  const typeCode = detail?.type?.code ?? detail?.type?.typeCode ?? detail?.code ?? "";
  const typeDeveloperName = detail?.type?.developer_name ?? detail?.type?.developerName ?? detail?.developer_name ?? "";
  const rawTypeId = detail?.type_id ?? detail?.type?.id ?? detail?.type?.type_id ?? detail?.type?.typeId;
  const typeId = rawTypeId == null ? NaN : Number(rawTypeId);

  return {
    typeId,
    typeName: String(typeName ?? ""),
    typeCode: String(typeCode ?? ""),
    typeDeveloperName: String(typeDeveloperName ?? ""),
  };
}

function detailTypeText(detail: any): string {
  const f = getDetailTypeFields(detail);
  return `${f.typeName} ${f.typeCode} ${f.typeDeveloperName}`.toLowerCase();
}

function isFoulsWonDetail(detail: any): boolean {
  const t = detailTypeText(detail);
  const hasFoul = /foul/i.test(t);
  const wonLike = /won/i.test(t) || /drawn/i.test(t) || /suffered/i.test(t);
  // Won-like fouls must contain "foul" to avoid cards/duels etc.
  return hasFoul && wonLike;
}

function isFoulsCommittedDetail(detail: any): boolean {
  const t = detailTypeText(detail);
  const hasFoul = /foul/i.test(t);
  const wonLike = /won/i.test(t) || /drawn/i.test(t) || /suffered/i.test(t);
  if (!hasFoul || wonLike) return false;

  const committedLike = /commit/i.test(t) || /committed/i.test(t);
  // Priority: committed identifiers first; otherwise generic "fouls" rows map to committed.
  if (committedLike) return true;

  // Generic fallback: if it's clearly a foul metric but not "won-like", treat it as committed.
  return /fouls?/i.test(t);
}

function parseDetailsToStats(
  details: unknown[],
  playerIdForDebug?: number,
  fixtureIdForDebug?: number,
  debugOptions?: { targetFixtureId?: number; targetPlayerId?: number; targetPlayerName?: string }
): Partial<PlayerMatchStats> {
  const out: Partial<PlayerMatchStats> = {};

  const shouldLogTruffertRawRows =
    process.env.NODE_ENV !== "production" &&
    debugOptions?.targetFixtureId != null &&
    debugOptions?.targetPlayerId != null &&
    fixtureIdForDebug === debugOptions.targetFixtureId &&
    playerIdForDebug === debugOptions.targetPlayerId;

  if (shouldLogTruffertRawRows) {
    const foulRows = (details as any[])
      .map((detail) => {
        const { typeId, typeName, typeCode, typeDeveloperName } = getDetailTypeFields(detail);
        const rawValue = detail?.value ?? detail?.data?.value ?? null;
        const foulish =
          /foul/i.test(typeName) ||
          /foul/i.test(typeCode) ||
          /foul/i.test(typeDeveloperName) ||
          (Number.isFinite(typeId) && KNOWN_FOUL_TYPE_IDS.has(typeId));
        return foulish
          ? {
              typeId: Number.isFinite(typeId) ? typeId : null,
              typeName: typeName || null,
              typeCode: typeCode || null,
              typeDeveloperName: typeDeveloperName || null,
              rawValue,
            }
          : null;
      })
      .filter((x) => x != null);

    console.log("[truffert raw foul rows]", {
      fixtureId: fixtureIdForDebug ?? null,
      playerId: playerIdForDebug ?? null,
      playerName: debugOptions?.targetPlayerName ?? null,
      foulRows,
    });
  }

  for (const d of details) {
    const o = d as any;

    const { typeId, typeName: typeNameRaw, typeCode: typeCodeRaw, typeDeveloperName: typeDeveloperNameRaw } = getDetailTypeFields(o);
    const name = normalizeDetailName(typeNameRaw);

    const rawValue = o?.value ?? o?.data?.value ?? o?.value?.total ?? o?.data?.total;
    if (rawValue === undefined || rawValue === null) continue;
    const value = toNum(rawValue);

    // Note: no per-row foul debugging logs here; the caller can use [truffert raw foul rows]
    // for the final-fixture mismatch inspection.

    // Shots mapping (name-based first; id-based fallback for known type ids).
    if (name === "shots total" || name === "total shots" || name === "shots") {
      out.shots = value;
    } else if (name === "shots on target" || name === "shots on goal" || name === "on target shots") {
      out.shotsOnTarget = value;
    } else if (typeId === 84) {
      out.shots = value;
    } else if (typeId === 86) {
      out.shotsOnTarget = value;
    } else if (name.includes("shots") && !name.includes("on target") && !name.includes("on goal")) {
      out.shots = value;
    } else if (name.includes("shots on") && name.includes("target")) {
      out.shotsOnTarget = value;
    }

    // Fouls mapping: direct assignment based on dedicated helpers.
    // Priority order: won first, then committed (to ensure won-like never leaks into committed).
    if (isFoulsWonDetail(o)) {
      out.foulsWon = value;
    } else if (isFoulsCommittedDetail(o)) {
      out.foulsCommitted = value;
      out.foulsCommittedDetailTypeId = Number.isFinite(typeId) ? typeId : undefined;
      out.foulsCommittedDetailTypeName = typeNameRaw;
    }

    // Minutes mapping.
    if (
      (name.includes("minutes") && !name.includes("per")) ||
      name === "mins" ||
      name === "playing time" ||
      name === "minutes played" ||
      name.includes("playing time")
    ) {
      out.minutesPlayed = value;
    }
  }
  return out;
}

/**
 * Parse fixture.lineups[].details into player match stats (shots, shots on target, fouls).
 * Missing stats stay undefined (NOT 0).
 */
export function parseFixtureDetailsToPlayerStats(
  rawInput: unknown,
  debugOptions?: { targetFixtureId?: number; targetPlayerId?: number; targetPlayerName?: string }
): PlayerMatchStats[] {
  const raw = rawInput as any;
  const details = raw?.data ?? raw;

  const fixtureIdFromRaw =
    typeof raw?.data?.id === "number"
      ? raw.data.id
      : typeof raw?.data?.fixture_id === "number"
        ? raw.data.fixture_id
        : typeof raw?.id === "number"
          ? raw.id
          : undefined;

  console.log("[recent-debug parser entry]", {
    hasData: Boolean(raw?.data),
    lineupsType: Array.isArray(details?.lineups) ? "array" : typeof details?.lineups,
    lineupCount: Array.isArray(details?.lineups) ? details.lineups.length : null,
  });

  const lineups = Array.isArray(details?.lineups)
    ? details.lineups
    : Array.isArray(details?.lineups?.data)
      ? details.lineups.data
      : [];
  console.log("=== PARSER LINEUPS CHECK ===", {
    lineupCount: lineups.length,
    firstLineupKeys: lineups[0] ? Object.keys(lineups[0]) : [],
  });

  const entries =
    lineups.length > 0 ? (lineups as unknown as RawLineupEntry[]) : unwrapLineups((details as { lineups?: unknown })?.lineups);
  const results: PlayerMatchStats[] = [];
  let lineupLoggedCount = 0;
  for (let idx = 0; idx < entries.length; idx++) {
    const e = entries[idx]!;
    const rawPlayerId =
      (e as any).player_id ??
      (e as any)?.player?.id ??
      (e as any)?.player?.player_id ??
      (e as any)?.player?.playerId ??
      (e as any)?.player?.participant_id;
    const playerId = rawPlayerId == null ? 0 : Number(rawPlayerId);
    if (!Number.isFinite(playerId) || playerId <= 0) continue;

    const playerName =
      String(
        (e as any).player_name ??
          (e as any)?.player?.name ??
          (e as any)?.player?.player_name ??
          (e as any)?.player?.full_name ??
          "Unknown"
      ).trim() || "Unknown";

    const rawTypeId = (e as any)?.type_id ?? (e as any)?.type?.id ?? (e as any)?.type?.type_id;
    const rawTypeName = (e as any)?.type?.name ?? (e as any)?.type?.developer_name ?? (e as any)?.type?.code ?? null;
    const started =
      rawTypeId != null
        ? Number(rawTypeId) === 11
        : typeof rawTypeName === "string"
          ? rawTypeName.toLowerCase().includes("starting")
          : false;
    const teamIdRaw = (e as any)?.team_id ?? (e as any)?.team?.id ?? (e as any)?.team?.team_id;
    const teamId = teamIdRaw == null ? undefined : Number(teamIdRaw);

    const rawLineupDetails = (e as any)?.details;
    const detailsList: unknown[] = Array.isArray(rawLineupDetails)
      ? rawLineupDetails
      : Array.isArray((rawLineupDetails as any)?.data)
        ? (rawLineupDetails as any).data
        : [];

    if (lineupLoggedCount < 3) {
      const lineup = e as any;
      const detailsCandidateType = Array.isArray(lineup?.details)
        ? "details-array"
        : Array.isArray(lineup?.details?.data)
          ? "details-data-array"
          : typeof lineup?.details;
      const detailsLength = Array.isArray(lineup?.details)
        ? lineup.details.length
        : Array.isArray(lineup?.details?.data)
          ? lineup.details.data.length
          : null;
      const firstDetail = Array.isArray(lineup?.details)
        ? lineup.details[0] ?? null
        : Array.isArray(lineup?.details?.data)
          ? lineup.details.data[0] ?? null
          : null;

      const rawPlayerIdLog =
        lineup?.player_id ?? lineup?.player?.id ?? lineup?.player?.player_id ?? null;
      const rawPlayerNameLog = lineup?.player_name ?? lineup?.player?.name ?? null;

      console.log("[recent-debug parser lineup]", {
        idx,
        lineupKeys: lineup ? Object.keys(lineup) : [],
        rawPlayerId: rawPlayerIdLog,
        rawPlayerName: rawPlayerNameLog,
        detailsCandidateType,
        detailsLength,
        firstDetail,
      });
      lineupLoggedCount += 1;
    }

    const stats = parseDetailsToStats(detailsList, playerId, fixtureIdFromRaw, {
      targetFixtureId: debugOptions?.targetFixtureId,
      targetPlayerId: debugOptions?.targetPlayerId,
      targetPlayerName: debugOptions?.targetPlayerName,
    });

    // Only include if we have at least one stat field (including minutes = appearance).
    const hasAny =
      stats.shots !== undefined ||
      stats.shotsOnTarget !== undefined ||
      stats.foulsCommitted !== undefined ||
      stats.foulsWon !== undefined ||
      stats.minutesPlayed !== undefined;
    if (!hasAny) continue;

    results.push({
      playerId,
      playerName,
      started,
      teamId: Number.isFinite(teamId as number) ? teamId : undefined,
      ...stats,
    });
  }
  return results;
}

/**
 * Returns true if the fixture state indicates full time / finished.
 */
export function isFixtureFinished(details: RawFixtureDetails): boolean {
  const state = (details as { state?: { name_short?: string; name?: string } }).state;
  const short = (state?.name_short ?? state?.name ?? "").toUpperCase();
  const name = (state?.name ?? "").toLowerCase();
  return short === "FT" || name.includes("full time") || name.includes("finished") || short === "AOT";
}

/**
 * Fetch fixture and return whether it is finished and parsed player stats (if any).
 */
export async function getFixtureStateAndPlayerStats(fixtureId: number): Promise<FixtureOutcome> {
  const details = await getFixtureDetailsForSettlement(fixtureId);
  const isFinished = isFixtureFinished(details);
  const playerResults = parseFixtureDetailsToPlayerStats(details);
  return { isFinished, playerResults };
}
