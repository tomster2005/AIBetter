/**
 * Normalized player profile shape for the UI.
 */

export interface PlayerCareerEntry {
  teamName: string;
  teamLogo: string | null;
  season?: string;
  dateRange?: string;
}

export interface PlayerStatItem {
  label: string;
  value: string | number;
}

export interface PlayerProfile {
  id: number;
  name: string;
  displayName: string;
  image: string | null;
  teamName: string;
  teamLogo: string | null;
  nationality: string | null;
  nationalityFlag: string | null;
  shirtNumber: number | null;
  dateOfBirth: string | null;
  age: number | null;
  height: number | null;
  weight: number | null;
  preferredFoot: string | null;
  position: string | null;
  detailedPosition: string | null;
  careerEntries: PlayerCareerEntry[];
  statsSummary: PlayerStatItem[];
  /** e.g. "Premier League 2025/26" - which competition/season the stats are from */
  statsCompetitionLabel: string | null;
}
