import type { Fixture } from "../types/fixture.js";

export type LeagueGroup = {
  leagueId: number;
  leagueName: string;
  leagueLogo: string | null;
  fixtures: Fixture[];
};

/**
 * Sorts league groups so favourited leagues come first, then the rest.
 * Within each group, existing order is preserved.
 */
export function sortLeagueGroupsByFavourite(
  groups: LeagueGroup[],
  favouriteIds: Set<number>
): LeagueGroup[] {
  const favourited: LeagueGroup[] = [];
  const rest: LeagueGroup[] = [];
  for (const g of groups) {
    if (favouriteIds.has(g.leagueId)) favourited.push(g);
    else rest.push(g);
  }
  return [...favourited, ...rest];
}
