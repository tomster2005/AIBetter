/**
 * Frontend: fetch player profile from our API and normalize for UI.
 */

import type { PlayerProfile, PlayerCareerEntry, PlayerStatItem } from "../types/player.js";

type Raw = Record<string, unknown>;

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Extract a primitive value suitable for display (number or string). Never return object. */
function statValue(val: unknown): number | string | null {
  if (val == null) return null;
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") return val.trim() || null;
  const obj = val as Record<string, unknown>;
  if (typeof obj.value === "number" && Number.isFinite(obj.value)) return obj.value;
  if (typeof obj.value === "string") return obj.value.trim() || null;
  if (typeof obj.data === "object" && obj.data != null && typeof (obj.data as Record<string, unknown>).value !== "undefined") {
    return statValue((obj.data as Record<string, unknown>).value) ?? null;
  }
  return null;
}

/** Curated display labels for known Sportmonks stat types. Only these are shown. */
const CURATED_STAT_LABELS: Record<string, string> = {
  minutes: "Minutes Played",
  minutes_played: "Minutes Played",
  appearances: "Appearances",
  goals: "Goals",
  assists: "Assists",
  yellow_cards: "Yellow Cards",
  yellowcards: "Yellow Cards",
  red_cards: "Red Cards",
  redcards: "Red Cards",
  rating: "Rating",
  passes: "Passes",
  shots: "Shots Total",
  shots_total: "Shots Total",
  shots_on_target: "Shots on Target",
  bench: "Bench",
  bench_appearances: "Bench",
  tackles: "Tackles",
  interceptions: "Interceptions",
  key_passes: "Key Passes",
  keypasses: "Key Passes",
  successful_dribbles: "Successful Dribbles",
  accurate_passes: "Accurate Passes",
  cleansheets: "Cleansheets",
  clean_sheets: "Cleansheets",
  saves: "Saves",
  goals_conceded: "Goals Conceded",
};

const MAX_STATS_DISPLAY = 18;

/** Order for curated stats (first = higher priority when limiting). */
const STAT_PRIORITY_ORDER = [
  "Minutes Played",
  "Appearances",
  "Goals",
  "Assists",
  "Rating",
  "Yellow Cards",
  "Red Cards",
  "Passes",
  "Shots Total",
  "Shots on Target",
  "Bench",
  "Tackles",
  "Interceptions",
  "Key Passes",
  "Successful Dribbles",
  "Accurate Passes",
  "Cleansheets",
  "Saves",
  "Goals Conceded",
];

/** Competition name substrings that indicate cup / non-domestic-league. Prefer league over these. */
const CUP_LIKE_PATTERNS = [
  "cup",
  "fa cup",
  "carabao",
  "copa",
  "trophy",
  "super cup",
  "champions league",
  "europa league",
  "conference league",
  "friendly",
  "uefa",
  "world cup",
  "euro ",
  " nations league",
];

function isCupCompetition(name: string | null | undefined): boolean {
  if (!name || typeof name !== "string") return false;
  const lower = name.toLowerCase();
  return CUP_LIKE_PATTERNS.some((p) => lower.includes(p));
}

/** Domestic top/second tier league name hints. Prefer these over cups. */
const LEAGUE_LIKE_PATTERNS = [
  "premier league",
  "championship",
  "la liga",
  "bundesliga",
  "serie a",
  "ligue 1",
  "eredivisie",
  "scottish premiership",
  "pro league",
  "super lig",
  "league one",
  "league two",
  "primeira liga",
  "belgian pro league",
  "first division",
  "league",
];

function isLikelyDomesticLeague(name: string | null | undefined): boolean {
  if (!name || typeof name !== "string") return false;
  const lower = name.toLowerCase();
  if (CUP_LIKE_PATTERNS.some((p) => lower.includes(p))) return false;
  return LEAGUE_LIKE_PATTERNS.some((p) => lower.includes(p)) || (lower.includes("league") && !lower.includes("cup"));
}

/** Normalised stat group: one per statistics row from player.statistics[]. Only this row's details[] are used; no merging. */
type NormalisedStatGroup = {
  rowIndex: number;
  rowId: number | null;
  teamName: string | null;
  teamId: number | null;
  seasonId: number | null;
  leagueId: number | null;
  seasonName: string | null;
  competitionName: string | null;
  isCup: boolean;
  isLeague: boolean;
  stats: PlayerStatItem[];
  rawDetailCount: number;
  minutesPlayed: number | null;
  appearances: number | null;
  hasCoreAttackingStats: boolean;
};

/** Resolve details to an array (handles details as array or details.data). */
function getDetailsArray(statRow: Raw): Raw[] {
  const details = statRow.details;
  if (Array.isArray(details)) return details;
  const data = details && typeof details === "object" && (details as { data?: unknown }).data;
  return Array.isArray(data) ? (data as Raw[]) : [];
}

/** Sportmonks structure: detail.type.name → label, detail.value → value. Prefer type.name, fallback to curated map. */
function getDetailLabel(d: Raw): string | null {
  const typeObj = d.type as { name?: string; code?: string } | undefined;
  const name = typeObj?.name != null && typeof typeObj.name === "string" ? typeObj.name.trim() : null;
  if (name) return CURATED_STAT_LABELS[name.toLowerCase().replace(/\s+/g, "_")] ?? name;
  const code = typeObj?.code != null && typeof typeObj.code === "string" ? typeObj.code : null;
  const key = code ?? (d.type_id != null ? String(d.type_id) : null);
  if (!key) return null;
  const normalised = String(key).toLowerCase().replace(/\s+/g, "_");
  return CURATED_STAT_LABELS[normalised] ?? CURATED_STAT_LABELS[key] ?? null;
}

/** Possible keys where the numeric value might live in a stat detail. Do not assume field names. */
const VALUE_CANDIDATE_KEYS = ["value", "amount", "total", "statistic", "count", "values"];

/** Extract a usable number or string from any nested value (no raw objects). */
function extractPrimitive(val: unknown): number | string | null {
  if (val == null) return null;
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") {
    const s = val.trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      const v = extractPrimitive(val[i]);
      if (v !== null) return v;
    }
    return null;
  }
  if (typeof val === "object" && val !== null) {
    const o = val as Record<string, unknown>;
    for (const k of VALUE_CANDIDATE_KEYS) {
      const v = extractPrimitive(o[k]);
      if (v !== null) return v;
    }
    for (const k of Object.keys(o)) {
      const v = extractPrimitive(o[k]);
      if (v !== null) return v;
    }
  }
  return null;
}

/** Sportmonks structure: detail.value is the stat value. Use it first, then fallback to other keys. */
function extractDetailValue(d: Raw): number | string | null {
  if (d == null || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  if (o.value !== undefined) {
    const v = extractPrimitive(o.value);
    if (v !== null) return v;
  }
  for (const key of VALUE_CANDIDATE_KEYS) {
    if (key === "value") continue;
    const v = extractPrimitive(o[key]);
    if (v !== null) return v;
  }
  const data = o.data;
  if (data != null && typeof data === "object") {
    const v = extractDetailValue(data as Raw);
    if (v !== null) return v;
  }
  for (const key of Object.keys(o)) {
    if (key === "type" || key === "type_id") continue;
    const v = extractPrimitive(o[key]);
    if (v !== null) return v;
  }
  return null;
}

/** Safe detail normaliser: one detail -> { label, value } or null. Skips null/non-numeric/non-useful. */
function normaliseOneDetail(d: Raw): PlayerStatItem | null {
  const label = getDetailLabel(d);
  if (!label) return null;
  const value = extractDetailValue(d);
  if (value === null) return null;
  return { label, value };
}

/** Build one normalised stat group from ONE raw statistics row. Stats come from this row's details[] only (Sportmonks: detail.value, detail.type.name). */
function normaliseSingleGroup(statRow: Raw, rowIndex: number): NormalisedStatGroup {
  const rowId = num((statRow as { id?: number }).id) ?? null;
  const team = statRow.team as { name?: string; id?: number } | undefined;
  const teamName = team != null ? str(team.name) : null;
  const teamId = team != null && typeof team.id === "number" ? team.id : (num((statRow as { team_id?: number }).team_id) ?? null);

  const season = statRow.season as { name?: string } | undefined;
  const seasonName = season != null ? str(season.name) : null;
  const seasonId = num((statRow as { season_id?: number }).season_id) ?? null;

  const league = statRow.league as { name?: string } | undefined;
  const competitionName = league != null ? str(league.name) : null;
  const leagueId = num((statRow as { league_id?: number }).league_id) ?? null;

  const isCup = isCupCompetition(competitionName);
  const isLeague = isLikelyDomesticLeague(competitionName);

  const byLabel = new Map<string, number | string>();
  const detailsArr = getDetailsArray(statRow);

  for (const d of detailsArr) {
    const item = normaliseOneDetail(d);
    if (!item) continue;
    byLabel.set(item.label, item.value);
  }

  const ordered = STAT_PRIORITY_ORDER.filter((l) => byLabel.has(l));
  const stats = ordered.slice(0, MAX_STATS_DISPLAY).map((label) => ({ label, value: byLabel.get(label)! }));

  const toNum = (v: number | string | undefined): number | null => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    return Number.isFinite(n) ? n : null;
  };
  const minutesPlayed = toNum(byLabel.get("Minutes Played") as number | string | undefined);
  const appearances = toNum(byLabel.get("Appearances") as number | string | undefined);
  const coreLabels = ["Goals", "Assists", "Passes", "Shots Total"];
  const hasCoreAttackingStats = coreLabels.some((l) => byLabel.has(l));

  return {
    rowIndex,
    rowId,
    teamName,
    teamId,
    seasonId,
    leagueId,
    seasonName,
    competitionName,
    isCup,
    isLeague,
    stats,
    rawDetailCount: detailsArr.length,
    minutesPlayed,
    appearances,
    hasCoreAttackingStats,
  };
}

/** Build all normalised stat groups from raw statistics array. */
function buildNormalisedStatGroups(statistics: Raw[]): NormalisedStatGroup[] {
  return statistics.map((row, i) => normaliseSingleGroup(row, i));
}

/** Parse season string (e.g. "2025/2026", "2025/26") to start year for comparison. */
function parseSeasonYear(seasonName: string | null | undefined): number {
  if (!seasonName || typeof seasonName !== "string") return 0;
  const m = String(seasonName).trim().match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : 0;
}

type ResolvedCurrentTeam = { name: string | null; id: number | null; source: string };

/** Resolve player's current team: A) player response team, B) latest from statistics, C) none. */
function resolveCurrentTeam(raw: Raw): ResolvedCurrentTeam {
  const teamObj = raw.team as { name?: string; id?: number } | undefined;
  if (teamObj) {
    const name = str(teamObj.name);
    if (name && name !== "–") {
      return {
        name,
        id: teamObj && typeof teamObj.id === "number" ? teamObj.id : null,
        source: "player_response",
      };
    }
  }

  const statisticsRaw = raw.statistics as Array<Raw> | { data?: Raw[] } | undefined;
  const statistics: Raw[] = Array.isArray(statisticsRaw) ? statisticsRaw : (statisticsRaw as { data?: Raw[] })?.data ?? [];
  if (statistics.length > 0) {
    const withTeam = statistics
      .map((row) => {
        const team = row.team as { name?: string; id?: number } | undefined;
        const teamName = team ? str(team.name) : null;
        const teamId = team && typeof team.id === "number" ? team.id : null;
        const season = row.season as { name?: string } | undefined;
        const seasonName = season?.name != null ? str(season.name) : null;
        return { teamName, teamId, seasonYear: parseSeasonYear(seasonName) };
      })
      .filter((x) => x.teamName && x.teamName !== "–");
    withTeam.sort((a, b) => b.seasonYear - a.seasonYear);
    const latest = withTeam[0];
    if (latest) {
      return {
        name: latest.teamName,
        id: latest.teamId,
        source: "statistics_latest",
      };
    }
  }

  return { name: null, id: null, source: "none" };
}

function teamMatchesPlayer(playerTeamName: string | null, playerTeamId: number | null, group: NormalisedStatGroup): boolean {
  if (playerTeamId != null && group.teamId != null && playerTeamId === group.teamId) return true;
  if (!playerTeamName || !group.teamName) return false;
  return playerTeamName.toLowerCase().trim() === group.teamName.toLowerCase().trim();
}

/** Useful stats for quality check and count. Only these count as meaningful. */
const USEFUL_STAT_LABELS = new Set([
  "Minutes Played",
  "Appearances",
  "Goals",
  "Assists",
  "Rating",
  "Passes",
  "Shots Total",
  "Tackles",
  "Interceptions",
  "Successful Dribbles",
  "Accurate Passes",
  "Key Passes",
  "Yellow Cards",
  "Red Cards",
  "Shots on Target",
  "Cleansheets",
  "Saves",
  "Goals Conceded",
]);

function usefulStatCount(stats: PlayerStatItem[]): number {
  return stats.filter((s) => USEFUL_STAT_LABELS.has(s.label)).length;
}

/** Minimum useful stats required; groups with fewer are rejected. */
const MIN_USEFUL_STATS = 3;

/** Partial row thresholds: reject if all are true and a richer row exists for same team+season. */
const PARTIAL_MINUTES_MAX = 100;
const PARTIAL_APPEARANCES_MAX = 3;
const PARTIAL_USEFUL_MAX = 5;

/** Group key for team+season. */
function groupKey(g: NormalisedStatGroup): string {
  const team = (g.teamName ?? "").toLowerCase().trim();
  const season = (g.seasonName ?? "").trim();
  return `${team}|${season}`;
}

/** Richer row wins: more useful stats, then more details, then more minutes, then more appearances. */
function isRicherThan(a: NormalisedStatGroup, b: NormalisedStatGroup): boolean {
  const uA = usefulStatCount(a.stats);
  const uB = usefulStatCount(b.stats);
  if (uA !== uB) return uA > uB;
  if (a.rawDetailCount !== b.rawDetailCount) return a.rawDetailCount > b.rawDetailCount;
  const minA = a.minutesPlayed ?? 0;
  const minB = b.minutesPlayed ?? 0;
  if (minA !== minB) return minA > minB;
  const appA = a.appearances ?? 0;
  const appB = b.appearances ?? 0;
  return appA > appB;
}

/** True if row looks partial/weak (very low minutes, low appearances, low useful count). */
function looksPartial(g: NormalisedStatGroup): boolean {
  const minutes = g.minutesPlayed ?? 0;
  const apps = g.appearances ?? 0;
  const useful = usefulStatCount(g.stats);
  return minutes <= PARTIAL_MINUTES_MAX && apps <= PARTIAL_APPEARANCES_MAX && useful <= PARTIAL_USEFUL_MAX;
}

/** Core attacking/possession stats (goals, assists, shots, passes). */
const CORE_ATTACKING_LABELS = new Set(["Goals", "Assists", "Passes", "Shots Total"]);
/** Defensive/action stats. */
const DEFENSIVE_ACTION_LABELS = new Set(["Tackles", "Interceptions", "Key Passes", "Successful Dribbles", "Rating"]);

function hasCoreAttacking(g: NormalisedStatGroup): boolean {
  return g.stats.some((s) => CORE_ATTACKING_LABELS.has(s.label));
}
function hasRating(g: NormalisedStatGroup): boolean {
  return g.stats.some((s) => s.label === "Rating");
}
function hasDefensiveOrAction(g: NormalisedStatGroup): boolean {
  return g.stats.some((s) => DEFENSIVE_ACTION_LABELS.has(s.label));
}

/** Quality-only score: do not require season/team metadata. +40 useful>=8, +30 min>300, +20 app>=5, +20 core attacking, +10 rating, +10 defensive/action. */
function qualityOnlyScore(g: NormalisedStatGroup): number {
  let score = 0;
  const useful = usefulStatCount(g.stats);
  if (useful >= 8) score += 40;
  if ((g.minutesPlayed ?? 0) > 300) score += 30;
  if ((g.appearances ?? 0) >= 5) score += 20;
  if (hasCoreAttacking(g)) score += 20;
  if (hasRating(g)) score += 10;
  if (hasDefensiveOrAction(g)) score += 10;
  return score;
}

/** Pick best statistics row by quality only. Tiebreak: minutes, then appearances, then useful stat count. */
function pickBestByQuality(groups: NormalisedStatGroup[]): { group: NormalisedStatGroup | null; reason: string } {
  if (groups.length === 0) return { group: null, reason: "no_groups" };
  const withEnoughUseful = groups.filter((g) => usefulStatCount(g.stats) >= MIN_USEFUL_STATS);
  if (withEnoughUseful.length === 0) return { group: null, reason: "no_row_with_min_useful_stats" };

  const scored = withEnoughUseful.map((g) => ({ group: g, score: qualityOnlyScore(g) }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const minA = a.group.minutesPlayed ?? 0;
    const minB = b.group.minutesPlayed ?? 0;
    if (minB !== minA) return minB - minA;
    const appA = a.group.appearances ?? 0;
    const appB = b.group.appearances ?? 0;
    if (appB !== appA) return appB - appA;
    return usefulStatCount(b.group.stats) - usefulStatCount(a.group.stats);
  });
  const winner = scored[0];
  return { group: winner.group, reason: "highest_quality_score" };
}

export interface SelectedRowIds {
  rowId: number | null;
  teamId: number | null;
  seasonId: number | null;
}

type StatsResult = {
  items: PlayerStatItem[];
  competitionLabel: string | null;
  /** Set when label is fallback (e.g. "Statistics row X") so caller can resolve via backend. */
  selectedRowIds?: SelectedRowIds;
};

function normalizePlayerStatistics(rawStatistics: unknown, playerTeamName: string | null, playerTeamId: number | null): StatsResult {
  const statisticsRaw = rawStatistics as Array<Raw> | { data?: Raw[] } | undefined;
  const statistics: Raw[] = Array.isArray(statisticsRaw) ? statisticsRaw : (statisticsRaw as { data?: Raw[] })?.data ?? [];

  if (statistics.length === 0) {
    return { items: [], competitionLabel: null };
  }

  const groups = buildNormalisedStatGroups(statistics);
  const { group: selected } = pickBestByQuality(groups);

  if (!selected || selected.stats.length === 0) {
    return { items: [], competitionLabel: null };
  }

  const parts = [selected.competitionName, selected.teamName, selected.seasonName].filter((s) => s != null && String(s).trim() !== "");
  const isFallbackLabel = parts.length === 0;
  const competitionLabel = isFallbackLabel
    ? import.meta.env?.DEV && selected.rowId != null
      ? `Statistics row ${selected.rowId}`
      : "Statistics source: selected row"
    : parts.join(" — ");

  const result: StatsResult = {
    items: selected.stats,
    competitionLabel,
  };
  if (isFallbackLabel && (selected.seasonId != null || selected.teamId != null)) {
    result.selectedRowIds = {
      rowId: selected.rowId,
      teamId: selected.teamId,
      seasonId: selected.seasonId,
    };
  }
  return result;
}

/** Calculate age from date_of_birth (YYYY-MM-DD or partial). Returns null if invalid. */
function ageFromDob(dob: string | null | undefined): number | null {
  if (!dob || typeof dob !== "string") return null;
  const parts = dob.trim().split(/[-/]/);
  const y = parts[0] ? parseInt(parts[0], 10) : NaN;
  if (Number.isNaN(y)) return null;
  const today = new Date();
  let age = today.getUTCFullYear() - y;
  const m = parts[1] ? parseInt(parts[1], 10) : 0;
  const d = parts[2] ? parseInt(parts[2], 10) : 0;
  if (!Number.isNaN(m) && !Number.isNaN(d)) {
    const birth = new Date(y, m - 1, d);
    let monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) age -= 1;
  }
  return age >= 0 && age <= 120 ? age : null;
}

/** Names that suggest national/youth – de-prioritise when we have club data. */
const NATIONAL_OR_YOUTH_PATTERNS = /national|youth|u-?21|u-?23|under-?21|under-?23|olympics|nations league/i;

function isLikelyNationalOrYouth(teamName: string | null, competitionName: string | null): boolean {
  const combined = [teamName, competitionName].filter(Boolean).join(" ");
  return NATIONAL_OR_YOUTH_PATTERNS.test(combined);
}

function normalizePlayerCareer(raw: Raw): PlayerCareerEntry[] {
  const statisticsRaw = raw.statistics as Array<Raw> | { data?: Raw[] } | undefined;
  const statistics: Raw[] = Array.isArray(statisticsRaw) ? statisticsRaw : (statisticsRaw as { data?: Raw[] })?.data ?? [];

  const seen = new Set<string>();
  const fromStats: PlayerCareerEntry[] = [];

  for (const s of statistics) {
    const team = s.team as { name?: string; image_path?: string } | undefined;
    const season = s.season as { name?: string } | undefined;
    const teamName = team ? str(team.name) : null;
    const teamLogo = team && typeof team.image_path === "string" ? team.image_path : null;
    const seasonName = season ? str(season.name) : null;
    if (!teamName || teamName === "–") continue;
    const key = `${teamName.toLowerCase()}|${seasonName ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fromStats.push({
      teamName,
      teamLogo,
      season: seasonName ?? undefined,
      dateRange: undefined,
    });
  }

  if (fromStats.length > 0) {
    fromStats.sort((a, b) => (b.season ?? "").localeCompare(a.season ?? "", undefined, { numeric: true }));
    const clubOnly = fromStats.filter((e) => !isLikelyNationalOrYouth(e.teamName, null));
    const useEntries = clubOnly.length >= 2 ? clubOnly : fromStats;
    const merged: PlayerCareerEntry[] = [];
    for (const e of useEntries) {
      const last = merged[merged.length - 1];
      if (last && last.teamName?.toLowerCase() === e.teamName?.toLowerCase()) {
        const lastSeason = last.season ?? last.dateRange;
        const currSeason = e.season ?? "";
        if (lastSeason && currSeason) {
          const lastY = parseInt(String(lastSeason).split("/")[0], 10);
          const currY = parseInt(String(currSeason).split("/")[0], 10);
          if (!Number.isNaN(lastY) && !Number.isNaN(currY) && Math.abs(lastY - currY) <= 1) {
            last.dateRange = `${currSeason} – ${lastSeason}`;
            last.season = undefined;
            continue;
          }
        }
      }
      merged.push({ ...e });
    }
    return merged;
  }
  return [];
}

export interface PlayerResponseMeta {
  leagueName?: string;
  seasonName?: string;
  filtered?: boolean;
}

export interface NormalizePlayerResponseOverrides {
  statsSummary?: PlayerStatItem[];
  statsCompetitionLabel?: string | null;
}

export function normalizePlayerResponse(
  raw: Raw,
  meta?: PlayerResponseMeta | null,
  overrides?: NormalizePlayerResponseOverrides | null
): PlayerProfile {
  const id = num(raw.id) ?? 0;
  const name = str(raw.name) ?? str(raw.display_name) ?? "Unknown";
  const displayName = str(raw.display_name) ?? name;
  const image = str((raw as { image_path?: string }).image_path) ?? str((raw.image as { path?: string })?.path) ?? null;
  const shirtNumber = num((raw as { jersey_number?: number }).jersey_number) ?? null;
  const dob = str((raw as { date_of_birth?: string }).date_of_birth) ?? null;
  const age = ageFromDob(dob);
  const height = num((raw as { height?: number }).height) ?? null;
  const weight = num((raw as { weight?: number }).weight) ?? null;
  const preferredFoot = str((raw as { preferred_foot?: string }).preferred_foot) ?? null;

  const nationalityObj = raw.nationality as { name?: string; image_path?: string } | undefined;
  const nationality = nationalityObj ? str(nationalityObj.name) : null;
  const nationalityFlag = nationalityObj && typeof nationalityObj.image_path === "string" ? nationalityObj.image_path : null;

  const positionObj = raw.position as { name?: string } | undefined;
  const position = positionObj ? str(positionObj.name) : null;
  const detailedPosObj = raw.detailedPosition as { name?: string } | undefined;
  const detailedPosition = detailedPosObj ? str(detailedPosObj.name) : null;

  const resolved = resolveCurrentTeam(raw);
  const teamName = resolved.name ?? "–";
  const teamId = resolved.id;
  const teamObj = raw.team as { name?: string; image_path?: string; id?: number } | undefined;
  const teamLogo = teamObj && typeof teamObj.image_path === "string" ? teamObj.image_path : null;

  let statsSummary: PlayerStatItem[];
  let statsCompetitionLabel: string | null;

  if (overrides?.statsSummary != null && overrides?.statsCompetitionLabel !== undefined) {
    statsSummary = overrides.statsSummary;
    statsCompetitionLabel = overrides.statsCompetitionLabel;
  } else {
    const statsResult = normalizePlayerStatistics(raw.statistics, resolved.name, resolved.id);
    statsSummary = statsResult.items;
    let fromStats = statsResult.competitionLabel;
    if (meta?.filtered && meta.leagueName != null && meta.seasonName != null) {
      if (statsSummary.length === 0) {
        fromStats = "Current league season stats unavailable";
      } else {
        fromStats = `${meta.leagueName} — ${meta.seasonName}`;
      }
    } else if (meta?.filtered === false && import.meta.env?.DEV) {
      fromStats = fromStats ? `${fromStats} (fallback)` : "Statistics source: fallback";
    }
    statsCompetitionLabel = fromStats;
  }

  const careerEntries = normalizePlayerCareer(raw);

  return {
    id,
    name,
    displayName,
    image,
    teamName,
    teamLogo,
    nationality,
    nationalityFlag,
    shirtNumber,
    dateOfBirth: dob,
    age,
    height,
    weight,
    preferredFoot,
    position,
    detailedPosition,
    careerEntries,
    statsSummary,
    statsCompetitionLabel,
  };
}

export interface FetchPlayerProfileOptions {
  /** League name from fixture/lineup context (e.g. "Premier League"). Backend uses it to resolve current season and filter stats. */
  leagueName?: string;
  /** Team name from lineup context (for debug logging). */
  teamName?: string;
}

function getPlayerApiUrl(playerId: number, options?: FetchPlayerProfileOptions): string {
  const base = typeof import.meta.env !== "undefined" && import.meta.env?.VITE_API_ORIGIN;
  const origin = typeof base === "string" && base !== "" ? base.replace(/\/$/, "") : "";
  let url = `${origin}/api/players/${playerId}`;
  if (options?.leagueName && options.leagueName.trim()) {
    url += `?league=${encodeURIComponent(options.leagueName.trim())}`;
  }
  return url;
}

export interface StatsContextResponse {
  seasonName: string | null;
  leagueName: string | null;
  teamName: string | null;
}

function getStatsContextApiUrl(seasonId: number, teamId?: number | null): string {
  const base = typeof import.meta.env !== "undefined" && import.meta.env?.VITE_API_ORIGIN;
  const origin = typeof base === "string" && base !== "" ? base.replace(/\/$/, "") : "";
  const params = new URLSearchParams({ seasonId: String(seasonId) });
  if (teamId != null && teamId > 0) params.set("teamId", String(teamId));
  return `${origin}/api/stats-context?${params.toString()}`;
}

export async function fetchStatsContext(seasonId: number, teamId?: number | null): Promise<StatsContextResponse> {
  const url = getStatsContextApiUrl(seasonId, teamId);
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || res.statusText || "Failed to resolve stats context");
  }
  try {
    return JSON.parse(text) as StatsContextResponse;
  } catch {
    throw new Error("Invalid stats context response");
  }
}

export async function fetchPlayerProfile(playerId: number, options?: FetchPlayerProfileOptions): Promise<PlayerProfile> {
  const url = getPlayerApiUrl(playerId, options);
  const res = await fetch(url);
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  const isJson = contentType.includes("application/json");

  if (!isJson) {
    if (import.meta.env?.DEV) {
      console.warn("[player profile] non-JSON response", {
        playerId,
        url,
        status: res.status,
        contentType,
        responsePreview: text.slice(0, 200),
      });
    }
    throw new Error(
      res.ok
        ? "Invalid response from server. Please try again."
        : "Could not load player profile. Check that the API server is running and the route /api/players/:id is available."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (parseErr) {
    if (import.meta.env?.DEV) {
      console.warn("[player profile] JSON parse failed", { playerId, url, parseErr });
    }
    throw new Error("Invalid response from server. Please try again.");
  }

  if (!res.ok) {
    const message =
      typeof (parsed as { error?: string })?.error === "string"
        ? (parsed as { error: string }).error
        : res.statusText || "Failed to load player";
    throw new Error(message);
  }

  const hasWrapped = typeof parsed === "object" && parsed !== null && "data" in parsed;
  const raw = hasWrapped ? (parsed as { data: Raw }).data : (parsed as Raw);
  const meta = hasWrapped ? (parsed as { meta?: { leagueName?: string; seasonName?: string; filtered?: boolean } }).meta : undefined;

  const statsResult = normalizePlayerStatistics(
    (raw as Raw).statistics,
    resolveCurrentTeam(raw as Raw).name,
    resolveCurrentTeam(raw as Raw).id
  );

  let resolvedLabel: string | null = statsResult.competitionLabel;

  if (meta?.filtered && meta.leagueName != null && meta.seasonName != null) {
    if (statsResult.items.length === 0) {
      resolvedLabel = "Current league season stats unavailable";
    } else {
      resolvedLabel = `${meta.leagueName} — ${meta.seasonName}`;
    }
  } else if (meta?.filtered === false && import.meta.env?.DEV && statsResult.competitionLabel) {
    resolvedLabel = `${statsResult.competitionLabel} (fallback)`;
  } else if (
    statsResult.selectedRowIds &&
    statsResult.selectedRowIds.seasonId != null &&
    statsResult.selectedRowIds.seasonId > 0
  ) {
    const ids = statsResult.selectedRowIds;
    try {
      const ctx = await fetchStatsContext(ids.seasonId!, ids.teamId ?? undefined);
      if (ctx.leagueName && ctx.seasonName) {
        resolvedLabel = `${ctx.leagueName} — ${ctx.seasonName}`;
      } else if (ctx.teamName && ctx.seasonName) {
        resolvedLabel = `${ctx.teamName} — ${ctx.seasonName}`;
      } else if (ctx.seasonName) {
        resolvedLabel = ctx.seasonName;
      }
    } catch {
      // keep fallback label
    }
  }

  if (import.meta.env?.DEV) {
    console.log("[player profile] selected player id:", playerId, "| selected stats row id:", statsResult.selectedRowIds?.rowId ?? "—", "| stats source label:", resolvedLabel ?? "—");
  }

  return normalizePlayerResponse(raw as Raw, meta, {
    statsSummary: statsResult.items,
    statsCompetitionLabel: resolvedLabel,
  });
}
