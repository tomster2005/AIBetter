/**
 * Phase 1 player odds: backend-only, opt-in.
 * Only Sportmonks markets 334 (Player Shots On Target) and 336 (Player Shots).
 */

import { getFixtureDetails, extractLineupConfirmed } from "./fixtureDetails.js";
import type { RawFixtureDetails, RawLineupEntry } from "./fixture-details-types.js";

export type LineupSource = "confirmed" | "predicted" | "none";

const SPORTMONKS_ODDS_BASE = "https://api.sportmonks.com/v3/football/odds/pre-match/fixtures";

/** Only these market IDs are treated as player props. Order: 336 (Player Shots) then 334 (Player Shots On Target). */
const PLAYER_PROP_MARKET_IDS = [336, 334];
/** Display names for UI. 336 = Player Shots, 334 = Player Shots On Target. */
const PLAYER_PROP_MARKET_NAMES: Record<number, string> = {
  336: "Player Shots",
  334: "Player Shots On Target",
};

/** type_id 11 = starting XI in Sportmonks */
const TYPE_ID_STARTER = 11;

function getToken(): string | null {
  const t = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
  return typeof t === "string" && t.length > 0 ? t : null;
}

function unwrapLineups(lineups: unknown): RawLineupEntry[] | null {
  if (Array.isArray(lineups) && lineups.length > 0) return lineups as RawLineupEntry[];
  if (lineups && typeof lineups === "object" && "data" in lineups) {
    const d = (lineups as { data: unknown }).data;
    if (Array.isArray(d) && d.length > 0) return d as RawLineupEntry[];
  }
  return null;
}

/**
 * Returns allowed player IDs and info. Uses confirmed starters (type_id 11 or null) when present;
 * otherwise uses all lineup entries (predicted lineups). Also returns lineupSource and playerCount.
 */
function getStarterPlayerAllowList(details: RawFixtureDetails): {
  playerIds: Set<number>;
  playerInfo: Map<number, { playerName: string; teamId: number }>;
  lineupSource: LineupSource;
  playerCount: number;
} {
  const entries = unwrapLineups(details.lineups);
  const playerIds = new Set<number>();
  const playerInfo = new Map<number, { playerName: string; teamId: number }>();
  const noLineup: LineupSource = "none";
  if (!entries || entries.length === 0) {
    return { playerIds, playerInfo, lineupSource: noLineup, playerCount: 0 };
  }
  const lineupConfirmed = extractLineupConfirmed(details);
  const lineupSource: LineupSource = lineupConfirmed === true ? "confirmed" : "predicted";
  const starters = entries.filter(
    (e) => e.type_id === TYPE_ID_STARTER || e.type_id == null
  );
  const toUse = starters.length > 0 ? starters : entries;
  for (const e of toUse) {
    const id = e.player_id ?? (e.player as { id?: number } | undefined)?.id;
    if (typeof id === "number" && id > 0) {
      playerIds.add(id);
      const name = String(e.player_name ?? (e.player as { name?: string } | undefined)?.name ?? "Player").trim() || "Player";
      playerInfo.set(id, { playerName: name, teamId: e.team_id ?? 0 });
    }
  }
  return { playerIds, playerInfo, lineupSource, playerCount: playerIds.size };
}

/** Raw row from Sportmonks pre-match odds (player props may include participant_id / participants). */
interface PlayerOddRow {
  id?: number;
  fixture_id?: number;
  bookmaker_id?: number;
  market_id?: number;
  participant_id?: number;
  participants?: unknown;
  label?: string;
  value?: string | number;
  name?: string;
  total?: number | string;
  handicap?: number | string;
  market_description?: string;
  suspended?: boolean;
  stopped?: boolean;
  bookmaker?: { id?: number; name?: string; data?: { id?: number; name?: string } };
  participant?: { id?: number; name?: string; data?: { id?: number; name?: string } };
  market?: { id?: number; name?: string; description?: string; data?: { id?: number; name?: string; description?: string } };
  [key: string]: unknown;
}

const isDev = (): boolean => process.env.NODE_ENV !== "production";

/**
 * Single request to Sportmonks odds for fixture.
 * URL: https://api.sportmonks.com/v3/football/odds/pre-match/fixtures/{fixtureId}
 * Params: api_token, filters=markets:336,334;bookmakers:2 (or ;bookmakers:{id} if provided).
 */
async function fetchPlayerPropOdds(
  fixtureId: number,
  token: string,
  bookmakerId?: number | null
): Promise<{ rows: PlayerOddRow[]; status: number; url: string; filters: string }> {
  const baseUrl = `${SPORTMONKS_ODDS_BASE}/${fixtureId}`;
  const bookmaker = bookmakerId != null && bookmakerId > 0 ? bookmakerId : 2;
  const filters = `markets:336,334;bookmakers:${bookmaker}`;
  const url = `${baseUrl}?api_token=${encodeURIComponent(token)}&filters=${filters}`;
  try {
    const res = await fetch(url);
    const json = (await res.json()) as { data?: PlayerOddRow[] | { data?: PlayerOddRow[] } };
    const rawOdds = Array.isArray(json?.data)
      ? json.data
      : Array.isArray((json?.data as { data?: PlayerOddRow[] })?.data)
        ? (json.data as { data: PlayerOddRow[] }).data
        : [];
    if (isDev()) {
      console.log("[player-odds] final URL:", url);
      console.log("[player-odds] final filters string:", filters);
      console.log("[player-odds] response status:", res.status);
      console.log("[player-odds] raw row count (response.data / response.data.data):", rawOdds.length);
    }
    return { rows: rawOdds, status: res.status, url, filters };
  } catch (err) {
    if (isDev()) console.log("[player-odds] fetch error", err);
    return { rows: [], status: 0, url, filters };
  }
}

/** Only rows with market_id 334 or 336 are valid player props. */
function isPlayerPropRow(row: PlayerOddRow): boolean {
  const marketId = row.market_id ?? row.market?.id ?? (row.market as { data?: { id?: number } })?.data?.id;
  return typeof marketId === "number" && (marketId === 334 || marketId === 336);
}

/** Extract player id from a player-prop row. Returns null if not present. */
function getPlayerIdFromRow(row: PlayerOddRow): number | null {
  const id = row.participant_id ?? row.participant?.id ?? (row.participant as { data?: { id?: number } })?.data?.id;
  if (typeof id === "number" && id > 0) return id;
  const parts = row.participants;
  if (Array.isArray(parts) && parts.length > 0) {
    const first = parts[0] as { id?: number; data?: { id?: number } };
    const firstId = first?.id ?? first?.data?.id;
    if (typeof firstId === "number" && firstId > 0) return firstId;
  }
  return null;
}

/** Extract player name from row (participant relation) or fallback. */
function getPlayerNameFromRow(row: PlayerOddRow, playerId: number, lineupPlayerInfo: Map<number, { playerName: string; teamId: number }>): string {
  const fromLineup = lineupPlayerInfo.get(playerId);
  if (fromLineup?.playerName) return fromLineup.playerName;
  const p = row.participant;
  const name = p?.name ?? (p as { data?: { name?: string } })?.data?.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  const parts = row.participants;
  if (Array.isArray(parts) && parts.length > 0) {
    const first = parts[0] as { name?: string; data?: { name?: string } };
    const n = first?.name ?? first?.data?.name;
    if (typeof n === "string" && n.trim()) return n.trim();
  }
  return `Player ${playerId}`;
}

function parseOddsValue(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = parseFloat(String(v).replace(/,/g, "."));
  return Number.isFinite(n) ? n : null;
}

/** For 334/336, line comes from row.label (e.g. "0.5"). Otherwise total, handicap, or label. */
function getLineFromRow(row: PlayerOddRow, marketId?: number): number | null {
  if (marketId === 334 || marketId === 336) {
    const label = String(row.label ?? "").trim();
    if (label) {
      const n = parseFloat(label.replace(/,/g, "."));
      if (Number.isFinite(n)) return n;
    }
  }
  if (row.total != null) {
    const n = typeof row.total === "number" ? row.total : parseFloat(String(row.total).replace(/,/g, "."));
    if (Number.isFinite(n)) return n;
  }
  if (row.handicap != null) {
    const n = typeof row.handicap === "number" ? row.handicap : parseFloat(String(row.handicap).replace(/,/g, "."));
    if (Number.isFinite(n)) return n;
  }
  const fromLabel = (row.label ?? row.name ?? "").toString().match(/(\d+\.?\d*)/);
  if (fromLabel) {
    const n = parseFloat(fromLabel[1]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Normalized key for grouping by player name when participant_id is null. */
function normalizePlayerKey(name: string): string {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Stable numeric id for output: from participant_id or hash of name key. */
function playerKeyToId(playerKey: string): number {
  if (playerKey.startsWith("id:")) {
    const n = parseInt(playerKey.slice(3), 10);
    return Number.isFinite(n) ? n : 0;
  }
  let h = 0;
  for (let i = 0; i < playerKey.length; i++) h = ((h << 5) - h + playerKey.charCodeAt(i)) | 0;
  return h >>> 0 || 1;
}

function isOver(label: string): boolean {
  const l = label.toLowerCase();
  return l.startsWith("over") || l === "o" || (l.startsWith("o") && !l.startsWith("un"));
}

export interface PlayerOddsSelection {
  line: number;
  overOdds: number | null;
  underOdds: number | null;
  bookmakerId: number;
  bookmakerName: string;
}

export interface PlayerOddsPlayer {
  playerId: number;
  playerName: string;
  teamId: number;
  teamName: string;
  selections: PlayerOddsSelection[];
}

export interface PlayerOddsMarket {
  marketId: number;
  marketName: string;
  players: PlayerOddsPlayer[];
}

export interface PlayerOddsResponse {
  fixtureId: number;
  markets: PlayerOddsMarket[];
  /** Source of lineup used for player allow-list. */
  lineupSource?: LineupSource;
  /** Number of players in the allow-list (from lineup). */
  playerCount?: number;
}

/** Simplified debug shape: raw odds from Sportmonks before grouping. */
export interface PlayerOddsResponseRaw {
  fixtureId: number;
  markets: number[];
  bookmakerId: number | null;
  rawCount: number;
  odds: PlayerOddRow[];
}

/** Market display name for UI. 336 = Player Shots, 334 = Player Shots On Target. */
function getMarketName(marketId: number): string {
  return PLAYER_PROP_MARKET_NAMES[marketId] ?? `Market ${marketId}`;
}

/**
 * Fetches player prop odds for markets 334 and 336. Returns full PlayerOddsResponse with
 * markets[].players[].selections[]. Optional bookmakerId adds ;bookmakers:{id} to filters.
 */
export async function getPlayerOddsForFixture(
  fixtureId: number,
  bookmakerId?: number | null
): Promise<PlayerOddsResponse> {
  const empty = (lineupSource?: LineupSource, playerCount?: number): PlayerOddsResponse => ({
    fixtureId,
    markets: [
      { marketId: 336, marketName: "Player Shots", players: [] },
      { marketId: 334, marketName: "Player Shots On Target", players: [] },
    ],
    lineupSource: lineupSource ?? "none",
    playerCount: playerCount ?? 0,
  });

  const token = getToken();
  if (!token) {
    if (isDev()) console.log("[player-odds] no token");
    return empty();
  }

  let lineupSource: LineupSource = "none";
  let playerCount = 0;
  let playerInfo = new Map<number, { playerName: string; teamId: number }>();
  let teamIdToName = new Map<number, string>();

  try {
    const details = await getFixtureDetails(fixtureId);
    const list = getStarterPlayerAllowList(details);
    playerInfo = list.playerInfo;
    lineupSource = list.lineupSource;
    playerCount = list.playerCount;
    const participants = details.participants as Array<{ id?: number; name?: string; team_id?: number }> | undefined;
    if (participants && Array.isArray(participants)) {
      for (const p of participants) {
        const id = p.id ?? (p as { team_id?: number }).team_id;
        if (typeof id === "number" && typeof p.name === "string") teamIdToName.set(id, p.name);
      }
    }
  } catch {
    if (isDev()) console.log("[player-odds] getFixtureDetails failed, continuing without lineup enrichment");
  }

  const { rows } = await fetchPlayerPropOdds(fixtureId, token, bookmakerId);

  type PlayerEntry = {
    playerName: string;
    teamId: number;
    teamName: string;
    selections: PlayerOddsSelection[];
  };
  const byMarketId = new Map<number, { marketName: string; byPlayer: Map<string, PlayerEntry> }>();

  for (const marketId of PLAYER_PROP_MARKET_IDS) {
    byMarketId.set(marketId, { marketName: getMarketName(marketId), byPlayer: new Map() });
  }

  let rowsAccepted = 0;
  let rowsRejected = 0;
  const rejectReasons: Record<string, number> = {};

  for (const row of rows) {
    if (row.suspended === true || row.stopped === true) {
      rowsRejected++;
      rejectReasons["suspended_or_stopped"] = (rejectReasons["suspended_or_stopped"] ?? 0) + 1;
      continue;
    }
    const rawMarketId = row.market_id ?? row.market?.id ?? (row.market as { data?: { id?: number } })?.data?.id;
    const marketId = typeof rawMarketId === "number" ? rawMarketId : parseInt(String(rawMarketId), 10);
    if (marketId !== 334 && marketId !== 336) {
      rowsRejected++;
      rejectReasons["market_not_334_336"] = (rejectReasons["market_not_334_336"] ?? 0) + 1;
      continue;
    }
    // Markets 334/336: accept only when name, label, value exist. Do NOT require participant_id, participants, or total.
    const hasName = row.name != null && String(row.name).trim() !== "";
    const hasLabel = row.label != null && String(row.label).trim() !== "";
    const hasValue = row.value != null;
    if (!hasName) {
      rowsRejected++;
      rejectReasons["no_name"] = (rejectReasons["no_name"] ?? 0) + 1;
      continue;
    }
    if (!hasLabel) {
      rowsRejected++;
      rejectReasons["no_label"] = (rejectReasons["no_label"] ?? 0) + 1;
      continue;
    }
    if (!hasValue) {
      rowsRejected++;
      rejectReasons["no_value"] = (rejectReasons["no_value"] ?? 0) + 1;
      continue;
    }
    const playerName = String(row.name).trim();
    const playerKey = normalizePlayerKey(String(row.name));
    if (!playerKey) {
      rowsRejected++;
      rejectReasons["empty_player_key"] = (rejectReasons["empty_player_key"] ?? 0) + 1;
      continue;
    }
    const line = getLineFromRow(row, marketId);
    if (line == null) {
      rowsRejected++;
      rejectReasons["no_line"] = (rejectReasons["no_line"] ?? 0) + 1;
      continue;
    }
    const odds = parseOddsValue(row.value);
    if (odds == null) {
      rowsRejected++;
      rejectReasons["no_odds"] = (rejectReasons["no_odds"] ?? 0) + 1;
      continue;
    }
    const bookmakerId = row.bookmaker_id ?? row.bookmaker?.id ?? (row.bookmaker as { data?: { id?: number } })?.data?.id ?? 0;
    const bookmakerName =
      (row.bookmaker as { name?: string })?.name ?? (row.bookmaker as { data?: { name?: string } })?.data?.name ?? `Bookmaker ${bookmakerId}`;

    const marketEntry = byMarketId.get(marketId);
    if (!marketEntry) {
      rowsRejected++;
      rejectReasons["no_market_entry"] = (rejectReasons["no_market_entry"] ?? 0) + 1;
      continue;
    }
    rowsAccepted++;
    let playerEntry = marketEntry.byPlayer.get(playerKey);
    if (!playerEntry) {
      playerEntry = {
        playerName: playerName || "Unknown",
        teamId: 0,
        teamName: "",
        selections: [],
      };
      marketEntry.byPlayer.set(playerKey, playerEntry);
    }
    playerEntry.selections.push({
      line,
      overOdds: odds,
      underOdds: null,
      bookmakerId,
      bookmakerName,
    });
  }

  if (isDev()) {
    console.log("[player-odds] rows accepted:", rowsAccepted);
    console.log("[player-odds] rows rejected:", rowsRejected, rejectReasons);
  }

  const markets: PlayerOddsMarket[] = [];
  for (const marketId of PLAYER_PROP_MARKET_IDS) {
    const marketEntry = byMarketId.get(marketId)!;
    const players: PlayerOddsPlayer[] = [];
    for (const [playerKey, entry] of marketEntry.byPlayer) {
      const playerId = playerKeyToId(playerKey);
      players.push({
        playerId,
        playerName: entry.playerName,
        teamId: entry.teamId,
        teamName: entry.teamName || (entry.teamId > 0 ? `Team ${entry.teamId}` : ""),
        selections: entry.selections || [],
      });
    }
    markets.push({
      marketId,
      marketName: marketEntry.marketName,
      players,
    });
  }

  if (isDev()) {
    console.log("[player-odds] players per market:", markets.map((m) => ({ marketId: m.marketId, marketName: m.marketName, playersCount: m.players.length })));
    console.log("[player-odds] selections per market:", markets.map((m) => ({
      marketId: m.marketId,
      totalSelections: m.players.reduce((sum, p) => sum + (p.selections?.length ?? 0), 0),
    })));
  }

  return { fixtureId, markets, lineupSource, playerCount };
}
