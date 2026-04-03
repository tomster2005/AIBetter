/**
 * Minimal raw API response types for the fixtures/between endpoint
 * when using includes: participants;league;state;scores;lineups
 */

export interface RawParticipantMeta {
  location?: "home" | "away";
  [key: string]: unknown;
}

export interface RawParticipant {
  id: number;
  name: string;
  image_path?: string | null;
  meta?: RawParticipantMeta;
  [key: string]: unknown;
}

export interface RawLeague {
  id: number;
  name: string;
  image_path?: string | null;
  [key: string]: unknown;
}

export interface RawState {
  id: number;
  name: string;
  name_short?: string;
  short_name?: string;
  [key: string]: unknown;
}

export interface RawScoreItem {
  description?: string;
  score?: {
    goals?: number;
    participant?: "home" | "away";
  };
  [key: string]: unknown;
}

export interface RawLineupItem {
  formation_position?: number | null;
  type?: string | null;
  type_id?: number | null;
  [key: string]: unknown;
}

export interface RawFixtureItem {
  id: number;
  starting_at: string | null;
  participants?: RawParticipant[];
  league?: RawLeague;
  state?: RawState;
  scores?: RawScoreItem[];
  lineups?: RawLineupItem[] | { data?: RawLineupItem[] };
  [key: string]: unknown;
}

export interface RawFixturesPagination {
  count?: number;
  per_page?: number;
  current_page?: number;
  next_page?: string;
  has_more?: boolean;
}

export interface RawFixturesResponse {
  data: RawFixtureItem[];
  pagination?: RawFixturesPagination;
}
