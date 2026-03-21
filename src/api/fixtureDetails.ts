/**
 * Fixture-by-ID API and lineup helper.
 * Uses ONLY the standard fixture details endpoint and regular fixture `lineups`.
 * Does NOT call expected-lineups endpoints or use any expected-lineups includes.
 */

import type {
  RawFixtureDetails,
  RawLineupEntry,
  RawFormationEntry,
  FixtureLineup,
  ReleasedLineup,
} from "./fixture-details-types.js";

const FIXTURE_BASE = "https://api.sportmonks.com/v3/football/fixtures";
/** Safe includes for standard fixture lineups only. No expectedLineups, predicted lineups, or premium expected-lineups. */
const LINEUP_INCLUDES =
  "participants;state;league;scores;lineups;lineups.player;lineups.type;lineups.details.type;venue;coaches;metadata";

function getApiToken(): string {
  const token = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
  if (!token || typeof token !== "string") {
    throw new Error(
      "Missing Sportmonks API token. Set SPORTMONKS_API_TOKEN or SPORTMONKS_TOKEN in your environment."
    );
  }
  return token;
}

/**
 * Fetches fixture details by ID with official lineup includes only.
 *
 * @param fixtureId - Sportmonks fixture ID
 * @returns Raw fixture details including lineups when available
 * @throws If API token is missing or request fails (e.g. 403 surfaces real message)
 */
function isDev(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Reads lineup_confirmed from fixture metadata when include=metadata is used.
 * Sportmonks: false = predicted/provisional lineup; true = club has released official lineup.
 */
export function extractLineupConfirmed(details: RawFixtureDetails): boolean | null {
  const direct = (details as { lineup_confirmed?: boolean }).lineup_confirmed;
  if (typeof direct === "boolean") return direct;

  const meta = (details as { metadata?: unknown }).metadata;
  if (!meta) return null;
  const list = Array.isArray(meta) ? meta : [meta];
  for (const item of list) {
    if (item == null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const key = String(o.type ?? o.name ?? o.key ?? "").toLowerCase();
    if (key.includes("lineup") && key.includes("confirm")) {
      const v = o.value ?? o.data ?? o.val;
      if (v === true || v === "true" || v === 1 || v === "1") return true;
      if (v === false || v === "false" || v === 0 || v === "0") return false;
    }
    if (o.lineup_confirmed === true) return true;
    if (o.lineup_confirmed === false) return false;
  }
  return null;
}

export async function getFixtureDetails(fixtureId: number): Promise<RawFixtureDetails> {
  const token = getApiToken();
  const params = new URLSearchParams({
    api_token: token,
    include: LINEUP_INCLUDES,
  });
  const url = `${FIXTURE_BASE}/${fixtureId}?${params.toString()}`;
  const safeUrl = `${FIXTURE_BASE}/${fixtureId}?api_token=***&include=${LINEUP_INCLUDES}`;
  if (isDev()) {
    console.log("[lineup] backend: request path = fixture details only (NOT expected-lineups)", {
      fixtureId,
      exactUrl: safeUrl,
      includeString: LINEUP_INCLUDES,
      endpoint: "GET /v3/football/fixtures/{id}",
    });
  }
  const res = await fetch(url);
  const bodyText = await res.text();
  if (!res.ok) {
    const message = bodyText?.trim() || res.statusText || String(res.status);
    if (isDev()) {
      console.error("[lineup] backend: Sportmonks error response", {
        fixtureId,
        status: res.status,
        body: bodyText,
        includeString: LINEUP_INCLUDES,
        exactUrl: safeUrl,
      });
    }
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  let data: RawFixtureDetails;
  try {
    const json = JSON.parse(bodyText) as { data?: RawFixtureDetails };
    data = json?.data as RawFixtureDetails;
  } catch (parseErr) {
    if (isDev()) {
      console.error("[lineup] backend: invalid JSON from Sportmonks", { fixtureId, parseErr });
    }
    throw new Error("Sportmonks API returned invalid JSON");
  }
  if (!data || typeof data.id === "undefined") {
    throw new Error("Sportmonks API returned invalid fixture data");
  }
  if (isDev()) {
    const hasLineups = Array.isArray(data.lineups);
    const lineupCount = hasLineups ? (data.lineups as RawLineupEntry[]).length : 0;
    const startingAt = (data as { starting_at?: string }).starting_at;
    const metadata = (data as { metadata?: unknown }).metadata;
    const lineupConfirmed = extractLineupConfirmed(data);
    const firstLineup = hasLineups ? (data.lineups as RawLineupEntry[])[0] : null;
    const lineupTypeSample =
      firstLineup && typeof firstLineup === "object"
        ? {
            type_id: firstLineup.type_id,
            typeKeys: firstLineup.type && typeof firstLineup.type === "object" ? Object.keys(firstLineup.type as object) : [],
          }
        : null;
    console.log("[lineup] backend: lineup status debug", {
      fixtureId,
      kickoffTime: startingAt ?? "—",
      lineupsArrayExists: hasLineups,
      lineupCount,
      lineupConfirmedFromMetadata: lineupConfirmed,
      metadataPresent: metadata != null,
      metadataType: metadata == null ? "none" : Array.isArray(metadata) ? "array" : typeof metadata,
      badgeLogicNote:
        "UI previously showed Released whenever lineup != null (any non-empty lineups array). Predictive lineups also populate lineups; use metadata.lineup_confirmed for official release.",
      firstLineupTypeSample: lineupTypeSample,
    });
  }
  return data;
}

/**
 * Returns lineup from fixture lineups when present, else null.
 * lineupConfirmed is set from metadata when available so the UI can distinguish official vs predictive.
 */
function unwrapLineupsArray(lineups: unknown): RawLineupEntry[] | null {
  if (Array.isArray(lineups) && lineups.length > 0) return lineups as RawLineupEntry[];
  if (lineups && typeof lineups === "object" && "data" in lineups) {
    const d = (lineups as { data: unknown }).data;
    if (Array.isArray(d) && d.length > 0) return d as RawLineupEntry[];
  }
  return null;
}

export function getLineupForFixture(details: RawFixtureDetails): FixtureLineup {
  const entries = unwrapLineupsArray(details.lineups);
  if (!entries) {
    return null;
  }
  const lineupConfirmed = extractLineupConfirmed(details);
  return {
    type: "released",
    data: entries,
    lineupConfirmed: lineupConfirmed === true ? true : lineupConfirmed === false ? false : undefined,
  };
}

/**
 * Extracts formation strings per team from raw fixture details.
 */
export function getFormationsFromDetails(details: RawFixtureDetails): { home?: string; away?: string } {
  const formations = details.formations as RawFormationEntry[] | undefined;
  if (!formations || !Array.isArray(formations)) return {};
  const out: { home?: string; away?: string } = {};
  for (const f of formations) {
    const loc = f.location;
    const formation = f.formation?.trim();
    if (loc === "home" && formation) out.home = formation;
    if (loc === "away" && formation) out.away = formation;
  }
  return out;
}

/** Coach/manager shape returned to the UI. */
export interface ExtractedCoach {
  name: string | null;
  image: string | null;
}

type CoachRecord = Record<string, unknown>;

function getCoachName(c: CoachRecord): string | null {
  const raw = c.fullname ?? c.name ?? (c as { display_name?: string }).display_name ?? null;
  return raw != null && String(raw).trim() !== "" ? String(raw).trim() : null;
}

function getCoachImage(c: CoachRecord): string | null {
  if (typeof c.image_path === "string" && c.image_path !== "") return c.image_path;
  const img = c.image as { path?: string } | undefined;
  if (img && typeof img.path === "string" && img.path !== "") return img.path;
  return null;
}

/** Get any team/participant identifier from coach (do not assume field name). */
function getCoachTeamOrParticipantId(c: CoachRecord): number | null {
  const teamId = c.team_id ?? (c as { team_id?: number }).team_id;
  if (typeof teamId === "number") return teamId;
  const teamObj = c.team as { id?: number } | undefined;
  if (teamObj && typeof teamObj.id === "number") return teamObj.id;
  const participantId = c.participant_id ?? (c as { participant_id?: number }).participant_id;
  if (typeof participantId === "number") return participantId;
  const participantObj = c.participant as { id?: number } | undefined;
  if (participantObj && typeof participantObj.id === "number") return participantObj.id;
  return null;
}

export function getCoachesFromDetails(
  details: RawFixtureDetails,
  teamIds?: { homeTeamId: number; awayTeamId: number }
): {
  home?: ExtractedCoach;
  away?: ExtractedCoach;
} {
  const coachesRaw = details.coaches as CoachRecord[] | undefined;
  if (!coachesRaw || !Array.isArray(coachesRaw) || coachesRaw.length === 0) {
    return {};
  }

  const participants = details.participants as Array<{
    id?: number;
    meta?: { location?: string };
    team_id?: number;
    [key: string]: unknown;
  }> | undefined;

  const participantIdToSide = new Map<number, "home" | "away">();
  if (participants && participants.length >= 2) {
    for (const p of participants) {
      const id = p.id;
      if (typeof id !== "number") continue;
      const loc = p.meta?.location;
      const side = loc === "home" ? "home" : loc === "away" ? "away" : null;
      participantIdToSide.set(id, side ?? (participants.indexOf(p) === 0 ? "home" : "away"));
    }
  }

  const out: { home?: ExtractedCoach; away?: ExtractedCoach } = {};

  for (const c of coachesRaw) {
    const name = getCoachName(c);
    const image = getCoachImage(c);
    const coach: ExtractedCoach = { name, image };

    const coachTeamOrParticipantId = getCoachTeamOrParticipantId(c);

    if (typeof coachTeamOrParticipantId === "number") {
      if (teamIds && (coachTeamOrParticipantId === teamIds.homeTeamId || coachTeamOrParticipantId === teamIds.awayTeamId)) {
        if (coachTeamOrParticipantId === teamIds.homeTeamId) out.home = coach;
        else out.away = coach;
        continue;
      }
      const side = participantIdToSide.get(coachTeamOrParticipantId);
      if (side) {
        out[side] = coach;
        continue;
      }
    }
  }

  if (coachesRaw.length === 2 && (!out.home || !out.away)) {
    out.home = out.home ?? { name: getCoachName(coachesRaw[1]), image: getCoachImage(coachesRaw[1]) };
    out.away = out.away ?? { name: getCoachName(coachesRaw[0]), image: getCoachImage(coachesRaw[0]) };
  }

  if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
    const coachSummary = coachesRaw.map((c, i) => ({
      index: i,
      id: (c as { id?: number }).id,
      name: getCoachName(c),
      team_id: c.team_id,
      participant_id: c.participant_id,
      "team?.id": (c.team as { id?: number } | undefined)?.id,
      "participant?.id": (c.participant as { id?: number } | undefined)?.id,
      team_link: getCoachTeamOrParticipantId(c),
    }));
    console.log("[lineup] coaches mapping debug", {
      homeTeamId: teamIds?.homeTeamId,
      awayTeamId: teamIds?.awayTeamId,
      participants: participants?.map((p, i) => ({ index: i, id: p.id, location: p.meta?.location })),
      participantIdToSide: Object.fromEntries(participantIdToSide),
      coaches: coachSummary,
      rawCoachesSummary: { count: coachesRaw.length, names: coachesRaw.map((c) => getCoachName(c)) },
      mappedHomeManager: out.home?.name ?? null,
      mappedAwayManager: out.away?.name ?? null,
    });
  }

  return out;
}
