import type { HeadToHeadFixtureContext } from "../types/headToHeadContext.js";

export interface HeadToHeadContextResponse {
  team1Id: number;
  team2Id: number;
  context: HeadToHeadFixtureContext | null;
}

function getApiOrigin(): string {
  const base =
    typeof import.meta.env !== "undefined" && import.meta.env?.VITE_API_ORIGIN;
  return typeof base === "string" && base !== "" ? base.replace(/\/$/, "") : "";
}

function getHeadToHeadContextApiUrl(team1Id: number, team2Id: number): string {
  const origin = getApiOrigin();
  return `${origin}/api/head-to-head/${team1Id}/${team2Id}/context`;
}

export async function loadHeadToHeadContext(team1Id: number, team2Id: number): Promise<HeadToHeadContextResponse> {
  const url = getHeadToHeadContextApiUrl(team1Id, team2Id);
  if (import.meta.env.DEV) {
    console.log("[h2h] frontend request", { team1Id, team2Id, url });
  }
  try {
    const res = await fetch(url);
    const json = (await res.json()) as { data?: HeadToHeadContextResponse };
    const data = (json?.data ?? json) as HeadToHeadContextResponse;
    const safe: HeadToHeadContextResponse = {
      team1Id: typeof data?.team1Id === "number" ? data.team1Id : team1Id,
      team2Id: typeof data?.team2Id === "number" ? data.team2Id : team2Id,
      context: data?.context ?? null,
    };
    if (import.meta.env.DEV) {
      console.log("[h2h] frontend response", {
        team1Id: safe.team1Id,
        team2Id: safe.team2Id,
        hasContext: safe.context != null,
        sampleSize: safe.context?.sampleSize ?? 0,
        averageTotalGoals: safe.context?.averageTotalGoals ?? null,
        averageTotalCorners: safe.context?.averageTotalCorners ?? null,
      });
    }
    return safe;
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[h2h] frontend fetch failed", { team1Id, team2Id, errorMessage: err instanceof Error ? err.message : String(err) });
    }
    return { team1Id, team2Id, context: null };
  }
}

