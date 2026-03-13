import type { Fixture } from "../types/fixture.js";

/**
 * Groups fixtures by league (id), with fixtures sorted by kickoff time within each league.
 * Returns an array of { leagueId, leagueName, leagueLogo, fixtures } for stable ordering.
 */
export function groupFixturesByLeague(fixtures: Fixture[]): Array<{
  leagueId: number;
  leagueName: string;
  leagueLogo: string | null;
  fixtures: Fixture[];
}> {
  const byLeague = new Map<
    number,
    { name: string; logo: string | null; list: Fixture[] }
  >();

  for (const f of fixtures) {
    const key = f.league.id;
    if (!byLeague.has(key)) {
      byLeague.set(key, {
        name: f.league.name,
        logo: f.league.logo,
        list: [],
      });
    }
    byLeague.get(key)!.list.push(f);
  }

  for (const entry of byLeague.values()) {
    entry.list.sort((a, b) => {
      const tA = a.startingAt;
      const tB = b.startingAt;
      if (tA < tB) return -1;
      if (tA > tB) return 1;
      return a.id - b.id;
    });
  }

  return Array.from(byLeague.entries()).map(([leagueId, { name, logo, list }]) => ({
    leagueId,
    leagueName: name,
    leagueLogo: logo,
    fixtures: list,
  }));
}
