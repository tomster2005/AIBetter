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

function fixtureStateCode(fixture: Fixture): string {
  return String(fixture.state?.nameShort ?? fixture.state?.name ?? "").toUpperCase();
}

function isFinishedFixture(fixture: Fixture): boolean {
  const code = fixtureStateCode(fixture);
  return code === "FT" || code === "AET" || code === "FT_PEN" || code === "AOT" || code === "PEN";
}

function isNotStartedFixture(fixture: Fixture): boolean {
  const code = fixtureStateCode(fixture);
  return code === "NS";
}

function isLiveFixture(fixture: Fixture): boolean {
  const code = fixtureStateCode(fixture);
  if (!code) return false;
  if (isFinishedFixture(fixture)) return false;
  if (code === "NS") return false;
  return true;
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
  const [lineupRefreshing, setLineupRefreshing] = useState(false);
  const [lineupFormations, setLineupFormations] = useState<{ home?: string; away?: string }>({});
  const [lineupCoaches, setLineupCoaches] = useState<{
    home?: { name?: string | null; image?: string | null };
    away?: { name?: string | null; image?: string | null };
  }>({});
  const [fixtureSignalCounts, setFixtureSignalCounts] = useState<Record<number, number>>({});
  const [fixtureReadiness, setFixtureReadiness] = useState<Record<number, boolean>>({});
  const [sectionsOpen, setSectionsOpen] = useState({
    live: true,
    notStarted: true,
    finished: false,
  });

  const { favouriteIds, toggleFavourite, isFavourite } = useLeagueFavourites();
  const { isExpanded, toggleExpanded } = useExpandedLeagueState();

  useEffect(() => {
    const onBackToToday = () => setSelectedDate(toLondonDateKey(new Date()));
    window.addEventListener("app:calendar-today", onBackToToday as EventListener);
    return () => window.removeEventListener("app:calendar-today", onBackToToday as EventListener);
  }, []);

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
        const ids = fixtures.map((f) => f.id).filter((id) => Number.isFinite(id) && id > 0);
        if (ids.length > 0) {
          const qs = encodeURIComponent(ids.join(","));
          fetch(`/api/fixtures/signals?ids=${qs}`)
            .then((r) => (r.ok ? r.json() : { signals: {} }))
            .then((payload: { signals?: Record<string, { signalCount?: number; hasRequiredData?: boolean }> }) => {
              const out: Record<number, number> = {};
              const readinessOut: Record<number, boolean> = {};
              const raw = payload?.signals ?? {};
              for (const [k, v] of Object.entries(raw)) {
                const id = parseInt(k, 10);
                const c = Number(v?.signalCount ?? 0);
                if (Number.isFinite(id) && id > 0 && Number.isFinite(c) && c > 0) out[id] = c;
                if (Number.isFinite(id) && id > 0) readinessOut[id] = v?.hasRequiredData === true;
              }
              setFixtureSignalCounts(out);
              setFixtureReadiness(readinessOut);
            })
            .catch(() => {
              setFixtureSignalCounts({});
              setFixtureReadiness({});
            });
        } else {
          setFixtureSignalCounts({});
          setFixtureReadiness({});
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load fixtures"))
      .finally(() => setLoading(false));
  }, []);

  const fixtures = byDate?.[selectedDate] ?? [];
  const liveFixtures = fixtures.filter(isLiveFixture);
  const notStartedFixtures = fixtures.filter(isNotStartedFixture);
  const finishedFixtures = fixtures.filter(isFinishedFixture);

  const leagueGroups = sortLeagueGroupsByFavourite(groupFixturesByLeague(fixtures), favouriteIds);
  const liveLeagueGroups = sortLeagueGroupsByFavourite(groupFixturesByLeague(liveFixtures), favouriteIds);
  const notStartedLeagueGroups = sortLeagueGroupsByFavourite(groupFixturesByLeague(notStartedFixtures), favouriteIds);
  const finishedLeagueGroups = sortLeagueGroupsByFavourite(groupFixturesByLeague(finishedFixtures), favouriteIds);
  const valueFixtureCount = fixtures.reduce(
    (sum, f) => sum + ((fixtureSignalCounts[f.id] ?? 0) > 0 ? 1 : 0),
    0
  );
  const readyFixtureCount = fixtures.reduce(
    (sum, f) => sum + (fixtureReadiness[f.id] === true ? 1 : 0),
    0
  );
  const hasRequiredData = readyFixtureCount > 0;

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
    setLineupRefreshing(false);
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
    setLineupRefreshing(false);
    setLineupFormations({});
    setLineupCoaches({});
  };

  useEffect(() => {
    if (!lineupOpen || lineupFixture == null) return;
    const hasReadyLineup = Array.isArray(lineup?.data) && lineup.data.length > 0;
    if (hasReadyLineup) return;

    let cancelled = false;
    const refreshLineups = async () => {
      if (cancelled) return;
      setLineupRefreshing(true);
      try {
        const res = await fetch(`/api/fixtures/${lineupFixture.id}`);
        if (!res.ok) return;
        const body = (await res.json()) as RawFixtureDetails;
        if (cancelled) return;
        const details = normalizeFixtureDetailsForClient(body);
        setLineup(getLineupForFixture(details));
        setLineupFormations(getFormationsFromDetails(details));
        setLineupCoaches(
          getCoachesFromDetails(details, {
            homeTeamId: lineupFixture.homeTeam.id,
            awayTeamId: lineupFixture.awayTeam.id,
          })
        );
      } catch {
        // Silent fail: retry on next tick.
      } finally {
        if (!cancelled) setLineupRefreshing(false);
      }
    };

    const intervalMs = 45000;
    const timer = window.setInterval(() => {
      void refreshLineups();
    }, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      setLineupRefreshing(false);
    };
  }, [lineupOpen, lineupFixture, lineup]);

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
          {!loading && !error && fixtures.length > 0 && valueFixtureCount === 0 && !hasRequiredData && (
            <div className="calendar-page__quiet-state">
              <p className="calendar-page__quiet-text">
                Waiting for lineups to analyse value bets.
              </p>
              <p className="calendar-page__quiet-text">Value detection will update automatically.</p>
            </div>
          )}
          {!loading && !error && fixtures.length > 0 && valueFixtureCount === 0 && hasRequiredData && (
            <div className="calendar-page__quiet-state">
              <p className="calendar-page__quiet-text">
                No strong value bets today.
              </p>
              <button
                type="button"
                className="calendar-page__quiet-link"
                onClick={() => window.dispatchEvent(new CustomEvent("app:open-bet-tracker-insights"))}
              >
                View Insights
              </button>
            </div>
          )}
          {!loading && !error && leagueGroups.length > 0 && (
            <div className="calendar-page__status-sections">
              <section className="calendar-page__status">
                <button
                  type="button"
                  className="calendar-page__status-toggle"
                  onClick={() => setSectionsOpen((prev) => ({ ...prev, live: !prev.live }))}
                  aria-expanded={sectionsOpen.live}
                >
                  <span>Live games ({liveFixtures.length})</span>
                  <span className={`calendar-page__status-chevron${sectionsOpen.live ? " is-open" : ""}`}>▼</span>
                </button>
                {sectionsOpen.live && (
                  <div className="calendar-page__league-cards">
                    {liveLeagueGroups.length === 0 ? (
                      <p className="calendar-page__message">No live games.</p>
                    ) : (
                      liveLeagueGroups.map((group) => (
                        <LeagueSectionCard
                          key={`live-${group.leagueId}`}
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
                          fixtureSignalCounts={fixtureSignalCounts}
                          fixtureReadiness={fixtureReadiness}
                        />
                      ))
                    )}
                  </div>
                )}
              </section>

              <section className="calendar-page__status">
                <button
                  type="button"
                  className="calendar-page__status-toggle"
                  onClick={() => setSectionsOpen((prev) => ({ ...prev, notStarted: !prev.notStarted }))}
                  aria-expanded={sectionsOpen.notStarted}
                >
                  <span>Not started ({notStartedFixtures.length})</span>
                  <span className={`calendar-page__status-chevron${sectionsOpen.notStarted ? " is-open" : ""}`}>▼</span>
                </button>
                {sectionsOpen.notStarted && (
                  <div className="calendar-page__league-cards">
                    {notStartedLeagueGroups.length === 0 ? (
                      <p className="calendar-page__message">No upcoming games.</p>
                    ) : (
                      notStartedLeagueGroups.map((group) => (
                        <LeagueSectionCard
                          key={`ns-${group.leagueId}`}
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
                          fixtureSignalCounts={fixtureSignalCounts}
                          fixtureReadiness={fixtureReadiness}
                        />
                      ))
                    )}
                  </div>
                )}
              </section>

              <section className="calendar-page__status">
                <button
                  type="button"
                  className="calendar-page__status-toggle"
                  onClick={() => setSectionsOpen((prev) => ({ ...prev, finished: !prev.finished }))}
                  aria-expanded={sectionsOpen.finished}
                >
                  <span>Finished ({finishedFixtures.length})</span>
                  <span className={`calendar-page__status-chevron${sectionsOpen.finished ? " is-open" : ""}`}>▼</span>
                </button>
                {sectionsOpen.finished && (
                  <div className="calendar-page__league-cards">
                    {finishedLeagueGroups.length === 0 ? (
                      <p className="calendar-page__message">No finished games.</p>
                    ) : (
                      finishedLeagueGroups.map((group) => (
                        <LeagueSectionCard
                          key={`ft-${group.leagueId}`}
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
                          fixtureSignalCounts={fixtureSignalCounts}
                          fixtureReadiness={fixtureReadiness}
                        />
                      ))
                    )}
                  </div>
                )}
              </section>
            </div>
          )}
          <LineupModal
            open={lineupOpen}
            onClose={handleLineupClose}
            fixture={lineupFixture}
            loading={lineupLoading}
            refreshing={lineupRefreshing}
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
