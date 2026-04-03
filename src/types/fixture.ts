/**
 * Cleaned fixture types returned by the API layer.
 * Use these types in the rest of the app (e.g. UI) instead of raw API shapes.
 */

export interface FixtureTeam {
  id: number;
  name: string;
  logo: string | null;
}

export interface FixtureLeague {
  id: number;
  name: string;
  logo: string | null;
}

export interface FixtureState {
  id: number;
  name: string;
  nameShort: string;
}

export interface FixtureScoreEntry {
  description: string;
  participant: "home" | "away";
  goals: number;
}

export interface Fixture {
  id: number;
  startingAt: string;
  date: string;
  time: string;
  homeTeam: FixtureTeam;
  awayTeam: FixtureTeam;
  league: FixtureLeague;
  state: FixtureState;
  scores: FixtureScoreEntry[];
  /** Optional lineup rows when present in fixture list payloads. */
  lineups?: Array<{
    formation_position?: number | null;
    type?: string | null;
    type_id?: number | null;
  }> | { data?: Array<{ formation_position?: number | null; type?: string | null; type_id?: number | null }> } | null;
}
