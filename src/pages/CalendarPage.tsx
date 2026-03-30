import { useEffect, useState } from "react";
import type { Fixture } from "../types/fixture.js";
import { groupFixturesByDate } from "../utils/groupFixturesByDate.js";
import { groupFixturesByLeague } from "../utils/groupFixturesByLeague.js";
import type { FixturesByDate } from "../utils/groupFixturesByDate.js";
import { DateStrip } from "../components/DateStrip.js";
import { LeagueSectionCard } from "../components/LeagueSectionCard.js";
import { LineupModal } from "../components/LineupModal.js";
import { useLeagueFavourites } from "../hooks/useLeagueFavourites.js";
import { useExpandedLeagueState } from "../hooks/useExpandedLeagueState.js";
import { sortLeagueGroupsByFavourite } from "../utils/sortLeagueGroupsByFavourite.js";
import {
  getLineupForFixture,
  getFormationsFromDetails,
  getCoachesFromDetails,
  normalizeFixtureDetailsForClient,
} from "../api/index.js";
import type { FixtureLineup } from "../api/fixture-details-types.js";
import type { RawFixtureDetails } from "../api/fixture-details-types.js";
import "./CalendarPage.css";

const LONDON = "Europe/London";

function toLondonDateKey(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LONDON,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${day}`;
}

/** Returns 7 date keys (YYYY-MM-DD) in Europe/London: today and the next 6 days. */
function getNextSevenDateKeys(): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    keys.push(toLondonDateKey(d));
  }
  return keys;
}

function formatDateLabel(dateKey: string): string {
  const [y, m, day] = dateKey.split("-").map(Number);
  const d = new Date(y, m - 1, day);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(d);
}

function formatTime(startingAt: string): string {
  const part = startingAt.trim().split(/\s+/)[1];
  if (!part) return "–";
  const [h, min] = part.split(":");
  return `${h}:${min ?? "00"}`;
}

export function CalendarPage() {
  const dateKeys = getNextSevenDateKeys();
  const todayKey = toLondonDateKey(new Date());

  const [selectedDate, setSelectedDate] = useState<string>(todayKey);
  const [byDate, setByDate] = useState<FixturesByDate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [lineupOpen, setLineupOpen] = useState(false);
  const [lineupFixture, setLineupFixture] = useState<Fixture | null>(null);
  const [lineupLoading, setLineupLoading] = useState(false);
  const [lineupError, setLineupError] = useState<string | null>(null);
  const [lineup, setLineup] = useState<FixtureLineup | null>(null);
  const [lineupFormations, setLineupFormations] = useState<{ home?: string; away?: string }>({});
  const [lineupCoaches, setLineupCoaches] = useState<{
    home?: { name?: string | null; image?: string | null };
    away?: { name?: string | null; image?: string | null };
  }>({});

  const { favouriteIds, toggleFavourite, isFavourite } = useLeagueFavourites();
  const { isExpanded, toggleExpanded } = useExpandedLeagueState();

  useEffect(() => {
    const keys = getNextSevenDateKeys();
    const start = keys[0];
    const end = keys[keys.length - 1];
    setLoading(true);
    setError(null);
    fetch(`/api/fixtures?start=${start}&end=${end}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          const msg = typeof (data as { error?: string })?.error === "string" ? (data as { error: string }).error : res.statusText;
          throw new Error(msg);
        }
        return data as Fixture[];
      })
      .then((fixtures) => {
        /* Temporary debug: FA Cup West Ham vs Brentford 2026-03-09 */
        const isTargetFixture = (f: Fixture) =>
          f.league.name.toLowerCase().includes("fa cup") &&
          f.homeTeam.name.toLowerCase().includes("west ham") &&
          f.awayTeam.name.toLowerCase().includes("brentford");
        const targetInAllFetched = fixtures.find(isTargetFixture);
        if (import.meta.env.DEV) {
          console.log("[calendar] DEBUG target in all fetched (cleaned) fixtures:", !!targetInAllFetched, targetInAllFetched ? { id: targetInAllFetched.id, date: targetInAllFetched.date, league: targetInAllFetched.league.name } : null);
        }
        const byDateComputed = groupFixturesByDate(fixtures);
        const targetIn20260309 = byDateComputed["2026-03-09"]?.some(isTargetFixture) ?? false;
        const datesContainingTarget = Object.keys(byDateComputed).filter((k) => byDateComputed[k].some(isTargetFixture));
        if (import.meta.env.DEV) {
          console.log("[calendar] DEBUG target in grouped fixtures for 2026-03-09:", targetIn20260309);
          console.log("[calendar] DEBUG dates containing target:", datesContainingTarget);
        }
        setByDate(byDateComputed);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load fixtures"))
      .finally(() => setLoading(false));
  }, []);

  const fixtures = byDate?.[selectedDate] ?? [];
  const leagueGroupsUnsorted = groupFixturesByLeague(fixtures);
  const leagueGroups = sortLeagueGroupsByFavourite(leagueGroupsUnsorted, favouriteIds);

  useEffect(() => {
    if (import.meta.env.DEV && leagueGroups.length >= 0) {
      console.log(`[calendar] ${leagueGroups.length} league(s) for selected date`);
    }
    /* Temporary debug: FA Cup West Ham vs Brentford - selected-date filtering */
    if (import.meta.env.DEV && byDate) {
      const isTargetFixture = (f: Fixture) =>
        f.league.name.toLowerCase().includes("fa cup") &&
        f.homeTeam.name.toLowerCase().includes("west ham") &&
        f.awayTeam.name.toLowerCase().includes("brentford");
      const fixturesForSelected = byDate[selectedDate] ?? [];
      const targetInSelectedDate = fixturesForSelected.some(isTargetFixture);
      const targetInRendered = leagueGroups.some((g) => g.fixtures.some(isTargetFixture));
      console.log("[calendar] DEBUG target in grouped fixtures for selected date (" + selectedDate + "):", targetInSelectedDate);
      console.log("[calendar] DEBUG target in rendered fixtures (leagueGroups):", targetInRendered);
    }
  }, [selectedDate, leagueGroups, byDate]);

  const selectedIndex = dateKeys.indexOf(selectedDate);
  const canGoPrev = selectedIndex > 0;
  const canGoNext = selectedIndex >= 0 && selectedIndex < dateKeys.length - 1;

  const handlePrev = () => {
    if (!canGoPrev) return;
    setSelectedDate(dateKeys[selectedIndex - 1]);
  };

  const handleNext = () => {
    if (!canGoNext) return;
    setSelectedDate(dateKeys[selectedIndex + 1]);
  };

  const handleFixtureClick = (fixture: Fixture) => {
    const lineupUrl = `/api/fixtures/${fixture.id}`;
    if (import.meta.env.DEV) {
      console.log("[lineup] request", { url: lineupUrl, via: "local API route (backend)", fixtureId: fixture.id });
    }
    setLineupFixture(fixture);
    setLineupOpen(true);
    setLineupLoading(true);
    setLineupError(null);
    setLineup(null);
    setLineupCoaches({});
    fetch(lineupUrl)
      .then(async (res) => {
        const text = await res.text();
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          body = text;
        }
        if (!res.ok) {
          const message =
            typeof body === "object" && body != null && "error" in body ? String((body as { error: unknown }).error) : String(body || res.statusText);
          if (import.meta.env.DEV) {
            console.error("[lineup] response failed", {
              url: lineupUrl,
              via: "local API route (backend)",
              status: res.status,
              responseBody: body,
              fixtureId: fixture.id,
            });
          }
          throw new Error(message);
        }
        return body as RawFixtureDetails;
      })
      .then((body) => {
        const details = normalizeFixtureDetailsForClient(body);
        setLineup(getLineupForFixture(details));
        setLineupFormations(getFormationsFromDetails(details));
        setLineupCoaches(
          getCoachesFromDetails(details, {
            homeTeamId: fixture.homeTeam.id,
            awayTeamId: fixture.awayTeam.id,
          })
        );
      })
      .catch((err) => setLineupError(err instanceof Error ? err.message : "Failed to load lineup"))
      .finally(() => setLineupLoading(false));
  };

  const handleLineupClose = () => {
    setLineupOpen(false);
    setLineupFixture(null);
    setLineupError(null);
    setLineup(null);
    setLineupFormations({});
    setLineupCoaches({});
  };

  return (
    <div className="calendar-page">
      <p className="calendar-page__label">Calendar</p>

      <DateStrip
        dateKeys={dateKeys}
        selectedDate={selectedDate}
        todayKey={todayKey}
        formatLabel={formatDateLabel}
        onSelectDate={setSelectedDate}
        onPrev={handlePrev}
        onNext={handleNext}
        canGoPrev={canGoPrev}
        canGoNext={canGoNext}
      />

      <div className="calendar-page__main">
        <main
          className={`calendar-page__content${lineupOpen ? " calendar-page__content--modal-open" : ""}`}
          aria-label={`Fixtures for ${formatDateLabel(selectedDate)}`}
        >
          {loading && <p className="calendar-page__message">Loading…</p>}
          {error && <p className="calendar-page__message calendar-page__message--error">{error}</p>}
          {!loading && !error && fixtures.length === 0 && (
            <p className="calendar-page__message">No fixtures on this day.</p>
          )}
          {!loading && !error && leagueGroups.length > 0 && (
            <div className="calendar-page__league-cards">
              {leagueGroups.map((group) => (
                <LeagueSectionCard
                  key={group.leagueId}
                  leagueId={group.leagueId}
                  leagueName={group.leagueName}
                  leagueLogo={group.leagueLogo}
                  fixtures={group.fixtures}
                  formatTime={formatTime}
                  onFixtureClick={handleFixtureClick}
                  isFavourite={isFavourite(group.leagueId)}
                  onToggleFavourite={toggleFavourite}
                  isExpanded={isExpanded(selectedDate, group.leagueId)}
                  onToggleExpand={() => toggleExpanded(selectedDate, group.leagueId)}
                />
              ))}
            </div>
          )}
          <LineupModal
            open={lineupOpen}
            onClose={handleLineupClose}
            fixture={lineupFixture}
            loading={lineupLoading}
            error={lineupError}
            lineup={lineup}
            formations={lineupFormations}
            coaches={lineupCoaches}
          />
        </main>
      </div>
    </div>
  );
}
