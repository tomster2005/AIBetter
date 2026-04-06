/**
 * Sportmonks team stats for goal-line over/under data.
 * GET /v3/football/teams/{id}?include=statistics.details.type&season_id={seasonId}
 */

import type { TeamSeasonGoalLineStats, TeamGoalLineBreakdown } from "../types/teamSeasonStats.js";

const TEAM_BASE = "https://api.sportmonks.com/v3/football/teams";
const TEAM_INCLUDES = "statistics.details.type";
const GOAL_LINE_TYPE_ID = 197;

function getApiToken(): string {
  const token = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
  if (!token || typeof token !== "string") {
    throw new Error("Missing Sportmonks API token. Set SPORTMONKS_API_TOKEN or SPORTMONKS_TOKEN in your environment.");
  }
  return token;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, "."));
    return Number.isFinite(n) ? n : null;
  }
  if (v && typeof v === "object" && "total" in (v as object)) {
    const t = (v as { total?: unknown }).total;
    return toNumber(t);
  }
  return null;
}

function parseLineFromText(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  return Number.isFinite(n) ? n : null;
}

function extractCounts(value: unknown): Array<{ scope: "all" | "home" | "away"; over: number | null; under: number | null; total: number | null }> {
  const out: Array<{ scope: "all" | "home" | "away"; over: number | null; under: number | null; total: number | null }> = [];

  const readCounts = (scope: "all" | "home" | "away", obj: unknown) => {
    if (obj == null || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    const over = toNumber(o.over ?? o.over_count ?? o.over_total ?? o.overall_over ?? o.overall);
    const under = toNumber(o.under ?? o.under_count ?? o.under_total ?? o.overall_under);
    const total = toNumber(o.total ?? o.count ?? o.matches ?? o.played);
    if (over != null || under != null || total != null) {
      out.push({ scope, over, under, total });
    }
  };

  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (v.all || v.home || v.away) {
      readCounts("all", v.all);
      readCounts("home", v.home);
      readCounts("away", v.away);
      return out;
    }
    readCounts("all", v);
  }
  return out;
}

type FlatDetail = {
  typeId: number | null;
  typeName: string;
  typeCode: string;
  value: unknown;
};

function flattenStatDetails(raw: { statistics?: unknown[]; data?: { statistics?: unknown[] } }): FlatDetail[] {
  const stats = raw?.statistics ?? (raw as { data?: { statistics?: unknown[] } })?.data?.statistics;
  if (!Array.isArray(stats) || stats.length === 0) return [];

  const out: FlatDetail[] = [];
  for (const stat of stats) {
    const s = stat as { details?: unknown[]; type?: { id?: number; name?: string; code?: string; developer_name?: string }; value?: unknown };
    const details = Array.isArray(s?.details) ? s.details : [];
    if (details.length > 0) {
      for (const d of details) {
        const dd = d as { type_id?: number; type?: { id?: number; name?: string; code?: string; developer_name?: string }; value?: unknown };
        const typeIdRaw = dd.type_id ?? dd.type?.id ?? null;
        const typeId = typeof typeIdRaw === "number" && Number.isFinite(typeIdRaw) ? typeIdRaw : null;
        const typeName = String(dd.type?.name ?? dd.type?.code ?? dd.type?.developer_name ?? "").trim();
        const typeCode = String(dd.type?.code ?? "").trim();
        out.push({ typeId, typeName, typeCode, value: dd.value });
      }
    } else if (s?.type) {
      const typeIdRaw = s.type?.id ?? null;
      const typeId = typeof typeIdRaw === "number" && Number.isFinite(typeIdRaw) ? typeIdRaw : null;
      const typeName = String(s.type?.name ?? s.type?.code ?? s.type?.developer_name ?? "").trim();
      const typeCode = String(s.type?.code ?? "").trim();
      out.push({ typeId, typeName, typeCode, value: s.value });
    }
  }
  return out;
}

function parseGoalLineStats(entries: FlatDetail[]): TeamGoalLineBreakdown[] {
  const out: TeamGoalLineBreakdown[] = [];
  for (const e of entries) {
    const typeName = (e.typeName ?? "").toLowerCase();
    const isGoalLine = e.typeId === GOAL_LINE_TYPE_ID || typeName.includes("goal line") || typeName.includes("goals line");
    if (!isGoalLine) continue;

    let line = null as number | null;
    if (e.value && typeof e.value === "object") {
      const v = e.value as Record<string, unknown>;
      line = toNumber(v.line ?? v.goals ?? v.goal_line ?? v.line_value ?? v.threshold ?? v.limit);
    }
    if (line == null) {
      line = parseLineFromText(e.typeName) ?? parseLineFromText(e.typeCode);
    }
    if (line == null || !Number.isFinite(line)) continue;

    const counts = extractCounts(e.value);
    if (counts.length === 0) continue;
    for (const c of counts) {
      out.push({
        line,
        scope: c.scope,
        over: c.over,
        under: c.under,
        total: c.total,
      });
    }
  }
  return out;
}

export async function getTeamSeasonGoalLineStats(teamId: number, seasonId?: number): Promise<TeamSeasonGoalLineStats | null> {
  if (!Number.isFinite(teamId) || teamId <= 0) return null;
  const token = getApiToken();
  const params = new URLSearchParams({
    api_token: token,
    include: TEAM_INCLUDES,
  });
  if (seasonId != null && Number.isFinite(seasonId)) {
    params.set("season_id", String(seasonId));
  }
  const url = `${TEAM_BASE}/${teamId}?${params.toString()}`;
  const res = await fetch(url);
  const bodyText = await res.text();
  if (!res.ok) return null;

  let json: { data?: unknown };
  try {
    json = JSON.parse(bodyText) as { data?: unknown };
  } catch {
    return null;
  }
  const data = (json?.data ?? json) as { statistics?: unknown[] };
  const entries = flattenStatDetails(data as Parameters<typeof flattenStatDetails>[0]);
  const goalLineStats = parseGoalLineStats(entries);
  return {
    teamId,
    seasonId,
    goalLineStats,
  };
}
