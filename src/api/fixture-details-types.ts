/**
 * Minimal types for fixture-by-ID response with lineup includes.
 * Used by getFixtureDetails and getLineupForFixture.
 */

export interface RawLineupEntry {
  id?: number;
  fixture_id?: number;
  player_id?: number;
  team_id?: number;
  player_name?: string;
  jersey_number?: number;
  position_id?: number;
  formation_field?: string | null;
  formation_position?: number | null;
  type_id?: number;
  [key: string]: unknown;
}

export interface RawFormationEntry {
  formation?: string;
  location?: "home" | "away";
  participant_id?: number;
  [key: string]: unknown;
}

/** Fixture-by-ID response with optional lineups, formations. */
export interface RawFixtureDetails {
  id: number;
  lineups?: RawLineupEntry[];
  formations?: RawFormationEntry[];
  [key: string]: unknown;
}

/** Lineup payload from fixture.lineups; lineupConfirmed from metadata when available. */
export interface ReleasedLineup {
  type: "released";
  data: RawLineupEntry[];
  /** true = Sportmonks metadata lineup_confirmed; false = predicted only; undefined = unknown */
  lineupConfirmed?: boolean;
  /** When true, show a short “provisional / predicted” notice above the lineup (rows are still from the API). */
  lineupProvisionalNotice?: boolean;
}

export type FixtureLineup = ReleasedLineup | null;
