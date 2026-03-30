/**
 * Player odds for value-bet analysis.
 * Fetches markets 336 (Player Shots), 334 (Player Shots On Target) from the generic fixture odds endpoint,
 * and 338/339/340 (Fouls Committed, Fouls Won, Player Tackles) from fixture+market-specific endpoints.
 */

import { getFixtureDetails, extractLineupConfirmed } from "./fixtureDetails.js";
import type { RawFixtureDetails, RawLineupEntry } from "./fixture-details-types.js";
import { getLineupEntryTypeId, unwrapLineupPlayer } from "../lib/lineupEntryHelpers.js";

export type LineupSource = "confirmed" | "predicted" | "none";

const SPORTMONKS_ODDS_BASE = "https://api.sportmonks.com/v3/football/odds/pre-match/fixtures";

/** Only these market IDs are treated as player props. Order: 336, 334, then 338, 339, 340. */
const PLAYER_PROP_MARKET_IDS = [336, 334, 338, 339, 340];
/** Display names for UI. Fouls names are normalized (Sportmonks may return "Player To Be Fouled" etc.). */
const PLAYER_PROP_MARKET_NAMES: Record<number, string> = {
  336: "Player Shots",
  334: "Player Shots On Target",
  338: "Player Fouls Committed",
  339: "Player Fouls Won",
  340: "Player Tackles",
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
  const starters = entries.filter((e) => {
    const tid = getLineupEntryTypeId(e);
    return tid === TYPE_ID_STARTER || tid == null;
  });
  const toUse = starters.length > 0 ? starters : entries;
  for (const e of toUse) {
    const { id, name: unName } = unwrapLineupPlayer(e);
    if (typeof id === "number" && id > 0) {
      playerIds.add(id);
      const name = String(unName ?? "Player").trim() || "Player";
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

/** Known bookmaker IDs → display name when API does not include bookmaker name. */
const BOOKMAKER_ID_TO_NAME: Record<number, string> = {
  1: "Bet365",
  2: "Bet365",
  3: "1xBet",
  4: "William Hill",
  5: "Pinnacle",
  6: "Marathonbet",
  7: "Unibet",
  8: "Betfair",
  9: "Bwin",
  10: "888sport",
  14: "Betway",
  34: "Betsson",
};

function resolveBookmakerName(
  bookmakerId: number,
  row: PlayerOddRow
): string {
  const fromRow =
    (row.bookmaker as { name?: string })?.name ??
    (row.bookmaker as { data?: { name?: string } })?.data?.name ??
    (row as { bookmaker_name?: string }).bookmaker_name ??
    (row as { bookmakerName?: string }).bookmakerName;
  if (typeof fromRow === "string" && fromRow.trim()) return fromRow.trim();
  const fromMap = bookmakerId > 0 ? BOOKMAKER_ID_TO_NAME[bookmakerId] : undefined;
  if (typeof fromMap === "string") return fromMap;
  return `Bookmaker ${bookmakerId}`;
}

/**
 * Single request to Sportmonks odds for fixture (markets 336, 334 only).
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
    return { rows: rawOdds, status: res.status, url, filters };
  } catch (err) {
    if (isDev()) console.log("[player-odds] fetch error", err);
    return { rows: [], status: 0, url, filters };
  }
}

/**
 * Fetch odds for a single market (e.g. 338 or 339) from
 * GET /v3/football/odds/pre-match/fixtures/{fixtureId}/markets/{marketId}
 * Supports filters=bookmakers:{id}. Response shape matches generic odds (data array of rows).
 */
async function fetchFixtureMarketOdds(
  fixtureId: number,
  marketId: number,
  token: string,
  bookmakerId?: number | null
): Promise<PlayerOddRow[]> {
  const bookmaker = bookmakerId != null && bookmakerId > 0 ? bookmakerId : 2;
  const baseUrl = `${SPORTMONKS_ODDS_BASE}/${fixtureId}/markets/${marketId}`;
  const url = `${baseUrl}?api_token=${encodeURIComponent(token)}&filters=bookmakers:${bookmaker}`;
  try {
    const res = await fetch(url);
    const json = (await res.json()) as { data?: PlayerOddRow[] | { data?: PlayerOddRow[] } };
    const raw = Array.isArray(json?.data)
      ? json.data
      : Array.isArray((json?.data as { data?: PlayerOddRow[] })?.data)
        ? (json.data as { data: PlayerOddRow[] }).data
        : [];
    return raw as PlayerOddRow[];
  } catch (err) {
    if (isDev()) console.log("[player-odds] fetch market", marketId, "error", err);
    return [];
  }
}

/** Only rows with market_id 334, 336, 338, 339, or 340 are valid player props. */
function isPlayerPropRow(row: PlayerOddRow): boolean {
  const marketId = row.market_id ?? row.market?.id ?? (row.market as { data?: { id?: number } })?.data?.id;
  return (
    typeof marketId === "number" &&
    (marketId === 334 || marketId === 336 || marketId === 338 || marketId === 339 || marketId === 340)
  );
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

/** For 334/336/338/339/340, line comes from row.label. Fouls/tackles use numeric-only labels e.g. "1.5", "2.5". */
function getLineFromRow(row: PlayerOddRow, marketId?: number): number | null {
  if (marketId === 334 || marketId === 336 || marketId === 338 || marketId === 339 || marketId === 340) {
    const label = String(row.label ?? "").trim();
    if (label) {
      const normalized = label.replace(/,/g, ".");
      let n = parseFloat(normalized);
      if (Number.isFinite(n)) return n;
      if (marketId === 338 || marketId === 339 || marketId === 340) {
        const digitsOnly = normalized.replace(/[^\d.]/g, "").replace(/\.+$/, "");
        if (digitsOnly) {
          n = parseFloat(digitsOnly);
          if (Number.isFinite(n)) return n;
        }
      }
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
 * Fetches player prop odds for markets 334, 336, 338, 339, 340. Returns full PlayerOddsResponse with
 * markets[].players[].selections[]. Optional bookmakerId adds ;bookmakers:{id} to filters.
 */
export async function getPlayerOddsForFixture(
  fixtureId: number,
  bookmakerId?: number | null
): Promise<PlayerOddsResponse> {
  const empty = (lineupSource?: LineupSource, playerCount?: number): PlayerOddsResponse => ({
    fixtureId,
    markets: PLAYER_PROP_MARKET_IDS.map((mid) => ({ marketId: mid, marketName: getMarketName(mid), players: [] })),
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

  const { rows: mainRows } = await fetchPlayerPropOdds(fixtureId, token, bookmakerId);

  const [rows338, rows339, rows340] = await Promise.all([
    fetchFixtureMarketOdds(fixtureId, 338, token, bookmakerId),
    fetchFixtureMarketOdds(fixtureId, 339, token, bookmakerId),
    fetchFixtureMarketOdds(fixtureId, 340, token, bookmakerId),
  ]);

  /** Normalize per-market player prop row: ensure market_id and use participant name when row.name is outcome (Over/Under). */
  const toFoulsRow = (r: PlayerOddRow, marketId: 338 | 339 | 340): PlayerOddRow => {
    const out = { ...r, market_id: marketId };
    const currentName = String(r.name ?? "").trim();
    const looksLikeOutcome = /^(over|under)\s/i.test(currentName) || /^\d+\.?\d*$/.test(currentName);
    if (looksLikeOutcome) {
      const fromParticipant =
        (r.participant as { name?: string })?.name ??
        (r.participant as { data?: { name?: string } })?.data?.name;
      const fromParts = Array.isArray(r.participants) && r.participants.length > 0
        ? (r.participants[0] as { name?: string; data?: { name?: string } })?.name ?? (r.participants[0] as { data?: { name?: string } })?.data?.name
        : undefined;
      const playerName = typeof fromParticipant === "string" && fromParticipant.trim()
        ? fromParticipant.trim()
        : typeof fromParts === "string" && fromParts.trim()
          ? fromParts.trim()
          : currentName;
      (out as { name: string }).name = playerName;
    }
    return out;
  };

  const normalized338 = rows338.map((r) => toFoulsRow(r, 338));
  const normalized339 = rows339.map((r) => toFoulsRow(r, 339));
  const normalized340 = rows340.map((r) => toFoulsRow(r, 340));

  /** For 334/336, row.name may be outcome (e.g. "Over 2.5"); use participant name when so. */
  const toShotsRow = (r: PlayerOddRow): PlayerOddRow => {
    const rawMid = r.market_id ?? r.market?.id ?? (r.market as { data?: { id?: number } })?.data?.id;
    const mid = typeof rawMid === "number" ? rawMid : parseInt(String(rawMid), 10);
    if (mid !== 334 && mid !== 336) return r;
    const currentName = String(r.name ?? "").trim();
    const looksLikeOutcome = /^(over|under)\s/i.test(currentName) || /^\d+\.?\d*$/.test(currentName.replace(/,/g, "."));
    if (!looksLikeOutcome && currentName !== "") return r;
    const fromParticipant =
      (r.participant as { name?: string })?.name ??
      (r.participant as { data?: { name?: string } })?.data?.name;
    const fromParts = Array.isArray(r.participants) && r.participants.length > 0
      ? (r.participants[0] as { name?: string; data?: { name?: string } })?.name ?? (r.participants[0] as { data?: { name?: string } })?.data?.name
      : undefined;
    const playerName = typeof fromParticipant === "string" && fromParticipant.trim()
      ? fromParticipant.trim()
      : typeof fromParts === "string" && fromParts.trim()
        ? fromParts.trim()
        : currentName || "Unknown";
    const out = { ...r };
    (out as { name: string }).name = playerName;
    return out;
  };
  const normalizedMainRows = mainRows.map(toShotsRow);

  const rows = [...normalizedMainRows, ...normalized338, ...normalized339, ...normalized340];

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

  for (const row of rows) {
    if (row.suspended === true || row.stopped === true) continue;
    const rawMarketId = row.market_id ?? row.market?.id ?? (row.market as { data?: { id?: number } })?.data?.id;
    const marketId = typeof rawMarketId === "number" ? rawMarketId : parseInt(String(rawMarketId), 10);
    if (marketId !== 334 && marketId !== 336 && marketId !== 338 && marketId !== 339 && marketId !== 340) continue;
    const hasName = row.name != null && String(row.name).trim() !== "";
    const hasLabel = row.label != null && String(row.label).trim() !== "";
    const hasValue = row.value != null;
    if (!hasName || !hasLabel || !hasValue) continue;
    const playerName = String(row.name).trim();
    // Regression fix: keep legacy name-hash grouping so odds players match lineup players reliably
    // even if Sportmonks uses different ID fields for participant vs player.
    const playerKey = normalizePlayerKey(String(row.name));
    if (!playerKey) continue;
    const line = getLineFromRow(row, marketId);
    if (line == null) continue;
    const odds = parseOddsValue(row.value);
    if (odds == null) continue;
    const bookmakerId = row.bookmaker_id ?? row.bookmaker?.id ?? (row.bookmaker as { data?: { id?: number } })?.data?.id ?? 0;
    const bookmakerName = resolveBookmakerName(bookmakerId, row);

    const marketEntry = byMarketId.get(marketId);
    if (!marketEntry) continue;
    const labelStr = String(row.label ?? "").trim();
    const isNumericOnly = /^\d+\.?\d*$/.test(labelStr.replace(/,/g, "."));
    const outcome =
      (marketId === 334 || marketId === 336 || marketId === 338 || marketId === 339 || marketId === 340) && isNumericOnly
        ? "Over"
        : isOver(labelStr)
          ? "Over"
          : "Under";
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
    const isOverOutcome = outcome === "Over";
    const existing = playerEntry.selections.find(
      (s) => s.line === line && s.bookmakerId === bookmakerId
    );
    if (existing) {
      if (isOverOutcome) existing.overOdds = odds;
      else existing.underOdds = odds;
    } else {
      playerEntry.selections.push({
        line,
        overOdds: isOverOutcome ? odds : null,
        underOdds: isOverOutcome ? null : odds,
        bookmakerId,
        bookmakerName,
      });
    }
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
    const m334 = markets.find((m) => m.marketId === 334);
    const m336 = markets.find((m) => m.marketId === 336);
    const m338 = markets.find((m) => m.marketId === 338);
    const m339 = markets.find((m) => m.marketId === 339);
    const m340 = markets.find((m) => m.marketId === 340);
    const players = (m: { players?: unknown[] } | undefined) => m?.players?.length ?? 0;
    const selections = (m: { players?: Array<{ selections?: unknown[] }> } | undefined) =>
      m?.players?.reduce((sum, p) => sum + (p.selections?.length ?? 0), 0) ?? 0;
    console.log("[player-odds backend] final player markets summary", {
      fixtureId,
      market334Players: players(m334),
      market336Players: players(m336),
      market338Players: players(m338),
      market339Players: players(m339),
      market340Players: players(m340),
      market334Selections: selections(m334),
      market336Selections: selections(m336),
      market338Selections: selections(m338),
      market339Selections: selections(m339),
      market340Selections: selections(m340),
    });
  }

  return { fixtureId, markets, lineupSource, playerCount };
}
