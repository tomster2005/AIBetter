export interface HeadToHeadFixtureContext {
  /** Number of H2H fixtures used in the summary. */
  sampleSize: number;
  /** Average total goals (home+away) across sample. */
  averageTotalGoals: number | null;
  /** Average total corners (home+away) across sample, when available in statistics. */
  averageTotalCorners: number | null;
  /** Rate (0..1) where both teams scored at least once. */
  bttsRate: number | null;
  /** Count of fixtures with BTTS=yes (both teams scored). */
  bttsYesCount?: number;
  /** Sample size used for BTTS counts (requires goals by side). */
  bttsSampleSize?: number;
  /** Team1 win rate (0..1) across sample. */
  team1WinRate: number | null;
  /** Team2 win rate (0..1) across sample. */
  team2WinRate: number | null;
  /** Draw rate (0..1) across sample. */
  drawRate: number | null;
  /** Count of team1 wins across sample (team1 corresponds to request order). */
  team1WinCount?: number;
  /** Count of team2 wins across sample (team2 corresponds to request order). */
  team2WinCount?: number;
  /** Count of draws across sample. */
  drawCount?: number;
  /** Sample size used for result counts (requires mapping team sides). */
  resultSampleSize?: number;
  /** Goals over/under counts for common lines (derived from H2H total goals). */
  goalsLineCounts?: Array<{
    line: number;
    over: number;
    under: number;
    sampleSize: number;
  }>;
}

