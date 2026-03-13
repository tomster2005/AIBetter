import type { Fixture } from "../types/fixture.js";

const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Object mapping date keys (YYYY-MM-DD in Europe/London) to fixtures
 * sorted by kickoff time (ascending) within each day.
 */
export interface FixturesByDate {
  [date: string]: Fixture[];
}

/**
 * Returns the date key (YYYY-MM-DD) for grouping in Europe/London.
 * Uses fixture.date when it's already YYYY-MM-DD (e.g. from getFixturesBetween
 * with timezone Europe/London); otherwise parses startingAt.
 */
function getDateKey(fixture: Fixture): string {
  const d = fixture.date?.trim();
  if (d && DATE_KEY_REGEX.test(d)) return d;
  const start = fixture.startingAt?.trim();
  if (!start) return "";
  const datePart = start.split(/\s+/)[0];
  return datePart && DATE_KEY_REGEX.test(datePart) ? datePart : "";
}

/**
 * Groups cleaned fixtures by date (YYYY-MM-DD) in Europe/London,
 * with fixtures in each day sorted by kickoff time (ascending).
 *
 * Expects fixture.date / startingAt to be in Europe/London (e.g. from
 * getFixturesBetween with timezone Europe/London).
 */
export function groupFixturesByDate(fixtures: Fixture[]): FixturesByDate {
  const byDate: Record<string, Fixture[]> = {};

  for (const fixture of fixtures) {
    const key = getDateKey(fixture);
    if (!key) continue;
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(fixture);
  }

  for (const key of Object.keys(byDate)) {
    byDate[key].sort((a, b) => {
      const tA = a.startingAt;
      const tB = b.startingAt;
      if (tA < tB) return -1;
      if (tA > tB) return 1;
      return a.id - b.id;
    });
  }

  return byDate;
}
