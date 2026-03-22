/**
 * Recent league form (all opponents) for both sides of a fixture — Sportmonks-backed.
 * Built server-side from fixtures/between + scores; used for team prop reasoning and gating.
 */

export interface TeamVenueSplitForm {
  n: number;
  avgGoalsFor: number | null;
  avgGoalsAgainst: number | null;
  avgMatchTotalGoals: number | null;
}

export interface TeamSideRecentForm {
  teamId: number;
  teamName?: string;
  /** Finished matches with usable scores (max 5 newest). */
  sampleSize: number;
  /** True when sample is too thin for confident team props (< 3). */
  weakSample: boolean;
  avgMatchTotalGoals: number | null;
  avgGoalsFor: number | null;
  avgGoalsAgainst: number | null;
  bttsRate: number | null;
  bttsHits: number;
  /** Share of matches where this team scored at least once. */
  scoredInRate: number | null;
  /** Share of matches where this team conceded at least once. */
  concededInRate: number | null;
  homeSplit: TeamVenueSplitForm;
  awaySplit: TeamVenueSplitForm;
  /** Newest first; match total goals. */
  recentMatchTotals: number[];
  recentGoalsFor: number[];
  recentGoalsAgainst: number[];
}

export interface FixtureTeamFormContext {
  homeTeamId: number;
  awayTeamId: number;
  homeTeamName?: string;
  awayTeamName?: string;
  home: TeamSideRecentForm;
  away: TeamSideRecentForm;
  /** True when Sportmonks fetch failed or returned unusable payload. */
  fetchFailed: boolean;
}
