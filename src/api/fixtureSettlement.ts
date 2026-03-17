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
  shots?: number;
  shotsOnTarget?: number;
  foulsCommitted?: number;
  foulsWon?: number;
}

export interface FixtureOutcome {
  isFinished: boolean;
  playerResults: PlayerMatchStats[];
}

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "object" && v != null && "total" in (v as object)) {
    const t = (v as { total?: unknown }).total;
    return typeof t === "number" && Number.isFinite(t) ? t : 0;
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

function parseDetailsToStats(details: unknown[]): Partial<PlayerMatchStats> {
  const out: Partial<PlayerMatchStats> = {};
  for (const d of details) {
    const o = d as { type?: { name?: string }; value?: unknown };
    const name = normalizeDetailName(o?.type?.name ?? "");
    const value = toNum(o?.value);
    if (!name) continue;

    // Shots / shots on target mapping (common Sportmonks naming variants).
    if (name === "shots total" || name === "total shots" || name === "shots") out.shots = value;
    else if (name === "shots on target" || name === "shots on goal" || name === "on target shots") out.shotsOnTarget = value;
    else if (name.includes("foul") && (name.includes("commit") || name.includes("committed") || name === "fouls")) out.foulsCommitted = value;
    else if (name.includes("foul") && (name.includes("won") || name.includes("drawn") || name.includes("suffered"))) out.foulsWon = value;
  }
  return out;
}

/**
 * Parse fixture.lineups[].details into player match stats (shots, shots on target, fouls).
 * Missing stats stay undefined (NOT 0).
 */
export function parseFixtureDetailsToPlayerStats(details: RawFixtureDetails): PlayerMatchStats[] {
  const entries = unwrapLineups((details as { lineups?: unknown })?.lineups);
  const results: PlayerMatchStats[] = [];
  for (const e of entries) {
    const playerId = (e.player_id ?? (e.player as { id?: number })?.id) ?? 0;
    if (!Number.isFinite(playerId) || playerId <= 0) continue;

    const playerName = String(e.player_name ?? (e.player as { name?: string })?.name ?? "Unknown").trim() || "Unknown";
    const rawDetails = (e as { details?: unknown }).details;
    const detailsList = unwrapArray(rawDetails);
    const stats = parseDetailsToStats(detailsList);

    // Only include if we have at least one stat field.
    const hasAny =
      stats.shots !== undefined ||
      stats.shotsOnTarget !== undefined ||
      stats.foulsCommitted !== undefined ||
      stats.foulsWon !== undefined;
    if (!hasAny) continue;

    results.push({
      playerId,
      playerName,
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
