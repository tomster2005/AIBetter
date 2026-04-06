export interface TeamGoalLineBreakdown {
  line: number;
  scope: "all" | "home" | "away";
  over: number | null;
  under: number | null;
  total: number | null;
}

export interface TeamSeasonGoalLineStats {
  teamId: number;
  seasonId?: number;
  goalLineStats: TeamGoalLineBreakdown[];
}
