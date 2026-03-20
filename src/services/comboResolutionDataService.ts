type ResolutionPlayerStats = {
  playerId: number;
  playerName: string;
  shots?: number;
  shotsOnTarget?: number;
  foulsCommitted?: number;
  foulsWon?: number;
};

export interface FixtureResolutionData {
  isFinished: boolean;
  playerResults: ResolutionPlayerStats[];
  playerStatsById: Record<number, Omit<ResolutionPlayerStats, "playerId" | "playerName">>;
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

export function isFixtureFinishedFromDetails(details: unknown): boolean {
  const state = (details as { state?: { name_short?: string; name?: string } })?.state;
  const short = String(state?.name_short ?? state?.name ?? "").toUpperCase();
  const name = String(state?.name ?? "").toLowerCase();
  return short === "FT" || short === "AOT" || name.includes("full time") || name.includes("finished");
}

export function parseResolutionPlayerStats(details: unknown): ResolutionPlayerStats[] {
  const out: ResolutionPlayerStats[] = [];
  const lineups = unwrapArray((details as { lineups?: unknown })?.lineups);
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
    const stats: ResolutionPlayerStats = { playerId, playerName };
    for (const d of detailsList) {
      const detail = d as { type?: { name?: string }; value?: unknown };
      const n = normalizeDetailName(detail?.type?.name ?? "");
      const v = toNum(detail?.value);
      if (!n) continue;
      if (n === "shots total" || n === "total shots" || n === "shots") stats.shots = v;
      else if (n === "shots on target" || n === "shots on goal" || n === "on target shots") stats.shotsOnTarget = v;
      else if (n.includes("foul") && (n.includes("commit") || n.includes("committed") || n === "fouls")) stats.foulsCommitted = v;
      else if (n.includes("foul") && (n.includes("won") || n.includes("drawn") || n.includes("suffered"))) stats.foulsWon = v;
    }
    out.push(stats);
  }
  return out;
}

export async function fetchFixtureResolutionData(fixtureId: number): Promise<FixtureResolutionData> {
  try {
    const res = await fetch(getFixtureDetailsApiUrl(fixtureId));
    if (!res.ok) return { isFinished: false, playerResults: [], playerStatsById: {} };
    const json = (await res.json()) as { data?: unknown };
    const details = json?.data ?? json;
    const isFinished = isFixtureFinishedFromDetails(details);
    const playerResults = parseResolutionPlayerStats(details);
    const playerStatsById: Record<number, Omit<ResolutionPlayerStats, "playerId" | "playerName">> = {};
    for (const p of playerResults) {
      playerStatsById[p.playerId] = {
        shots: p.shots,
        shotsOnTarget: p.shotsOnTarget,
        foulsCommitted: p.foulsCommitted,
        foulsWon: p.foulsWon,
      };
    }
    return { isFinished, playerResults, playerStatsById };
  } catch {
    return { isFinished: false, playerResults: [], playerStatsById: {} };
  }
}
