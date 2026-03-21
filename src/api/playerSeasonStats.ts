/**
 * Player season statistics for value-bet model (shots, shots on target, fouls, tackles, minutes, appearances).
 * Uses Sportmonks GET /v3/football/players/{id}?include=statistics.details.type&filters=playerStatisticSeasons:{seasonId}
 */

import { getPlayerDetails } from "./playerDetails.js";

export interface PlayerSeasonStatsForProps {
  playerId: number;
  seasonId: number;
  shots: number;
  shotsOnTarget: number;
  /** Omit or set undefined when not parsed from API (do not default to 0 for missing). */
  foulsCommitted?: number;
  foulsWon?: number;
  /** Present when Sportmonks season stats include tackles (e.g. type name "Tackles"). */
  tackles?: number;
  minutesPlayed: number;
  appearances: number;
}

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "object" && v != null && "total" in v) {
    const t = (v as { total?: unknown }).total;
    return typeof t === "number" && Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/** Flatten statistics into list of { name, value }. Supports statistics[].details[] (Sportmonks) or flat statistics[] with type/value. */
function flattenStatEntries(raw: { statistics?: unknown[]; data?: { statistics?: unknown[] } }): Array<{ name: string; value: number }> {
  const stats = raw?.statistics ?? (raw as { data?: { statistics?: unknown[] } })?.data?.statistics;
  if (!Array.isArray(stats) || stats.length === 0) return [];

  const out: Array<{ name: string; value: number }> = [];
  for (const stat of stats) {
    const s = stat as { type?: { name?: string; code?: string; developer_name?: string }; value?: unknown; details?: Array<{ type?: { name?: string; code?: string; developer_name?: string }; value?: unknown }> };
    const details = s?.details ?? [];
    if (details.length > 0) {
      for (const d of details) {
        const t = (d as { type?: { name?: string; code?: string; developer_name?: string }; value?: unknown }).type;
        const v = (d as { value?: unknown }).value;
        const n = String(t?.name ?? t?.code ?? t?.developer_name ?? "").trim().toLowerCase().replace(/-/g, " ").replace(/_/g, " ");
        if (n) out.push({ name: n, value: toNum(v) });
      }
    } else if (s?.type) {
      const name = String(s.type?.name ?? s.type?.code ?? s.type?.developer_name ?? "").trim().toLowerCase().replace(/-/g, " ").replace(/_/g, " ");
      if (name) out.push({ name, value: toNum(s?.value) });
    }
  }
  return out;
}

/**
 * Fetches player stats for a season and extracts shots, shots on target, minutes, appearances.
 * Supports Sportmonks structures: statistics[].details[].type.name / value.total or flat statistics[].type.name / value.total.
 */
export async function getPlayerSeasonStatsForProps(
  playerId: number,
  seasonId: number
): Promise<PlayerSeasonStatsForProps | null> {
  const raw = await getPlayerDetails(playerId, { seasonId });

  if (process.env.NODE_ENV !== "production") {
    try {
      console.log("[sportmonks raw player]", JSON.stringify(raw, null, 2));
    } catch {
      console.log("[sportmonks raw player] (serialization skipped)");
    }
  }

  const entries = flattenStatEntries(raw as Parameters<typeof flattenStatEntries>[0]);

  if (process.env.NODE_ENV !== "production") {
    const foulRelated = entries.filter((e) => e.name.includes("foul"));
    console.log("[player-stats backend] foul-related flattened entries", foulRelated);
  }

  let shots = 0;
  let shotsOnTarget = 0;
  let foulsCommitted: number | undefined = undefined;
  let foulsWon: number | undefined = undefined;
  let tackles: number | undefined = undefined;
  let minutesPlayed = 0;
  let appearances = 0;
  let shotsSourceName: string | null = null;
  let shotsOnTargetSourceName: string | null = null;

  for (const stat of entries) {
    const name = (stat.name ?? "").toLowerCase().trim();
    const value = stat.value;
    if (!name) continue;

    // Shots / shots on target mapping. Prefer explicit, safe matches.
    const isShotsTotal =
      name === "shots total" ||
      name === "total shots" ||
      name === "shots";
    const isShotsOnTarget =
      name === "shots on target" ||
      name === "shots on goal" ||
      name === "on target shots";

    if (isShotsTotal) {
      shots = value;
      shotsSourceName = shotsSourceName ?? name;
    } else if (isShotsOnTarget) {
      shotsOnTarget = value;
      shotsOnTargetSourceName = shotsOnTargetSourceName ?? name;
    }
    if (
      name.includes("foul") &&
      (name.includes("commit") || name === "fouls" || name.includes("committed"))
    ) {
      foulsCommitted = value;
    } else if (
      name.includes("foul") &&
      (name.includes("won") || name.includes("drawn") || name.includes("suffered"))
    ) {
      foulsWon = value;
    } else if (
      name === "tackles" ||
      name === "total tackles" ||
      (name.includes("tackle") && !name.includes("dribbled") && !name.includes("interception"))
    ) {
      tackles = value;
    }
    if (name.includes("minute")) {
      minutesPlayed = value;
    }
    if (name.includes("appearance")) {
      appearances = value;
    }
  }

  if (process.env.NODE_ENV !== "production") {
    console.log("[player-stats backend] parsed fouls", {
      playerId,
      foulsCommitted,
      foulsWon,
    });
    console.log("[parsed player stats]", {
      playerId,
      shots,
      shotsOnTarget,
      foulsCommitted,
      foulsWon,
      tackles,
      minutesPlayed,
      appearances,
    });
    console.log("[player-stats] raw mapping audit", {
      playerId,
      rawShotsFieldName: shotsSourceName,
      rawShotsValue: shots,
      rawShotsOnTargetFieldName: shotsOnTargetSourceName,
      rawShotsOnTargetValue: shotsOnTarget,
      mappedShots: shots,
      mappedShotsOnTarget: shotsOnTarget,
    });
  }

  return {
    playerId,
    seasonId,
    shots,
    shotsOnTarget,
    ...(foulsCommitted !== undefined && { foulsCommitted }),
    ...(foulsWon !== undefined && { foulsWon }),
    ...(tackles !== undefined && { tackles }),
    minutesPlayed,
    appearances,
  };
}
