/**
 * Dedicated Odds analysis workspace.
 * User selects a fixture, then sees table-style odds for Match Results, BTTS, Match Goals, Total Corners, Team Total Goals.
 */

import React, { useEffect, useRef, useState } from "react";
import type { Fixture } from "../types/fixture.js";
import { groupFixturesByDate } from "../utils/groupFixturesByDate.js";
import {
  CORE_MARKET_IDS,
  MARKET_ID_ALTERNATIVE_CORNERS,
  MARKET_ID_ALTERNATIVE_TOTAL_GOALS,
  MARKET_ID_BTTS,
  MARKET_ID_HOME_TEAM_GOALS,
  MARKET_ID_MATCH_GOALS,
  MARKET_ID_MATCH_RESULTS,
  MARKET_ID_PLAYER_SHOTS,
  MARKET_ID_PLAYER_SHOTS_ON_TARGET,
  MARKET_ID_AWAY_TEAM_GOALS,
  MARKET_ID_TEAM_TOTAL_GOALS,
  PLAYER_PROP_MARKET_IDS,
  TEAM_PROP_MARKET_IDS,
} from "../constants/marketIds.js";
import { loadPlayerPropsForFixture } from "../services/playerPropsService.js";
import { useAutoResolveCombos } from "../hooks/useAutoResolveCombos.js";
import { formatMatchMarketSelectionDisplay, formatPlayerOddsSelectionDisplay } from "../lib/betLegDisplayLabel.js";
import "./OddsPage.css";

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

interface OddsSelection {
  label: string;
  value: string | number | null;
  odds: number | null;
}

interface OddsMarket {
  marketId: number;
  marketName: string;
  selections: OddsSelection[];
}

interface OddsBookmaker {
  bookmakerId: number;
  bookmakerName: string;
  markets: OddsMarket[];
}

interface NormalisedOddsResponse {
  fixtureId: number;
  bookmakers: OddsBookmaker[];
}

/** Player odds response (Phase 1): opt-in, from /api/fixtures/:id/player-odds */
interface PlayerOddsSelection {
  line: number;
  overOdds: number | null;
  underOdds: number | null;
  bookmakerId: number;
  bookmakerName: string;
}
interface PlayerOddsPlayer {
  playerId: number;
  playerName: string;
  teamId: number;
  teamName: string;
  selections: PlayerOddsSelection[];
}
interface PlayerOddsMarket {
  marketId: number;
  marketName: string;
  players: PlayerOddsPlayer[];
}
type LineupSource = "confirmed" | "predicted" | "none";

interface PlayerOddsResponse {
  fixtureId: number;
  markets: PlayerOddsMarket[];
  lineupSource?: LineupSource;
  playerCount?: number;
}

/** Evidence fields for reasoning. Only populate from real data; never fabricate. */
interface LegEvidence {
  /** Player prop line (e.g. 0.5). Present when leg is from player props. */
  line?: number;
  /** "confirmed" | "predicted" when player props came from lineup; omit if none. */
  lineupStatus?: "confirmed" | "predicted";
  /** Future: last N stat sequence when we have the data. */
  recentStats?: string;
  /** Future: H2H note when we have the data. */
  h2h?: string;
  /** Future: team form when we have the data. */
  teamForm?: string;
}

/** Single leg for Build Bet combos: description + odds + groupKey + optional evidence for reasoning. */
interface BuildBetLeg {
  id: string;
  description: string;
  odds: number;
  groupKey: string;
  legType: "player" | "match";
  evidence?: LegEvidence;
  marketId: number;
  marketPriorityScore: number;
}

/** Ladder markets (Alternative Goals, Alternative Corners): at most one per combo. */
const BUILD_BET_LADDER_MARKET_IDS: readonly number[] = [
  MARKET_ID_ALTERNATIVE_TOTAL_GOALS,  // 81
  MARKET_ID_ALTERNATIVE_CORNERS,       // 69
];

function isLadderMarket(marketId: number): boolean {
  return BUILD_BET_LADDER_MARKET_IDS.includes(marketId);
}

/** Priority: player +3, core +2, secondary +1, ladder -2. */
function getMarketPriorityScore(marketId: number): number {
  if ((PLAYER_PROP_MARKET_IDS as readonly number[]).includes(marketId)) return 3; // All player props (incl. 340 tackles)
  if (marketId === 1 || marketId === 14 || marketId === 80) return 2;  // Match Result, BTTS, Over/Under Goals
  if (isLadderMarket(marketId)) return -2;  // Alternative Goals, Alternative Corners
  return 1;  // Corners, Team Totals, etc.
}

/** Returns 1–2 short factual lines for a leg. Only uses evidence that exists; never invents. */
function formatLegReasoning(leg: BuildBetLeg): string[] {
  const lines: string[] = [];
  const e = leg.evidence;
  if (!e) return lines;
  if (e.line != null && Number.isFinite(e.line)) {
    lines.push(`Line is ${e.line}.`);
  }
  if (e.lineupStatus === "confirmed") {
    lines.push("From confirmed lineup.");
  } else if (e.lineupStatus === "predicted") {
    lines.push("From predicted lineup.");
  }
  if (e.recentStats) {
    lines.push(e.recentStats);
  }
  if (e.h2h) {
    lines.push(e.h2h);
  }
  if (e.teamForm) {
    lines.push(e.teamForm);
  }
  return lines;
}

function collectBuildBetSelections(
  oddsData: NormalisedOddsResponse | null,
  playerOddsData: PlayerOddsResponse | null
): BuildBetLeg[] {
  const out: BuildBetLeg[] = [];
  if (oddsData?.bookmakers) {
    for (const b of oddsData.bookmakers) {
      for (const m of b.markets) {
        for (const s of m.selections ?? []) {
          const odds = typeof s.odds === "number" && Number.isFinite(s.odds)
            ? s.odds
            : typeof s.value === "number"
              ? s.value
              : typeof s.value === "string"
                ? parseFloat(s.value.replace(/,/g, "."))
                : null;
          if (odds == null || !Number.isFinite(odds) || odds <= 0) continue;
          const label = String(s.label ?? "").trim() || "—";
          const marketId = m.marketId;
          out.push({
            id: `m-${marketId}-${label}-${b.bookmakerId}`,
            description: formatMatchMarketSelectionDisplay(marketId, m.marketName, label),
            odds,
            groupKey: `m-${marketId}-${label}`,
            legType: "match",
            marketId,
            marketPriorityScore: getMarketPriorityScore(marketId),
          });
        }
      }
    }
  }
  const lineupSource = playerOddsData?.lineupSource;
  const lineupStatus =
    lineupSource === "confirmed" ? "confirmed" as const
    : lineupSource === "predicted" ? "predicted" as const
    : undefined;
  if (playerOddsData?.markets) {
    for (const market of playerOddsData.markets) {
      for (const player of market.players ?? []) {
        const groupKey = `p-${market.marketId}-${player.playerId}`;
        for (const sel of player.selections ?? []) {
          const odds = sel.overOdds != null && Number.isFinite(sel.overOdds) ? sel.overOdds : null;
          if (odds == null || odds <= 0) continue;
          const line = sel.line != null && Number.isFinite(sel.line) ? sel.line : undefined;
          const lineStr = line != null ? String(line) : "—";
          const evidence: LegEvidence = {};
          if (line != null) evidence.line = line;
          if (lineupStatus) evidence.lineupStatus = lineupStatus;
          const marketId = market.marketId;
          out.push({
            id: `p-${marketId}-${player.playerId}-${lineStr}-${sel.bookmakerId}`,
            description: formatPlayerOddsSelectionDisplay(player.playerName, market.marketName, line),
            odds,
            groupKey,
            legType: "player",
            evidence: Object.keys(evidence).length > 0 ? evidence : undefined,
            marketId,
            marketPriorityScore: getMarketPriorityScore(marketId),
          });
        }
      }
    }
  }
  return out;
}

type BuildBetCombo = { legs: BuildBetLeg[]; combinedOdds: number; comboScore: number; distanceFromMidpoint: number };

function generateBuildBetCombos(
  selections: BuildBetLeg[],
  minOdds: number,
  maxOdds: number,
  maxLegs: 2 | 3
): { combos: BuildBetCombo[]; totalInRange: number } {
  const empty = { combos: [], totalInRange: 0 };
  if (selections.length < 2) return empty;
  const all: Array<BuildBetCombo & { distanceFromMidpoint: number }> = [];
  const maxN = maxLegs;
  function addCombos(legs: BuildBetLeg[], startIdx: number, usedGroupKeys: Set<string>, ladderCount: number) {
    if (legs.length === maxN) {
      const combinedOdds = legs.reduce((p, l) => p * l.odds, 1);
      const comboScore = legs.reduce((sum, l) => sum + l.marketPriorityScore, 0);
      all.push({
        legs: [...legs],
        combinedOdds,
        comboScore,
        distanceFromMidpoint: 0,
      });
      return;
    }
    for (let i = startIdx; i < selections.length; i++) {
      const s = selections[i];
      if (usedGroupKeys.has(s.groupKey)) continue;
      if (isLadderMarket(s.marketId) && ladderCount >= 1) continue;
      const nextLadder = isLadderMarket(s.marketId) ? ladderCount + 1 : ladderCount;
      usedGroupKeys.add(s.groupKey);
      legs.push(s);
      addCombos(legs, i + 1, usedGroupKeys, nextLadder);
      legs.pop();
      usedGroupKeys.delete(s.groupKey);
    }
  }
  addCombos([], 0, new Set(), 0);
  const midpoint = (minOdds + maxOdds) / 2;
  const inRange = all.filter((c) => c.combinedOdds >= minOdds && c.combinedOdds <= maxOdds);
  inRange.forEach((c) => {
    c.distanceFromMidpoint = Math.abs(c.combinedOdds - midpoint);
  });
  inRange.sort((a, b) => {
    if (a.comboScore !== b.comboScore) return b.comboScore - a.comboScore;
    if (a.distanceFromMidpoint !== b.distanceFromMidpoint) return a.distanceFromMidpoint - b.distanceFromMidpoint;
    return a.legs.length - b.legs.length;
  });
  return { combos: inRange.slice(0, 5), totalInRange: inRange.length };
}

function getOddsApiUrl(fixtureId: number): string {
  const base =
    typeof import.meta.env !== "undefined" && import.meta.env?.VITE_API_ORIGIN;
  const origin = typeof base === "string" && base !== "" ? base.replace(/\/$/, "") : "";
  return `${origin}/api/fixtures/${fixtureId}/odds`;
}

function isCoreMarket(marketId: number): boolean {
  return (CORE_MARKET_IDS as readonly number[]).includes(marketId);
}

function isTeamPropMarket(marketId: number): boolean {
  return (TEAM_PROP_MARKET_IDS as readonly number[]).includes(marketId);
}

/** Column order for Match Results */
const MR_COLUMNS = ["Home", "Draw", "Away"];

/** Column order for BTTS */
const BTTS_COLUMNS = ["Yes", "No"];

/** Preferred column order for Match Goals (Over/Under) */
/** Paired order: line ascending, Over then Under per line. */
const MATCH_GOALS_COLUMN_ORDER = [
  "Over 0.5", "Under 0.5", "Over 1.5", "Under 1.5", "Over 2.5", "Under 2.5",
  "Over 3.5", "Under 3.5", "Over 4.5", "Under 4.5",
];

/** Paired order: line ascending, Over then Under per line. */
const CORNERS_COLUMN_ORDER = [
  "Over 6.5", "Under 6.5", "Over 7.5", "Under 7.5", "Over 8.5", "Under 8.5",
  "Over 9.5", "Under 9.5", "Over 10.5", "Under 10.5", "Over 11.5", "Under 11.5",
  "Over 12.5", "Under 12.5",
];

/** Markets that use the grouped two-row O/U header (line | O U | O U | ...). */
const MULTI_LINE_OU_MARKET_IDS: readonly number[] = [
  MARKET_ID_ALTERNATIVE_TOTAL_GOALS,
  MARKET_ID_ALTERNATIVE_CORNERS,
];

/** Parse numeric line from "Over 6.5" / "Under 6.5" (ignore "Exactly"). Return null if not O/U. */
function parseOverUnderLine(label: string): number | null {
  const lower = label.toLowerCase().trim();
  if (lower.includes("exact")) return null;
  const num = parseFloat(label.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(num) || num < 0) return null;
  if (lower.startsWith("over") || lower.startsWith("under")) return num;
  return null;
}

/** From selection labels, return unique sorted lines (O/U only). */
function getSortedLinesFromLabels(labels: string[]): number[] {
  const set = new Set<number>();
  for (const l of labels) {
    const line = parseOverUnderLine(l);
    if (line != null) set.add(line);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/** Find the exact label in labels for Over/Under at this line. */
function findLabelForLine(labels: string[], line: number, kind: "over" | "under"): string | null {
  const prefix = kind === "over" ? "over" : "under";
  return labels.find((l) => {
    const lower = l.toLowerCase().trim();
    const num = parseFloat(l.replace(/[^\d.]/g, ""));
    return Number.isFinite(num) && num === line && lower.startsWith(prefix);
  }) ?? null;
}

function getOrderedColumns(marketId: number, labels: string[]): string[] {
  if (marketId === MARKET_ID_MATCH_RESULTS) return MR_COLUMNS.filter((c) => labels.includes(c));
  if (marketId === MARKET_ID_BTTS) return BTTS_COLUMNS.filter((c) => labels.includes(c));
  if (marketId === MARKET_ID_MATCH_GOALS) {
    return MATCH_GOALS_COLUMN_ORDER.filter((c) => labels.includes(c)).concat(
      labels.filter((l) => !MATCH_GOALS_COLUMN_ORDER.includes(l)).sort()
    );
  }
  if (marketId === MARKET_ID_ALTERNATIVE_TOTAL_GOALS) {
    return MATCH_GOALS_COLUMN_ORDER.filter((c) => labels.includes(c)).concat(
      labels.filter((l) => !MATCH_GOALS_COLUMN_ORDER.includes(l)).sort()
    );
  }
  if (marketId === MARKET_ID_ALTERNATIVE_CORNERS) {
    return CORNERS_COLUMN_ORDER.filter((c) => labels.includes(c)).concat(
      labels.filter((l) => !CORNERS_COLUMN_ORDER.includes(l)).sort()
    );
  }
  return [...labels].sort();
}

export function OddsPage() {
  const dateKeys = getNextSevenDateKeys();
  const todayKey = toLondonDateKey(new Date());

  const [selectedDate, setSelectedDate] = useState<string>(todayKey);
  const [byDate, setByDate] = useState<Record<string, Fixture[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedFixture, setSelectedFixture] = useState<Fixture | null>(null);
  useAutoResolveCombos(selectedFixture?.id ?? null, selectedFixture != null);
  const [oddsData, setOddsData] = useState<NormalisedOddsResponse | null>(null);
  const [oddsLoading, setOddsLoading] = useState(false);
  const [oddsError, setOddsError] = useState<string | null>(null);
  const currentFixtureIdRef = useRef<number | null>(null);

  const [playerOddsData, setPlayerOddsData] = useState<PlayerOddsResponse | null>(null);
  const [playerOddsLoading, setPlayerOddsLoading] = useState(false);
  const [playerOddsError, setPlayerOddsError] = useState<string | null>(null);

  const [buildBetMinOdds, setBuildBetMinOdds] = useState<number>(2.8);
  const [buildBetMaxOdds, setBuildBetMaxOdds] = useState<number>(3.4);
  const [buildBetMaxLegs, setBuildBetMaxLegs] = useState<2 | 3>(2);
  const [buildBetRangeInvalid, setBuildBetRangeInvalid] = useState<boolean>(false);
  const [buildBetResults, setBuildBetResults] = useState<
    Array<{ legs: BuildBetLeg[]; combinedOdds: number; comboScore: number; distanceFromMidpoint: number }> | null
  >(null);
  const [oddsTab, setOddsTab] = useState<"all" | "core" | "team" | "player" | "build">("all");
  const [selectedBookmakerFilter, setSelectedBookmakerFilter] = useState<string>("all");

  useEffect(() => {
    const start = dateKeys[0];
    const end = dateKeys[dateKeys.length - 1];
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
        setByDate(groupFixturesByDate(fixtures));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load fixtures"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const fixtureId = selectedFixture?.id ?? 0;
    currentFixtureIdRef.current = fixtureId;

    if (fixtureId <= 0) {
      setOddsData(null);
      setOddsError(null);
      setOddsLoading(false);
      setPlayerOddsData(null);
      setPlayerOddsError(null);
      setBuildBetResults(null);
      return;
    }
    setPlayerOddsData(null);
    setPlayerOddsError(null);
    setBuildBetResults(null);

    function fetchOdds(id: number, silent = false) {
      if (!silent) {
        setOddsError(null);
        setOddsLoading(true);
        setOddsData(null);
      }
      const url = getOddsApiUrl(id);
      fetch(url)
        .then(async (res) => {
          if (!res.ok) return null;
          return res.json() as Promise<{ data?: NormalisedOddsResponse }>;
        })
        .then((json) => {
          if (currentFixtureIdRef.current !== id) return;
          if (json === null) {
            if (!silent) setOddsError("Odds unavailable");
            return;
          }
          const normalised: unknown =
            json && typeof json === "object" && "data" in json && (json as { data: unknown }).data != null
              ? (json as { data: NormalisedOddsResponse }).data
              : json;
          if (
            normalised &&
            typeof normalised === "object" &&
            Array.isArray((normalised as NormalisedOddsResponse).bookmakers)
          ) {
            setOddsData(normalised as NormalisedOddsResponse);
          } else {
            setOddsData({ fixtureId: id, bookmakers: [] });
          }
        })
        .catch(() => {
          if (currentFixtureIdRef.current !== id) return;
          if (!silent) setOddsError("Odds unavailable");
        })
        .finally(() => {
          if (currentFixtureIdRef.current === id && !silent) setOddsLoading(false);
        });
    }

    fetchOdds(fixtureId);
    const interval = setInterval(() => fetchOdds(fixtureId, true), 30000);
    return () => clearInterval(interval);
  }, [selectedFixture?.id]);

  const fixtures = byDate?.[selectedDate] ?? [];
  const bookmakersList = oddsData?.bookmakers ?? [];
  const filteredBookmakers = selectedBookmakerFilter === "all"
    ? bookmakersList
    : bookmakersList.filter((b) => b.bookmakerName === selectedBookmakerFilter);
  const coreMarkets = getMarketsFromBookmakers(filteredBookmakers, isCoreMarket, DISPLAY_ORDER_CORE);
  const teamPropMarkets = getMarketsFromBookmakers(
    filteredBookmakers,
    isTeamPropMarket,
    DISPLAY_ORDER_TEAM_PROPS
  );
  const bookmakerOptions = Array.from(
    new Set(
      (oddsData?.bookmakers ?? []).map((b) => b.bookmakerName).filter((n) => n && n.trim().length > 0)
    )
  ).sort((a, b) => a.localeCompare(b));

  function loadPlayerProps() {
    const id = selectedFixture?.id;
    if (typeof id !== "number" || id <= 0) {
      if (import.meta.env.DEV) console.log("[player-props] button click: no fixture id, skip");
      return;
    }
    if (import.meta.env.DEV) console.log("[player-props] button click fired, fixtureId:", id);
    setPlayerOddsLoading(true);
    setPlayerOddsError(null);
    setPlayerOddsData(null);
    loadPlayerPropsForFixture(id)
      .then((data) => {
        if (import.meta.env.DEV) {
          console.log("[player-props] parsed response", {
            hasData: !!data,
            marketsLength: data?.markets?.length,
            lineupSource: data?.lineupSource,
            playerCount: data?.playerCount,
          });
        }
        setPlayerOddsData(data);
      })
      .catch((err) => {
        if (import.meta.env.DEV) console.log("[player-props] error caught", err);
        setPlayerOddsError("Player props unavailable");
      })
      .finally(() => setPlayerOddsLoading(false));
  }

  return (
    <div className="odds-page">
      <h1 className="odds-page__title">Odds</h1>

      <section className="odds-page__picker" aria-label="Fixture selection">
        <div className="odds-page__date-strip">
          {dateKeys.map((key) => (
            <button
              key={key}
              type="button"
              className={`odds-page__date-btn ${key === selectedDate ? "odds-page__date-btn--active" : ""}`}
              onClick={() => setSelectedDate(key)}
            >
              {formatDateLabel(key)}
            </button>
          ))}
        </div>
        {loading && <p className="odds-page__message">Loading fixtures…</p>}
        {error && <p className="odds-page__message odds-page__message--error">{error}</p>}
        {!loading && !error && (
          <div className="odds-page__fixture-list">
            {fixtures.length === 0 ? (
              <p className="odds-page__message">No fixtures on this day.</p>
            ) : (
              fixtures.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`odds-page__fixture-btn ${selectedFixture?.id === f.id ? "odds-page__fixture-btn--active" : ""}`}
                  onClick={() => setSelectedFixture(f)}
                >
                  <span className="odds-page__fixture-time">{formatTime(f.startingAt)}</span>
                  <span className="odds-page__fixture-league">{f.league.name}</span>
                  <span className="odds-page__fixture-match">
                    {f.homeTeam.name} v {f.awayTeam.name}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </section>

      {selectedFixture && (
        <section className="odds-page__workspace" aria-label="Odds workspace">
          <h2 className="odds-page__workspace-title">
            {selectedFixture.homeTeam.name} v {selectedFixture.awayTeam.name}
          </h2>
          <div className="odds-page__tabs" role="tablist" aria-label="Odds sections">
            {[
              { id: "all", label: "All" },
              { id: "core", label: "Core" },
              { id: "team", label: "Team" },
              { id: "player", label: "Player" },
              { id: "build", label: "Build" },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={oddsTab === tab.id}
                className={`odds-page__tab ${oddsTab === tab.id ? "odds-page__tab--active" : ""}`}
                onClick={() => setOddsTab(tab.id as typeof oddsTab)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="odds-page__filters">
            <label className="odds-page__filters-label">
              Bookmaker
              <select
                value={selectedBookmakerFilter}
                onChange={(e) => setSelectedBookmakerFilter(e.target.value)}
                className="odds-page__filters-select"
              >
                <option value="all">All Bookmakers</option>
                {bookmakerOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <span className="odds-page__filters-note">Filters apply to display only.</span>
          </div>
          <div className="odds-page__player-props-actions">
            <button
              type="button"
              className="odds-page__load-player-props-btn"
              onClick={(e) => {
                e.preventDefault();
                loadPlayerProps();
              }}
              disabled={playerOddsLoading}
              aria-busy={playerOddsLoading}
            >
              {playerOddsLoading ? "Loading…" : "Load Player Props"}
            </button>
          </div>
          {oddsLoading && <p className="odds-page__message">Loading odds…</p>}
          {oddsError && <p className="odds-page__message odds-page__message--error">{oddsError}</p>}
          {!oddsLoading && !oddsError && oddsData && (
            <>
              <p className="odds-page__message odds-page__auto-refresh" aria-live="polite">
                Auto refreshing every 30s
              </p>
              {(oddsTab === "all" || oddsTab === "core") && coreMarkets.length > 0 && (
                <div className="odds-page__section">
                  <h3 className="odds-page__section-heading">Core Markets</h3>
                  {coreMarkets.map((market) => (
                    <OddsMarketTable
                      key={market.marketId}
                      market={market}
                      bookmakers={filteredBookmakers}
                    />
                  ))}
                </div>
              )}
              {(oddsTab === "all" || oddsTab === "team") && teamPropMarkets.length > 0 && (
                <div className="odds-page__section">
                  <h3 className="odds-page__section-heading">Team Props</h3>
                  {teamPropMarkets.map((market) => (
                    <OddsMarketTable
                      key={market.marketId}
                      market={market}
                      bookmakers={filteredBookmakers}
                    />
                  ))}
                </div>
              )}
              {(oddsTab === "all" || oddsTab === "core" || oddsTab === "team") && coreMarkets.length === 0 && teamPropMarkets.length === 0 && (
                <p className="odds-page__message">No odds available for this fixture.</p>
              )}
            </>
          )}
          {(oddsTab === "all" || oddsTab === "player") && (playerOddsLoading || playerOddsError || playerOddsData) && (
            <div className="odds-page__section">
              <h3 className="odds-page__section-heading">Player Props</h3>
              {playerOddsLoading && (
                <p className="odds-page__message">Loading player props…</p>
              )}
              {!playerOddsLoading && playerOddsError && (
                <p className="odds-page__message odds-page__message--error">{playerOddsError}</p>
              )}
              {!playerOddsLoading && !playerOddsError && playerOddsData && (!Array.isArray(playerOddsData.markets) || playerOddsData.markets.length === 0) && (() => {
                const lineupExists =
                  playerOddsData?.lineupSource === "confirmed" ||
                  playerOddsData?.lineupSource === "predicted" ||
                  (typeof playerOddsData?.playerCount === "number" && playerOddsData.playerCount > 0);
                const noLineupCertain =
                  playerOddsData?.lineupSource === "none" ||
                  (typeof playerOddsData?.playerCount === "number" && playerOddsData.playerCount === 0);
                const emptyMessage = noLineupCertain
                  ? "No lineup available"
                  : "No player prop odds available for this fixture yet.";
                if (import.meta.env.DEV) {
                  console.log("[player-props] empty state render", {
                    lineupSource: playerOddsData?.lineupSource,
                    playerCount: playerOddsData?.playerCount,
                    marketsLength: playerOddsData?.markets?.length,
                    lineupExists,
                    emptyMessage,
                  });
                }
                return (
                  <>
                    {playerOddsData.lineupSource === "confirmed" && (
                      <p className="odds-page__message odds-page__lineup-badge">Using confirmed lineups</p>
                    )}
                    {playerOddsData.lineupSource === "predicted" && (
                      <p className="odds-page__message odds-page__lineup-badge">Using predicted lineups</p>
                    )}
                    <p className="odds-page__message">{emptyMessage}</p>
                  </>
                );
              })()}
              {!playerOddsLoading && !playerOddsError && playerOddsData && Array.isArray(playerOddsData.markets) && playerOddsData.markets.length > 0 && (
                <>
                  {playerOddsData.lineupSource === "confirmed" && (
                    <p className="odds-page__message odds-page__lineup-badge">Using confirmed lineups</p>
                  )}
                  {playerOddsData.lineupSource === "predicted" && (
                    <p className="odds-page__message odds-page__lineup-badge">Using predicted lineups</p>
                  )}
                  {(playerOddsData.markets || []).map((market, marketIdx) => (
                    <div key={market.marketId ?? marketIdx} className="odds-page__player-props-market">
                      <h4 className="odds-page__table-title">{market.marketName ?? `Market ${market.marketId ?? marketIdx}`}</h4>
                      {(market.players || []).map((player) => {
                        const filteredSelections = selectedBookmakerFilter === "all"
                          ? (player.selections || [])
                          : (player.selections || []).filter((sel) => sel.bookmakerName === selectedBookmakerFilter);
                        if (filteredSelections.length === 0) return null;
                        return (
                          <div key={player.playerId} className="odds-page__player-props-card">
                            <div className="odds-page__player-props-player">
                              {player.playerName}
                              <span className="odds-page__player-props-team">{player.teamName}</span>
                            </div>
                            <div className="odds-page__player-props-selections">
                              {filteredSelections.map((sel, i) => {
                                const isSinglePrice =
                                  market.marketId === MARKET_ID_PLAYER_SHOTS_ON_TARGET ||
                                  market.marketId === MARKET_ID_PLAYER_SHOTS;
                                return (
                                  <span key={i} className="odds-page__player-props-line">
                                    {sel.line} — O: {sel.overOdds ?? "—"}
                                    {!isSinglePrice && ` / U: ${sel.underOdds ?? "—"}`}
                                    <span className="odds-page__player-props-bookmaker"> — {sel.bookmakerName}</span>
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
          {(oddsTab === "all" || oddsTab === "build") && (
            <div className="odds-page__section odds-page__build-bet">
              <h3 className="odds-page__section-heading">Build Bet</h3>
              <div className="odds-page__build-bet-controls">
                <label className="odds-page__build-bet-label">
                  Min Odds
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    step={0.01}
                    value={buildBetMinOdds}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (Number.isFinite(v) && v >= 1) setBuildBetMinOdds(v);
                    }}
                    className="odds-page__build-bet-input"
                  />
                </label>
                <label className="odds-page__build-bet-label">
                  Max Odds
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    step={0.01}
                    value={buildBetMaxOdds}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (Number.isFinite(v) && v >= 1) setBuildBetMaxOdds(v);
                    }}
                    className="odds-page__build-bet-input"
                  />
                </label>
                <label className="odds-page__build-bet-label">
                  Max Legs
                  <select
                    value={buildBetMaxLegs}
                    onChange={(e) => setBuildBetMaxLegs(e.target.value === "3" ? 3 : 2)}
                    className="odds-page__build-bet-select"
                  >
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="odds-page__build-bet-btn"
                  onClick={() => {
                    const minOdds = buildBetMinOdds;
                    const maxOdds = buildBetMaxOdds;
                    const rangeInvalid = minOdds > maxOdds;
                    setBuildBetRangeInvalid(rangeInvalid);
                    if (rangeInvalid) {
                      setBuildBetResults([]);
                      return;
                    }
                    const selections = collectBuildBetSelections(oddsData, playerOddsData);
                    if (import.meta.env.DEV) {
                      const playerProps = selections.filter((s) =>
                        (PLAYER_PROP_MARKET_IDS as readonly number[]).includes(s.marketId)
                      ).length;
                      const coreMarkets = selections.filter((s) => [1, 14, 80].includes(s.marketId)).length;
                      const ladderMarkets = selections.filter((s) => isLadderMarket(s.marketId)).length;
                      const secondaryMarkets = selections.length - playerProps - coreMarkets - ladderMarkets;
                      console.log("[build-bet] candidate counts by market type", {
                        playerProps,
                        coreMarkets,
                        secondaryMarkets,
                        ladderMarkets,
                      });
                    }
                    const { combos, totalInRange } = generateBuildBetCombos(selections, minOdds, maxOdds, buildBetMaxLegs);
                    const midpoint = (minOdds + maxOdds) / 2;
                    if (import.meta.env.DEV) {
                      console.log("[build-bet] odds range", {
                        minOdds,
                        maxOdds,
                        midpoint,
                        validCombosInRange: totalInRange,
                      });
                      combos.forEach((combo, cIdx) => {
                        console.log("[build-bet] suggested bet comboScore", {
                          combo: cIdx + 1,
                          comboScore: combo.comboScore,
                          distanceFromMidpoint: combo.distanceFromMidpoint,
                          legs: combo.legs.length,
                        });
                        combo.legs.forEach((leg, lIdx) => {
                          const e = leg.evidence;
                          console.log("[build-bet] leg evidence", {
                            combo: cIdx + 1,
                            leg: lIdx + 1,
                            legId: leg.id.slice(0, 40),
                            hasLine: e?.line != null,
                            hasLineupStatus: e?.lineupStatus != null,
                            hasRecentStats: Boolean(e?.recentStats),
                            hasH2H: Boolean(e?.h2h),
                            hasTeamForm: Boolean(e?.teamForm),
                          });
                        });
                      });
                    }
                    setBuildBetResults(combos);
                  }}
                >
                  Build Bet
                </button>
              </div>
              {buildBetResults !== null && (
                <div className="odds-page__build-bet-results">
                  {buildBetResults.length === 0 ? (
                    buildBetRangeInvalid ? (
                      <p className="odds-page__message odds-page__message--error">
                        Min odds must be less than or equal to max odds.
                      </p>
                    ) : (
                      <p className="odds-page__message">
                        No combinations found within the odds range. Try widening the range or loading more markets.
                      </p>
                    )
                  ) : (
                    buildBetResults.map((combo, idx) => (
                      <div key={idx} className="odds-page__build-bet-card">
                        <h4 className="odds-page__build-bet-card-title">Suggested Bet {idx + 1}</h4>
                        <ul className="odds-page__build-bet-legs">
                          {combo.legs.map((leg, i) => {
                            const reasoningLines = formatLegReasoning(leg);
                            return (
                              <li key={i} className="odds-page__build-bet-leg-item">
                                <span className="odds-page__build-bet-leg-main">
                                  {leg.description} @ {leg.odds.toFixed(2)}
                                </span>
                                {reasoningLines.length > 0 && (
                                  <div className="odds-page__build-bet-reasoning">
                                    {reasoningLines.map((line, j) => (
                                      <p key={j} className="odds-page__build-bet-reasoning-line">
                                        {line}
                                      </p>
                                    ))}
                                  </div>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                        <p className="odds-page__build-bet-combined">
                          Combined Odds: {combo.combinedOdds.toFixed(2)}
                        </p>
                        <p className="odds-page__build-bet-range">
                          Range: {buildBetMinOdds.toFixed(2)}–{buildBetMaxOdds.toFixed(2)}
                        </p>
                        <p className="odds-page__build-bet-distance">
                          Distance from midpoint: {combo.distanceFromMidpoint.toFixed(2)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** Core markets: 80 and 81 are separate (no merge). Over/Under Goals = 80, Alternative Goals = 81. */
const DISPLAY_ORDER_CORE = [
  MARKET_ID_MATCH_RESULTS,
  MARKET_ID_BTTS,
  MARKET_ID_MATCH_GOALS,
  MARKET_ID_ALTERNATIVE_TOTAL_GOALS,
];
const DISPLAY_ORDER_TEAM_PROPS = [
  MARKET_ID_ALTERNATIVE_CORNERS,
  MARKET_ID_HOME_TEAM_GOALS,
  MARKET_ID_AWAY_TEAM_GOALS,
  MARKET_ID_TEAM_TOTAL_GOALS,
];

function getMarketsFromBookmakers(
  bookmakers: OddsBookmaker[],
  belongs: (marketId: number) => boolean,
  order: readonly number[]
): Array<{ marketId: number; marketName: string }> {
  const byId = new Map<number, string>();
  for (const b of bookmakers) {
    for (const m of b.markets) {
      if (m.selections.length > 0 && belongs(m.marketId)) {
        byId.set(m.marketId, m.marketName);
      }
    }
  }
  const out: Array<{ marketId: number; marketName: string }> = [];
  for (const id of order) {
    if (byId.has(id)) out.push({ marketId: id, marketName: byId.get(id)! });
  }
  return out;
}

function OddsMarketTable({
  market,
  bookmakers,
}: {
  market: { marketId: number; marketName: string };
  bookmakers: OddsBookmaker[];
}) {
  const rows = bookmakers
    .map((b) => {
      const m = b.markets.find((x) => x.marketId === market.marketId && x.selections.length > 0);
      return m ? { bookmaker: b, market: m } : null;
    })
    .filter((x): x is { bookmaker: OddsBookmaker; market: OddsMarket } => x != null);

  if (rows.length === 0) return null;

  const allLabels = new Set<string>();
  for (const { market: m } of rows) {
    for (const s of m.selections) allLabels.add(s.label);
  }
  const labelsList = Array.from(allLabels);
  const useGroupedOu = MULTI_LINE_OU_MARKET_IDS.includes(market.marketId);
  const lines = useGroupedOu ? getSortedLinesFromLabels(labelsList) : [];
  const columns = useGroupedOu ? [] : getOrderedColumns(market.marketId, labelsList);

  /** Compact header for multi-line goals: "Over 2.5" → "O2.5". */
  function formatHeader(marketId: number, label: string): string {
    if (marketId !== MARKET_ID_ALTERNATIVE_TOTAL_GOALS) return label;
    const lower = label.toLowerCase();
    if (lower.startsWith("over ")) return "O" + label.slice(4).replace(/\s/g, "");
    if (lower.startsWith("under ")) return "U" + label.slice(6).replace(/\s/g, "");
    return label;
  }

  if (useGroupedOu && lines.length > 0) {
    return (
      <div className="odds-page__table-wrap odds-page__table-wrap--grouped-ou">
        <h4 className="odds-page__table-title">{market.marketName}</h4>
        <table className="odds-page__table odds-page__table--grouped-ou">
          <thead>
            <tr>
              <th rowSpan={2} className="odds-page__th odds-page__th--bookmaker odds-page__th--grouped-bookmaker">
                Bookmaker
              </th>
              {lines.map((line) => (
                <th key={line} colSpan={2} className="odds-page__th odds-page__th--line-group">
                  {line}
                </th>
              ))}
            </tr>
            <tr>
              {lines.map((line) => (
                <React.Fragment key={line}>
                  <th className="odds-page__th odds-page__th--ou">O</th>
                  <th className="odds-page__th odds-page__th--ou">U</th>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ bookmaker, market: m }) => {
              const byLabel = new Map(m.selections.map((s) => [s.label, s.odds]));
              return (
                <tr key={bookmaker.bookmakerId}>
                  <td className="odds-page__td odds-page__td--bookmaker odds-page__td--grouped-bookmaker">
                    {bookmaker.bookmakerName}
                  </td>
                  {lines.map((line) => {
                    const overLabel = findLabelForLine(labelsList, line, "over");
                    const underLabel = findLabelForLine(labelsList, line, "under");
                    return (
                      <React.Fragment key={line}>
                        <td className="odds-page__td odds-page__td--ou">
                          {overLabel != null && byLabel.get(overLabel) != null ? String(byLabel.get(overLabel)) : "—"}
                        </td>
                        <td className="odds-page__td odds-page__td--ou">
                          {underLabel != null && byLabel.get(underLabel) != null ? String(byLabel.get(underLabel)) : "—"}
                        </td>
                      </React.Fragment>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="odds-page__table-wrap">
      <h4 className="odds-page__table-title">{market.marketName}</h4>
      <table className="odds-page__table">
        <thead>
          <tr>
            <th className="odds-page__th odds-page__th--bookmaker">Bookmaker</th>
            {columns.map((col) => (
              <th key={col} className="odds-page__th">
                {formatHeader(market.marketId, col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ bookmaker, market: m }) => {
            const byLabel = new Map(m.selections.map((s) => [s.label, s.odds]));
            return (
              <tr key={bookmaker.bookmakerId}>
                <td className="odds-page__td odds-page__td--bookmaker">{bookmaker.bookmakerName}</td>
                {columns.map((col) => (
                  <td key={col} className="odds-page__td">
                    {byLabel.get(col) != null ? String(byLabel.get(col)) : "—"}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
