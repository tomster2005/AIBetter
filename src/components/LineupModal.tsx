import { useState, useEffect, useMemo, useCallback } from "react";
import type { Fixture } from "../types/fixture.js";
import type { FixtureLineup } from "../api/fixture-details-types.js";
import type { RawLineupEntry } from "../api/fixture-details-types.js";
import {
  LineupModalHeader,
  TeamFormationHeader,
  ManagerCard,
  PitchLineupView,
  BenchSection,
} from "./lineup/index.js";
import type { PitchPlayer } from "./lineup/index.js";
import type { BenchPlayer } from "./lineup/index.js";
import { PlayerProfileModal } from "./player-profile/index.js";
import { FixtureOddsPanel } from "./FixtureOddsPanel.js";
import { BuildValueBetsModal } from "./BuildValueBetsModal.js";
import type { LineupContext } from "../lib/valueBetBuilder.js";
import {
  loadPlayerPropsForFixture,
  type PlayerOddsResponse as ServicePlayerOddsResponse,
} from "../services/playerPropsService.js";
import { appendBacktestSnapshots } from "../services/backtestSnapshotService.js";
import { useAutoResolveCombos } from "../hooks/useAutoResolveCombos.js";
import {
  loadPlayerSeasonStats,
  fetchLeagueCurrentSeason,
  type PlayerSeasonStats,
} from "../services/playerStatsService.js";
import {
  calculatePer90,
  probabilityOverLine,
  probabilityUnderLine,
  calculateEdge,
} from "../lib/playerPropProbability.js";
import {
  computeExpectedMinutes,
  lambdaFromPer90AndMinutes,
  getPositionMultiplier,
  getTeamOpponentFactors,
  homeAwayFactor,
  adjustLambda,
  shouldRejectByHardFilterForMarket,
  isOddsSane,
  bookmakerProbability as sanitizedBookmakerProbability,
  computeDataConfidenceScore,
  dataConfidenceBucket,
  computeBetQualityScore,
  betQualityBucket,
  getRelevantStatForMarket,
  isStrongBetCandidate,
  type ConfidenceLevel,
  type BetQualityLevel,
  type ValueBetModelInputs,
} from "../lib/valueBetModel.js";
import { calibrateProbability, isBucketCalibrated } from "../lib/valueBetCalibration.js";
import {
  MARKET_ID_PLAYER_SHOTS,
  MARKET_ID_PLAYER_SHOTS_ON_TARGET,
  MARKET_ID_PLAYER_FOULS_COMMITTED,
  MARKET_ID_PLAYER_FOULS_WON,
  MARKET_ID_PLAYER_TACKLES,
} from "../constants/marketIds.js";
import "./LineupModal.css";

/** One row for the Value Bet Analysis table. Model outputs are estimates, not guaranteed truth. */
export interface ValueBetRow {
  playerName: string;
  marketName: string;
  line: number;
  outcome: "Over" | "Under";
  odds: number;
  bookmakerId: number | null;
  bookmakerName: string;
  /** Bookmaker-implied probability (1/odds). */
  bookmakerProbability: number;
  /** Model probability 0–1 for display/sorting; from calibrated when available. */
  modelProbability?: number;
  /** Raw model probability before calibration. */
  rawModelProbability?: number;
  /** Calibrated probability (after backtest calibration); same as raw until calibration layer exists. */
  calibratedProbability?: number;
  /** Model probability as percentage string (e.g. "61.3%" or "—"). */
  probabilityPct: string;
  edgePct: string;
  /** Model edge (modelProb - bookmakerProb) for sorting/highlighting; undefined when no model. */
  modelEdge?: number;
  /** @deprecated Use modelEdge. Kept for compatibility. */
  edge?: number;
  /** Data confidence: how trustworthy the model inputs are. */
  dataConfidence: ConfidenceLevel;
  dataConfidenceScore: number;
  /** Bet quality: how meaningful the betting opportunity is. */
  betQuality: BetQualityLevel;
  betQualityScore: number;
  /** Model inputs for auditability and tooltips. */
  modelInputs?: ValueBetModelInputs;
  /** True when row meets strong-bet criteria (bet quality, edge, thresholds). */
  isStrongBet?: boolean;
  /** True when this row's probability bucket has enough historical sample for calibration. */
  calibrationBucketValid?: boolean;
  /** Sportmonks ids for live recent match stats (Build Value Bets evidence). */
  sportmonksPlayerId?: number;
  sportmonksTeamId?: number;
}

interface LineupModalProps {
  open: boolean;
  onClose: () => void;
  fixture: Fixture | null;
  loading: boolean;
  error: string | null;
  lineup: FixtureLineup | null;
  formations?: { home?: string; away?: string };
  /** Optional coach/manager info when available from fixture details */
  coaches?: {
    home?: { name?: string | null; image?: string | null };
    away?: { name?: string | null; image?: string | null };
  };
}

function formatKickoff(startingAt: string): string {
  const part = startingAt.trim().split(/\s+/)[1];
  if (!part) return "";
  const [h, m] = part.split(":");
  return `${h}:${m ?? "00"}`;
}

/** type_id 11 = starting XI in Sportmonks */
const TYPE_ID_STARTER = 11;

function getPlayerImage(entry: RawLineupEntry): string | null {
  const player = entry.player as { image_path?: string } | undefined;
  if (player?.image_path && typeof player.image_path === "string") return player.image_path;
  const path = entry.image_path ?? entry.image;
  if (path != null && typeof path === "string") return path;
  return null;
}

function splitStartersAndSubs(
  entries: RawLineupEntry[],
  homeTeamId: number,
  awayTeamId: number
): {
  homeStarters: PitchPlayer[];
  awayStarters: PitchPlayer[];
  homeSubs: BenchPlayer[];
  awaySubs: BenchPlayer[];
} {
  const homeStarters: PitchPlayer[] = [];
  const awayStarters: PitchPlayer[] = [];
  const homeSubs: BenchPlayer[] = [];
  const awaySubs: BenchPlayer[] = [];

  for (const e of entries) {
    const tid = e.team_id ?? 0;
    const isStarter = e.type_id === TYPE_ID_STARTER || e.type_id == null;
    const base = {
      player_name: e.player_name,
      jersey_number: e.jersey_number,
      image_url: getPlayerImage(e),
      player_id: e.player_id,
    };
    const pitchPlayer: PitchPlayer = {
      ...base,
      team_id: tid,
      formation_field: e.formation_field,
      formation_position: e.formation_position,
      position_id: e.position_id,
    };
    const benchPlayer: BenchPlayer = { ...base, team_id: tid };

    if (tid === homeTeamId) {
      if (isStarter) homeStarters.push(pitchPlayer);
      else homeSubs.push(benchPlayer);
    } else if (tid === awayTeamId) {
      if (isStarter) awayStarters.push(pitchPlayer);
      else awaySubs.push(benchPlayer);
    }
  }

  homeStarters.sort((a, b) => (a.formation_position ?? 99) - (b.formation_position ?? 99));
  awayStarters.sort((a, b) => (a.formation_position ?? 99) - (b.formation_position ?? 99));

  return { homeStarters, awayStarters, homeSubs, awaySubs };
}

function hasPositionalData(entries: RawLineupEntry[]): boolean {
  return entries.some((e) => {
    const f = e.formation_field;
    return f != null && String(f).trim() !== "";
  });
}

/** Build lineup context for Build Value Bets matchup boosts (home/away starters with position). */
function buildLineupContextForBuild(
  lineup: FixtureLineup | null,
  fixture: { homeTeam: { id: number }; awayTeam: { id: number } } | null
): LineupContext | null {
  if (!lineup?.data || !fixture) return null;
  const entries = lineup.data as RawLineupEntry[];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const homeId = fixture.homeTeam.id;
  const awayId = fixture.awayTeam.id;
  const homeStarters: LineupContext["homeStarters"] = [];
  const awayStarters: LineupContext["awayStarters"] = [];
  for (const e of entries) {
    const isStarter = e.type_id === TYPE_ID_STARTER || e.type_id == null;
    if (!isStarter) continue;
    const tid = e.team_id ?? 0;
    const info = { playerName: e.player_name ?? "", positionId: e.position_id };
    if (tid === homeId) homeStarters.push(info);
    else if (tid === awayId) awayStarters.push(info);
  }
  return { homeStarters, awayStarters };
}

type ValueSortKey = "odds" | "probability" | "edge";

function LineupContent({
  fixture,
  loading,
  error,
  lineup,
  formations,
  coaches,
  onPlayerClick,
  onFindValueBets,
  onBuildValueBets,
  loadingValueBets,
  valueBetRows,
  valueBetStartingCount,
  foulsMarketsStatus,
  sortConfig,
  onSortConfigChange,
  hideNegativeEdge,
  onHideNegativeEdgeChange,
  selectedBookmaker,
  onSelectedBookmakerChange,
}: {
  fixture: Fixture | null;
  loading: boolean;
  error: string | null;
  lineup: FixtureLineup | null;
  formations?: { home?: string; away?: string };
  coaches?: LineupModalProps["coaches"];
  onPlayerClick?: (playerId: number, teamName?: string) => void;
  onFindValueBets?: () => void;
  onBuildValueBets?: () => void;
  loadingValueBets?: boolean;
  valueBetRows?: ValueBetRow[] | null;
  valueBetStartingCount?: number | null;
  foulsMarketsStatus?: { foulStatsAvailable: boolean; foulMarketsSeen: number } | null;
  sortConfig?: { key: ValueSortKey; direction: "asc" | "desc" };
  onSortConfigChange?: (key: ValueSortKey) => void;
  hideNegativeEdge?: boolean;
  onHideNegativeEdgeChange?: (value: boolean) => void;
  selectedBookmaker?: string;
  onSelectedBookmakerChange?: (value: string) => void;
}) {
  const [matchOddsExpanded, setMatchOddsExpanded] = useState(false);

  const displayRows = useMemo(() => {
    const rows = valueBetRows ?? [];
    if (rows.length === 0) return [];
    let filtered = [...rows];
    if (selectedBookmaker != null && selectedBookmaker !== "all") {
      filtered = filtered.filter((row) => (row.bookmakerName ?? "Unknown bookmaker") === selectedBookmaker);
    }
    if (hideNegativeEdge) {
      filtered = filtered.filter((row) => typeof row.modelEdge === "number" && row.modelEdge >= 0);
    }
    const key = sortConfig?.key ?? "edge";
    const dir = sortConfig?.direction ?? "desc";
    filtered.sort((a, b) => {
      let va: number, vb: number;
      if (key === "odds") {
        va = a.odds ?? 0;
        vb = b.odds ?? 0;
      } else if (key === "probability") {
        va = a.modelProbability ?? 0;
        vb = b.modelProbability ?? 0;
      } else {
        va = a.modelEdge ?? a.edge ?? 0;
        vb = b.modelEdge ?? b.edge ?? 0;
      }
      if (va !== vb) return dir === "asc" ? va - vb : vb - va;
      return 0;
    });
    return filtered;
  }, [valueBetRows, selectedBookmaker, hideNegativeEdge, sortConfig?.key, sortConfig?.direction]);

  const bookmakerOptions = useMemo(() => {
    const rows = valueBetRows ?? [];
    const names = new Set<string>();
    for (const row of rows) {
      const n = row.bookmakerName?.trim() || "Unknown bookmaker";
      names.add(n);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [valueBetRows]);

  const displayRowsByMarket = useMemo(() => {
    const rows = valueBetRows ?? [];
    if (rows.length === 0)
      return { shots: 0, shotsOnTarget: 0, foulsCommitted: 0, foulsWon: 0, tackles: 0, total: 0 };
    let filtered = [...rows];
    if (selectedBookmaker != null && selectedBookmaker !== "all") {
      filtered = filtered.filter((row) => (row.bookmakerName ?? "Unknown bookmaker") === selectedBookmaker);
    }
    if (hideNegativeEdge) {
      filtered = filtered.filter((row) => typeof row.modelEdge === "number" && row.modelEdge >= 0);
    }
    const byMarket = { shots: 0, shotsOnTarget: 0, foulsCommitted: 0, foulsWon: 0, tackles: 0, total: filtered.length };
    for (const row of filtered) {
      const name = row.marketName ?? "";
      if (name.includes("Fouls Won")) byMarket.foulsWon += 1;
      else if (name.includes("Fouls Committed")) byMarket.foulsCommitted += 1;
      else if (name.includes("Player Tackles") || (name.includes("Tackles") && !name.includes("Foul")))
        byMarket.tackles += 1;
      else if (name.includes("Shots On Target")) byMarket.shotsOnTarget += 1;
      else if (name.includes("Shots")) byMarket.shots += 1;
    }
    return byMarket;
  }, [valueBetRows, selectedBookmaker, hideNegativeEdge]);

  useEffect(() => {
    if (import.meta.env.DEV && valueBetRows != null && valueBetRows.length > 0) {
      console.log("[value-bets] display rows by market", displayRowsByMarket);
      const firstWithEdge = valueBetRows.find((r) => r.modelEdge != null || r.edge != null);
      if (firstWithEdge) {
        const modelProb = firstWithEdge.calibratedProbability ?? firstWithEdge.modelProbability ?? 0;
        const bookProb = firstWithEdge.bookmakerProbability ?? 0;
        const displayedEdge = firstWithEdge.modelEdge ?? firstWithEdge.edge ?? 0;
        console.log("[value-bets] edge check", {
          playerName: firstWithEdge.playerName,
          marketName: firstWithEdge.marketName,
          odds: firstWithEdge.odds,
          bookmakerProbability: bookProb,
          modelProbability: modelProb,
          displayedEdge,
          expectedEdge: modelProb - bookProb,
        });
      }
    }
  }, [valueBetRows, displayRowsByMarket]);

  if (loading) return <p className="lineup-modal__message">Loading…</p>;
  if (error) return <p className="lineup-modal__message lineup-modal__message--error">{error}</p>;
  // Only show "not released" when there is no lineup data at all (no entries to render).
  const entries = lineup ? (lineup.data as RawLineupEntry[]) : [];
  if (!lineup || entries.length === 0) {
    return <p className="lineup-modal__message">Official lineups not released yet.</p>;
  }
  const homeId = fixture?.homeTeam.id ?? 0;
  const awayId = fixture?.awayTeam.id ?? 0;
  const { homeStarters, awayStarters, homeSubs, awaySubs } = splitStartersAndSubs(
    entries,
    homeId,
    awayId
  );
  const usePitch = hasPositionalData(entries) && (homeStarters.length > 0 || awayStarters.length > 0);
  const showFindValueBets = onFindValueBets != null && fixture != null;
  const showBuildValueBets = onBuildValueBets != null && fixture != null;

  return (
    <div className="lineup-content lineup-content--spaced">
      <div className="lineup-content__find-value-section">
        <h3 className="lineup-content__starting-title">Starting Lineups</h3>
        <div className="lineup-content__value-bet-buttons">
          {showFindValueBets && (
            <button
              type="button"
              className="lineup-content__find-value-btn"
              onClick={onFindValueBets}
              disabled={loadingValueBets}
              aria-busy={loadingValueBets}
            >
              {loadingValueBets ? "Scanning player markets…" : "Find Value Bets"}
            </button>
          )}
          {showBuildValueBets && (
            <button
              type="button"
              className="lineup-content__find-value-btn lineup-content__build-value-btn"
              onClick={onBuildValueBets}
            >
              Build Value Bets
            </button>
          )}
        </div>
      </div>
      <TeamFormationHeader
        fixture={fixture}
        homeFormation={formations?.home}
        awayFormation={formations?.away}
      />
      <div className="lineup-content__managers">
        <ManagerCard
          name={coaches?.home?.name ?? "Manager unavailable"}
          imageUrl={coaches?.home?.image}
          side="home"
        />
        <ManagerCard
          name={coaches?.away?.name ?? "Manager unavailable"}
          imageUrl={coaches?.away?.image}
          side="away"
        />
      </div>
      {usePitch ? (
        <PitchLineupView
          homePlayers={homeStarters}
          awayPlayers={awayStarters}
          homeTeamName={fixture?.homeTeam.name ?? "Home"}
          awayTeamName={fixture?.awayTeam.name ?? "Away"}
          onPlayerClick={onPlayerClick}
        />
      ) : (
        <div className="lineup-content__teams-fallback">
          <div className="lineup-content__team-block">
            <div className="lineup-content__team-header">
              {fixture?.homeTeam.logo && (
                <img src={fixture.homeTeam.logo} alt="" className="lineup-content__team-logo" />
              )}
              <span className="lineup-content__team-name">{fixture?.homeTeam.name ?? "Home"}</span>
            </div>
            <div className="lineup-content__player-list">
              {homeStarters.map((p, i) => (
                <div key={i} className="lineup-content__player-row">
                  <span className="lineup-content__jersey">{p.jersey_number ?? "–"}</span>
                  <span className="lineup-content__name">{p.player_name ?? "–"}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="lineup-content__team-block">
            <div className="lineup-content__team-header">
              {fixture?.awayTeam.logo && (
                <img src={fixture.awayTeam.logo} alt="" className="lineup-content__team-logo" />
              )}
              <span className="lineup-content__team-name">{fixture?.awayTeam.name ?? "Away"}</span>
            </div>
            <div className="lineup-content__player-list">
              {awayStarters.map((p, i) => (
                <div key={i} className="lineup-content__player-row">
                  <span className="lineup-content__jersey">{p.jersey_number ?? "–"}</span>
                  <span className="lineup-content__name">{p.player_name ?? "–"}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <BenchSection
        homeSubs={homeSubs}
        awaySubs={awaySubs}
        homeTeamName={fixture?.homeTeam.name ?? "Home"}
        awayTeamName={fixture?.awayTeam.name ?? "Away"}
        onPlayerClick={onPlayerClick}
      />

      {fixture != null && (
        <section className="lineup-content__match-odds" aria-label="Match odds">
          <button
            type="button"
            className="lineup-content__match-odds-toggle"
            onClick={() => setMatchOddsExpanded((prev) => !prev)}
            aria-expanded={matchOddsExpanded}
            aria-controls="lineup-content__match-odds-body"
            id="lineup-content__match-odds-heading"
          >
            <span className="lineup-content__match-odds-toggle-icon" aria-hidden>
              {matchOddsExpanded ? "▼" : "▶"}
            </span>
            <span className="lineup-content__match-odds-toggle-title">Match Odds</span>
          </button>
          {matchOddsExpanded && (
            <div
              id="lineup-content__match-odds-body"
              className="lineup-content__match-odds-body"
              aria-labelledby="lineup-content__match-odds-heading"
            >
              <FixtureOddsPanel fixtureId={fixture.id} fixtureLabel={null} hidePlayerPropsSection />
            </div>
          )}
        </section>
      )}

      {/* Value Bet Analysis: only show section when button exists (lineups loaded) */}
      {showFindValueBets && (
        <section className="lineup-content__value-analysis" aria-label="Value bet analysis">
          <h3 className="lineup-content__value-analysis-title">Value Bet Analysis</h3>
          <p className="lineup-content__value-analysis-note">Model estimates only — not guaranteed. Use bet quality and data confidence before relying on edges.</p>
          {!loadingValueBets && valueBetRows != null && foulsMarketsStatus?.foulStatsAvailable === true && foulsMarketsStatus?.foulMarketsSeen === 0 && (
            <p className="lineup-content__value-fouls-note" role="status">
              Foul stats are available, but no bookmaker foul markets were found for this fixture.
            </p>
          )}
          {loadingValueBets && (
            <p className="lineup-modal__message">Scanning player markets…</p>
          )}
          {!loadingValueBets && valueBetRows != null && valueBetRows.length === 0 && (
            <p className="lineup-modal__message">
              {valueBetStartingCount === 0
                ? "Lineup not confirmed yet — using predicted players."
                : "No value bets detected."}
            </p>
          )}
          {!loadingValueBets && valueBetRows != null && valueBetRows.length > 0 && (
              <>
                <div className="lineup-content__value-controls">
                  <label className="lineup-content__value-controls-select">
                    <span className="lineup-content__value-controls-label">Bookmaker</span>
                    <select
                      value={selectedBookmaker ?? "all"}
                      onChange={(e) => onSelectedBookmakerChange?.(e.target.value)}
                      aria-label="Filter by bookmaker"
                      className="lineup-content__value-controls-bookmaker-select"
                    >
                      <option value="all">All Bookmakers</option>
                      {bookmakerOptions.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="lineup-content__value-controls-toggle">
                    <input
                      type="checkbox"
                      checked={hideNegativeEdge ?? false}
                      onChange={(e) => onHideNegativeEdgeChange?.(e.target.checked)}
                      aria-label="Hide negative edge"
                    />
                    <span>Hide negative edge</span>
                  </label>
                  <span className="lineup-content__value-controls-count" aria-live="polite">
                    Showing {displayRows.length} of {valueBetRows.length} rows
                  </span>
                </div>
                {displayRows.length === 0 ? (
                  <p className="lineup-modal__message">No rows match the current filters.</p>
                ) : (
                  <div className="lineup-content__value-table-wrap">
                    <table className="lineup-content__value-table">
                      <thead>
                        <tr>
                          <th className="lineup-content__value-th">Bookmaker</th>
                          <th className="lineup-content__value-th">Player</th>
                          <th className="lineup-content__value-th">Market</th>
                          <th className="lineup-content__value-th">Line</th>
                          <th
                            className="lineup-content__value-th lineup-content__value-th--numeric lineup-content__value-th--sortable"
                            onClick={() => onSortConfigChange?.("odds")}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => e.key === "Enter" && onSortConfigChange?.("odds")}
                            aria-sort={sortConfig?.key === "odds" ? (sortConfig.direction === "asc" ? "ascending" : "descending") : undefined}
                          >
                            Odds {sortConfig?.key === "odds" ? (sortConfig.direction === "asc" ? "▲" : "▼") : ""}
                          </th>
                          <th
                            className="lineup-content__value-th lineup-content__value-th--numeric lineup-content__value-th--sortable"
                            onClick={() => onSortConfigChange?.("probability")}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => e.key === "Enter" && onSortConfigChange?.("probability")}
                            aria-sort={sortConfig?.key === "probability" ? (sortConfig.direction === "asc" ? "ascending" : "descending") : undefined}
                          >
                            Prob. {sortConfig?.key === "probability" ? (sortConfig.direction === "asc" ? "▲" : "▼") : ""}
                          </th>
                          <th
                            className="lineup-content__value-th lineup-content__value-th--numeric lineup-content__value-th--sortable"
                            onClick={() => onSortConfigChange?.("edge")}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => e.key === "Enter" && onSortConfigChange?.("edge")}
                            aria-sort={sortConfig?.key === "edge" ? (sortConfig.direction === "asc" ? "ascending" : "descending") : undefined}
                          >
                            Edge {sortConfig?.key === "edge" ? (sortConfig.direction === "asc" ? "▲" : "▼") : ""}
                          </th>
                          <th className="lineup-content__value-th">Bet Quality</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayRows.map((row, i) => {
                          const isNewPlayer = i === 0 || displayRows[i - 1].playerName !== row.playerName;
                          const edge = row.modelEdge ?? row.edge;
                          const isStrong = row.isStrongBet === true;
                          const tooltipParts: string[] = [];
                          tooltipParts.push(`Bookmaker: ${row.bookmakerName ?? "Unknown bookmaker"}`);
                          tooltipParts.push(`Data confidence: ${row.dataConfidence.charAt(0).toUpperCase() + row.dataConfidence.slice(1)} (${row.dataConfidenceScore})`);
                          tooltipParts.push(`Bet quality: ${row.betQuality.charAt(0).toUpperCase() + row.betQuality.slice(1)} (${row.betQualityScore})`);
                          if (row.modelInputs) {
                            tooltipParts.push(`Appearances: ${row.modelInputs.appearances}, mins: ${row.modelInputs.minutesPlayed}, exp mins: ${row.modelInputs.expectedMinutes.toFixed(0)}, pos mult: ${row.modelInputs.positionMultiplier.toFixed(2)}`);
                          }
                          if (row.rawModelProbability != null && row.calibratedProbability != null && row.rawModelProbability !== row.calibratedProbability) {
                            tooltipParts.push(`Raw: ${(row.rawModelProbability * 100).toFixed(1)}% → Calibrated: ${(row.calibratedProbability * 100).toFixed(1)}%`);
                          }
                          if (row.betQuality === "low" && row.calibratedProbability != null) {
                            const reasons: string[] = [];
                            if (row.calibratedProbability < 0.02) reasons.push(`calibrated probability only ${(row.calibratedProbability * 100).toFixed(1)}%`);
                            if ((edge ?? 0) < 0) reasons.push("negative edge");
                            if (row.odds > 15) reasons.push("odds very high");
                            if (reasons.length) tooltipParts.push(`Reason: ${reasons.join("; ")}`);
                          }
                          return (
                            <tr
                              key={i}
                              className={`lineup-content__value-row ${i % 2 === 0 ? "lineup-content__value-row--even" : "lineup-content__value-row--odd"} ${isNewPlayer ? "lineup-content__value-row--player-start" : ""} ${isStrong ? "lineup-content__value-row--strong" : ""}`}
                              title={tooltipParts.join("\n") || undefined}
                            >
                              <td className="lineup-content__value-td lineup-content__value-td--bookmaker">{row.bookmakerName ?? "Unknown bookmaker"}</td>
                              <td className="lineup-content__value-td lineup-content__value-td--player">{row.playerName}</td>
                              <td className="lineup-content__value-td lineup-content__value-td--market">{row.marketName}</td>
                              <td className="lineup-content__value-td lineup-content__value-td--nowrap">{row.outcome} {row.line}</td>
                              <td className="lineup-content__value-td lineup-content__value-td--numeric">{row.odds.toFixed(2)}</td>
                              <td className="lineup-content__value-td lineup-content__value-td--numeric">{row.probabilityPct}</td>
                              <td
                                className={
                                  edge != null
                                    ? edge > 0.05
                                      ? "lineup-content__value-td lineup-content__value-td--numeric lineup-content__value-td--edge-positive"
                                      : edge < -0.05
                                        ? "lineup-content__value-td lineup-content__value-td--numeric lineup-content__value-td--edge-negative"
                                        : "lineup-content__value-td lineup-content__value-td--numeric"
                                    : "lineup-content__value-td lineup-content__value-td--numeric"
                                }
                              >
                                {row.edgePct}
                              </td>
                              <td className="lineup-content__value-td lineup-content__value-td--bet-quality">
                                <span className={`lineup-content__value-bet-quality lineup-content__value-bet-quality--${row.betQuality}`}>
                                  {row.betQuality.charAt(0).toUpperCase() + row.betQuality.slice(1)}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Resolve player id from a lineup entry.
 */
function getPlayerIdFromEntry(e: RawLineupEntry): number | undefined {
  const id = e.player_id ?? (e.player as { id?: number } | undefined)?.id;
  return typeof id === "number" && id > 0 ? id : undefined;
}

/**
 * Starting player detection for value analysis. Priority:
 * 1) Confirmed starters (type_id === 11)
 * 2) If none → predicted lineup (type_id === 1 or predicted === true)
 * 3) If none → all lineup players
 */
function getStartingPlayerIds(entries: RawLineupEntry[]): Set<number> {
  if (!entries || entries.length === 0) return new Set<number>();

  const confirmed = entries.filter((e) => e.type_id === 11);
  if (confirmed.length > 0) {
    const ids = new Set<number>();
    for (const e of confirmed) {
      const id = getPlayerIdFromEntry(e);
      if (id != null) ids.add(id);
    }
    return ids;
  }

  const predicted = entries.filter(
    (e) => e.type_id === 1 || (e as { predicted?: boolean }).predicted === true
  );
  if (predicted.length > 0) {
    const ids = new Set<number>();
    for (const e of predicted) {
      const id = getPlayerIdFromEntry(e);
      if (id != null) ids.add(id);
    }
    return ids;
  }

  const ids = new Set<number>();
  for (const e of entries) {
    const id = getPlayerIdFromEntry(e);
    if (id != null) ids.add(id);
  }
  return ids;
}

/**
 * Normalize player name for lineup/market matching: lowercase, trim, collapse spaces,
 * remove accents/diacritics, remove punctuation, normalize apostrophes and hyphens.
 * Ensures "Virgil van Dijk", "Virgil Van Dijk", "Virgil van-Dijk" all match.
 */
function normalizePlayerName(name: string): string {
  let s = String(name ?? "").trim().toLowerCase();
  s = s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  s = s.replace(/[\s\u00A0]+/g, " ");
  s = s.replace(/['′ʼʻˈ՚]/g, "'").replace(/[-‐‑‒–—―]/g, "-");
  s = s.replace(/[^\p{L}\p{N}\s'-]/gu, "").replace(/\s+/g, " ").trim();
  return s || "";
}

/** Set of normalized player names from lineup entries (for name-based fallback when API uses name-derived IDs). */
function getStartingPlayerNames(entries: RawLineupEntry[]): Set<string> {
  const names = new Set<string>();
  for (const e of entries) {
    const n = e.player_name ?? (e.player as { name?: string })?.name;
    if (typeof n === "string" && n.trim()) names.add(normalizePlayerName(n));
  }
  return names;
}

/** Map normalized name -> lineup player_id (for resolving stats when props only have name). */
function getNameToPlayerIdMap(entries: RawLineupEntry[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of entries) {
    const id = getPlayerIdFromEntry(e);
    const n = e.player_name ?? (e.player as { name?: string })?.name;
    if (id != null && typeof n === "string" && n.trim()) map.set(normalizePlayerName(n), id);
  }
  return map;
}

/** Starter lineup entries (same logic as getStartingPlayerIds). */
function getStarterEntries(entries: RawLineupEntry[]): RawLineupEntry[] {
  const confirmed = entries.filter((e) => e.type_id === 11);
  if (confirmed.length > 0) return confirmed;
  const predicted = entries.filter(
    (e) => e.type_id === 1 || (e as { predicted?: boolean }).predicted === true
  );
  if (predicted.length > 0) return predicted;
  return entries;
}

/** Info from lineup for a starter: position, team, confirmed. */
interface StarterLineupInfo {
  positionId: number | undefined;
  teamId: number;
  confirmedStarter: boolean;
}

function buildStarterLineupMaps(
  entries: RawLineupEntry[]
): { byPlayerId: Map<number, StarterLineupInfo>; byNormalizedName: Map<string, StarterLineupInfo & { playerId: number }> } {
  const starterEntries = getStarterEntries(entries);
  const byPlayerId = new Map<number, StarterLineupInfo>();
  const byNormalizedName = new Map<string, StarterLineupInfo & { playerId: number }>();
  for (const e of starterEntries) {
    const playerId = getPlayerIdFromEntry(e);
    const name = e.player_name ?? (e.player as { name?: string })?.name;
    const teamId = e.team_id ?? 0;
    const confirmedStarter = e.type_id === 11;
    const info: StarterLineupInfo = {
      positionId: e.position_id,
      teamId,
      confirmedStarter,
    };
    if (playerId != null) byPlayerId.set(playerId, info);
    if (typeof name === "string" && name.trim()) {
      byNormalizedName.set(normalizePlayerName(name), { ...info, playerId: playerId ?? 0 });
    }
  }
  return { byPlayerId, byNormalizedName };
}

/** Safely extract player id from API player object (camelCase or snake_case). */
function getPlayerId(player: { playerId?: number; player_id?: number; player?: { id?: number }; id?: number }): number | undefined {
  const id =
    (player as { playerId?: number }).playerId ??
    (player as { player_id?: number }).player_id ??
    (player as { player?: { id?: number } }).player?.id ??
    (player as { id?: number }).id;
  return typeof id === "number" && Number.isFinite(id) ? id : undefined;
}

/** Resolve lineup player ID for a props player (by id or by name) for stats lookup. */
function resolvePlayerIdForStats(
  playerIdFromProps: number | undefined,
  normalizedName: string,
  startingPlayerIds: Set<number>,
  nameToPlayerId: Map<string, number>
): number | undefined {
  if (playerIdFromProps != null && startingPlayerIds.has(playerIdFromProps)) return playerIdFromProps;
  return nameToPlayerId.get(normalizedName);
}

/** Supported player-prop markets for the model (Shots, SOT, Fouls Committed, Fouls Won). */
const SUPPORTED_VALUE_BET_MARKET_IDS = new Set([
  MARKET_ID_PLAYER_SHOTS,
  MARKET_ID_PLAYER_SHOTS_ON_TARGET,
  MARKET_ID_PLAYER_FOULS_COMMITTED,
  MARKET_ID_PLAYER_FOULS_WON,
  MARKET_ID_PLAYER_TACKLES,
]);

/**
 * Build model outputs and row fields. Uses expected minutes, position, and context factors.
 * Does NOT claim certainty — these are model estimates for validation/calibration.
 */
function buildValueBetRowFields(
  stats: PlayerSeasonStats,
  marketId: number,
  line: number,
  outcome: "Over" | "Under",
  odds: number,
  lineupInfo: StarterLineupInfo | null,
  fixture: { homeTeam: { id: number }; awayTeam: { id: number } } | null,
  lineupConfirmed: boolean,
  matchedById: boolean,
  playerName?: string,
  onFoulsReject?: (reason: string) => void
): {
  probabilityPct: string;
  edgePct: string;
  rawModelProbability: number;
  calibratedProbability: number;
  /** For DEV diagnostics: calibrated probability before any 0.5-line blending. */
  originalCalibratedProbability: number;
  /** For DEV diagnostics: empirical baseline proxy for ">=1 event" (line 0.5 only). */
  empiricalAtLeastOneApprox?: number;
  modelEdge: number;
  bookmakerProbability: number;
  modelInputs: ValueBetModelInputs;
  dataConfidence: ConfidenceLevel;
  dataConfidenceScore: number;
} | null {
  const appearances = stats.appearances ?? 0;
  const minutesPlayed = stats.minutesPlayed ?? 0;
  const expectedMinutes = computeExpectedMinutes(minutesPlayed, appearances);

  if (shouldRejectByHardFilterForMarket(appearances, minutesPlayed, expectedMinutes, marketId)) {
    onFoulsReject?.("hardFilter");
    return null;
  }
  if (!isOddsSane(odds) || !Number.isFinite(line)) {
    onFoulsReject?.("invalidOddsOrLine");
    return null;
  }

  const bookmakerProb = sanitizedBookmakerProbability(odds);
  if (bookmakerProb <= 0) {
    onFoulsReject?.("bookmakerProbLte0");
    return null;
  }

  const statValue = getRelevantStatForMarket(stats, marketId, minutesPlayed);
  if (statValue == null) {
    onFoulsReject?.("noRelevantStat");
    return null;
  }
  const per90 = calculatePer90(statValue, minutesPlayed);
  const effectiveMinutesForShots =
    marketId === MARKET_ID_PLAYER_SHOTS
      ? Math.max(minutesPlayed, expectedMinutes * 8)
      : minutesPlayed;
  const per90ForLambda =
    marketId === MARKET_ID_PLAYER_SHOTS && effectiveMinutesForShots > 0
      ? (statValue / effectiveMinutesForShots) * 90
      : per90;
  const lambda = lambdaFromPer90AndMinutes(per90ForLambda, expectedMinutes);
  const positionMultiplier = getPositionMultiplier(lineupInfo?.positionId);
  const { teamAttackFactor, opponentDefenceFactor } = getTeamOpponentFactors({
    teamId: lineupInfo?.teamId,
    isHome: fixture ? lineupInfo?.teamId === fixture.homeTeam.id : undefined,
  });
  const isHome = fixture != null && lineupInfo != null && lineupInfo.teamId === fixture.homeTeam.id;
  const homeAway = homeAwayFactor(isHome);
  const adjustedLambda = adjustLambda(
    lambda,
    positionMultiplier,
    teamAttackFactor,
    opponentDefenceFactor,
    homeAway
  );
  const rawModelProbability =
    outcome === "Over"
      ? probabilityOverLine(adjustedLambda, line)
      : probabilityUnderLine(adjustedLambda, line);
  const dataConfidenceScore = computeDataConfidenceScore({
    appearances,
    minutesPlayed,
    expectedMinutes,
    confirmedStarter: lineupInfo?.confirmedStarter ?? false,
    matchedById,
    lineupConfirmed,
  });
  const dataConfidence = dataConfidenceBucket(dataConfidenceScore);
  const originalCalibratedProbability = calibrateProbability(rawModelProbability, {
    marketId,
    positionId: lineupInfo?.positionId,
    dataConfidence,
  });
  const clamp01 = (p: number) => Math.max(0, Math.min(1, p));
  let calibratedProbability = originalCalibratedProbability;
  let empiricalAtLeastOneApprox: number | undefined = undefined;
  if (line === 0.5) {
    const empiricalPerAppearance = appearances > 0 ? statValue / appearances : 0;
    empiricalAtLeastOneApprox = Math.min(empiricalPerAppearance, 1);
    calibratedProbability = clamp01(
      originalCalibratedProbability * 0.65 + empiricalAtLeastOneApprox * 0.35
    );
  }
  const modelEdge = calculateEdge(calibratedProbability, bookmakerProb);

  const modelInputs: ValueBetModelInputs = {
    shots: stats.shots,
    shotsOnTarget: stats.shotsOnTarget,
    foulsCommitted: stats.foulsCommitted ?? 0,
    foulsWon: stats.foulsWon ?? 0,
    ...(stats.tackles !== undefined && stats.tackles !== null ? { tackles: stats.tackles } : {}),
    minutesPlayed,
    appearances,
    expectedMinutes,
    per90: per90ForLambda,
    lambda,
    positionMultiplier,
    adjustedLambda,
    impliedProbability: bookmakerProb,
    rawModelProbability,
    teamAttackFactor,
    opponentDefenceFactor,
    homeAwayFactor: homeAway,
  };

  const probabilityPct =
    calibratedProbability === 0
      ? "0.0%"
      : calibratedProbability > 0 && calibratedProbability < 0.001
        ? "<0.1%"
        : (calibratedProbability * 100).toFixed(1) + "%";
  const pct = (modelEdge * 100).toFixed(1);
  const sign = modelEdge >= 0 ? "+" : "";
  return {
    probabilityPct,
    edgePct: `${sign}${pct}%`,
    rawModelProbability,
    calibratedProbability,
    originalCalibratedProbability,
    empiricalAtLeastOneApprox,
    modelEdge,
    bookmakerProbability: bookmakerProb,
    modelInputs,
    dataConfidence,
    dataConfidenceScore,
  };
}

/** Row when we have no stats or model: no edge, data confidence and bet quality low. */
function buildNoModelRow(
  line: number,
  outcome: "Over" | "Under",
  odds: number,
  bookmakerName: string
): Partial<ValueBetRow> {
  const bookmakerProb = isOddsSane(odds) ? sanitizedBookmakerProbability(odds) : 0;
  return {
    probabilityPct: "—",
    edgePct: "—",
    modelProbability: undefined,
    rawModelProbability: undefined,
    calibratedProbability: undefined,
    modelEdge: undefined,
    edge: undefined,
    bookmakerProbability: bookmakerProb,
    dataConfidence: "low",
    dataConfidenceScore: 0,
    betQuality: "low",
    betQualityScore: 0,
    isStrongBet: false,
  };
}

/** Flatten player props to table rows (starting players only). Applies hard filter, bookmaker sanity, confidence, model inputs. */
function buildValueBetRows(
  data: ServicePlayerOddsResponse,
  entries: RawLineupEntry[],
  fixture: { homeTeam: { id: number }; awayTeam: { id: number } } | null,
  lineupConfirmed: boolean,
  startingPlayerIds: Set<number>,
  startingPlayerNames: Set<string>,
  statsByPlayerId: Map<number, PlayerSeasonStats>,
  nameToPlayerId: Map<string, number>
): { rows: ValueBetRow[]; foulStatsAvailable: boolean; foulMarketsSeen: number } {
  const rows: ValueBetRow[] = [];
  const marketIdFromMarket = (m: { marketId?: number; market_id?: number; id?: number }): number => {
    const id = (m as { marketId?: number }).marketId ?? (m as { market_id?: number }).market_id ?? (m as { id?: number }).id;
    return typeof id === "number" && Number.isFinite(id) ? id : 0;
  };
  const { byPlayerId: lineupByPlayerId, byNormalizedName: lineupByNormalizedName } =
    buildStarterLineupMaps(entries);
  const seen = new Set<string>();

  let foulMarketsSeen = 0;
  let foulPlayersSeen = 0;
  let foulRowsCreated = 0;
  let foulRowsSkipped = 0;
  let foulStatsAvailable = false;
  const skipReasonsBreakdown: Record<string, number> = {
    marketNotSupported: 0,
    playerNotInLineup: 0,
    noSelections: 0,
    duplicate: 0,
    invalidOdds: 0,
    invalidLine: 0,
    modelReturnedNull: 0,
    probabilityOrEdgeOutOfRange: 0,
    statsMissing: 0,
    noStatsAndInvalidOdds: 0,
    hardFilter: 0,
    invalidOddsOrLine: 0,
    bookmakerProbLte0: 0,
    noRelevantStat: 0,
  };
  const skipReasons: Record<string, number> = {
    invalidOdds: 0,
    invalidLine: 0,
    probabilityInvalid: 0,
    edgeInvalid: 0,
    modelReturnedNull: 0,
    statsMissing: 0,
  };
  let edgeMismatchCount = 0;
  let lambdaInspectionLogCount = 0;
  const LAMBDA_INSPECTION_CAP = 25;
  let marketStatMappingLogCount = 0;
  const MARKET_STAT_MAPPING_CAP = 12;
  let lambdaAdjustmentAuditLogCount = 0;
  const LAMBDA_ADJUSTMENT_AUDIT_CAP = 10;
  let playerShotsRowsBuilt = 0;
  let playerShotsPositiveEdgeRows = 0;
  let playerShotsRowsWhereEffectiveMinutesChanged = 0;
  let playerShotsRowsWhereEffectiveMinutesUnchanged = 0;
  let shotsFloorValidationLogCount = 0;
  const SHOTS_FLOOR_VALIDATION_CAP = 20;

  type MarketDiagBucket = {
    rowCount: number;
    positiveEdgeCount: number;
    sumOdds: number;
    sumBookProb: number;
    sumModelProb: number;
    sumEdge: number;
    sumAdjustedLambda: number;
    countAdjustedLambda: number;
  };
  type MarketDiag = {
    rowCount: number;
    positiveEdgeCount: number;
    sumOdds: number;
    sumBookProb: number;
    sumModelProb: number;
    sumEdge: number;
    sumBaseLambda: number;
    sumAdjustedLambda: number;
    sumAdjustmentRatio: number;
    countBaseLambda: number;
    countAdjustmentRatio: number;
    buckets: Record<string, MarketDiagBucket>;
  };
  const marketDiagnostics: Record<
    "shots" | "shotsOnTarget" | "foulsCommitted" | "foulsWon" | "tackles",
    MarketDiag
  > = {
    shots: {
      rowCount: 0,
      positiveEdgeCount: 0,
      sumOdds: 0,
      sumBookProb: 0,
      sumModelProb: 0,
      sumEdge: 0,
      sumBaseLambda: 0,
      sumAdjustedLambda: 0,
      sumAdjustmentRatio: 0,
      countBaseLambda: 0,
      countAdjustmentRatio: 0,
      buckets: {},
    },
    shotsOnTarget: {
      rowCount: 0,
      positiveEdgeCount: 0,
      sumOdds: 0,
      sumBookProb: 0,
      sumModelProb: 0,
      sumEdge: 0,
      sumBaseLambda: 0,
      sumAdjustedLambda: 0,
      sumAdjustmentRatio: 0,
      countBaseLambda: 0,
      countAdjustmentRatio: 0,
      buckets: {},
    },
    foulsCommitted: {
      rowCount: 0,
      positiveEdgeCount: 0,
      sumOdds: 0,
      sumBookProb: 0,
      sumModelProb: 0,
      sumEdge: 0,
      sumBaseLambda: 0,
      sumAdjustedLambda: 0,
      sumAdjustmentRatio: 0,
      countBaseLambda: 0,
      countAdjustmentRatio: 0,
      buckets: {},
    },
    foulsWon: {
      rowCount: 0,
      positiveEdgeCount: 0,
      sumOdds: 0,
      sumBookProb: 0,
      sumModelProb: 0,
      sumEdge: 0,
      sumBaseLambda: 0,
      sumAdjustedLambda: 0,
      sumAdjustmentRatio: 0,
      countBaseLambda: 0,
      countAdjustmentRatio: 0,
      buckets: {},
    },
    tackles: {
      rowCount: 0,
      positiveEdgeCount: 0,
      sumOdds: 0,
      sumBookProb: 0,
      sumModelProb: 0,
      sumEdge: 0,
      sumBaseLambda: 0,
      sumAdjustedLambda: 0,
      sumAdjustmentRatio: 0,
      countBaseLambda: 0,
      countAdjustmentRatio: 0,
      buckets: {},
    },
  };
  let rawShotStatAuditLogCount = 0;
  const RAW_SHOT_STAT_AUDIT_CAP = 12;

  /** DEV-only: 0.5-line baseline audit (per-row sample cap and per-market summary). */
  const LOW_LINE_BASELINE_AUDIT_CAP = 16;
  let lowLineBaselineAuditLogCount = 0;
  const lowLineByMarket: {
    [key: string]: {
      rowCount: number;
      sumModelProbability: number;
      sumBookmakerProbability: number;
      sumEmpiricalAtLeastOneApprox: number;
      sumExpectedMinutes: number;
      sumAdjustedLambda: number;
    };
  } = {
    shots: { rowCount: 0, sumModelProbability: 0, sumBookmakerProbability: 0, sumEmpiricalAtLeastOneApprox: 0, sumExpectedMinutes: 0, sumAdjustedLambda: 0 },
    shotsOnTarget: { rowCount: 0, sumModelProbability: 0, sumBookmakerProbability: 0, sumEmpiricalAtLeastOneApprox: 0, sumExpectedMinutes: 0, sumAdjustedLambda: 0 },
    foulsCommitted: { rowCount: 0, sumModelProbability: 0, sumBookmakerProbability: 0, sumEmpiricalAtLeastOneApprox: 0, sumExpectedMinutes: 0, sumAdjustedLambda: 0 },
    foulsWon: { rowCount: 0, sumModelProbability: 0, sumBookmakerProbability: 0, sumEmpiricalAtLeastOneApprox: 0, sumExpectedMinutes: 0, sumAdjustedLambda: 0 },
    tackles: { rowCount: 0, sumModelProbability: 0, sumBookmakerProbability: 0, sumEmpiricalAtLeastOneApprox: 0, sumExpectedMinutes: 0, sumAdjustedLambda: 0 },
  };
  const lowLineBlendByMarket: {
    [key: string]: {
      rowCount: number;
      sumOriginalModelProbability: number;
      sumEmpiricalAtLeastOneApprox: number;
      sumBlendedProbability: number;
      sumBookmakerProbability: number;
      positiveEdgeCountAfterBlend: number;
    };
  } = {
    shots: { rowCount: 0, sumOriginalModelProbability: 0, sumEmpiricalAtLeastOneApprox: 0, sumBlendedProbability: 0, sumBookmakerProbability: 0, positiveEdgeCountAfterBlend: 0 },
    shotsOnTarget: { rowCount: 0, sumOriginalModelProbability: 0, sumEmpiricalAtLeastOneApprox: 0, sumBlendedProbability: 0, sumBookmakerProbability: 0, positiveEdgeCountAfterBlend: 0 },
    foulsCommitted: { rowCount: 0, sumOriginalModelProbability: 0, sumEmpiricalAtLeastOneApprox: 0, sumBlendedProbability: 0, sumBookmakerProbability: 0, positiveEdgeCountAfterBlend: 0 },
    foulsWon: { rowCount: 0, sumOriginalModelProbability: 0, sumEmpiricalAtLeastOneApprox: 0, sumBlendedProbability: 0, sumBookmakerProbability: 0, positiveEdgeCountAfterBlend: 0 },
    tackles: { rowCount: 0, sumOriginalModelProbability: 0, sumEmpiricalAtLeastOneApprox: 0, sumBlendedProbability: 0, sumBookmakerProbability: 0, positiveEdgeCountAfterBlend: 0 },
  };

  const markets = data.markets ?? [];
  for (const market of markets) {
    const marketId = marketIdFromMarket(market as { marketId?: number; market_id?: number; id?: number });
    const rawMarketId = (market as { marketId?: number }).marketId ?? (market as { market_id?: number }).market_id ?? (market as { id?: number }).id;
    /** Fouls + tackles: shared dev tracing and onFoulsReject skip breakdown. */
    const isPhysicalPropMarketForDev = rawMarketId === 338 || rawMarketId === 339 || rawMarketId === 340;

    if (import.meta.env.DEV && isPhysicalPropMarketForDev) foulMarketsSeen += 1;

    if (!SUPPORTED_VALUE_BET_MARKET_IDS.has(marketId)) {
      if (import.meta.env.DEV && isPhysicalPropMarketForDev) {
        foulRowsSkipped += 1;
        skipReasonsBreakdown.marketNotSupported += 1;
      }
      continue;
    }

    const players = market.players ?? [];
    const marketName = (market as { marketName?: string }).marketName ?? (market as { market_name?: string }).market_name ?? "Market";

    for (const player of players) {
      const playerIdFromProps = getPlayerId(player as Parameters<typeof getPlayerId>[0]);
      const playerName = (player as { playerName?: string }).playerName ?? (player as { player_name?: string }).player_name ?? "Unknown";
      const normalizedName = normalizePlayerName(playerName);

      const inLineupById = playerIdFromProps != null && startingPlayerIds.has(playerIdFromProps);
      const inLineupByName = startingPlayerNames.has(normalizedName);

      if (import.meta.env.DEV && isPhysicalPropMarketForDev) foulPlayersSeen += 1;

      if (!inLineupById && !inLineupByName) {
        if (import.meta.env.DEV && isPhysicalPropMarketForDev) {
          foulRowsSkipped += 1;
          skipReasonsBreakdown.playerNotInLineup += 1;
        }
        continue;
      }

      const lineupPlayerId = resolvePlayerIdForStats(playerIdFromProps, normalizedName, startingPlayerIds, nameToPlayerId);
      const stats = lineupPlayerId != null ? statsByPlayerId.get(lineupPlayerId) : undefined;
      if (stats && (stats.foulsCommitted != null || stats.foulsWon != null)) {
        foulStatsAvailable = true;
      }
      const matchedById = inLineupById && lineupPlayerId != null;
      let lineupInfoFinal: StarterLineupInfo | null = lineupPlayerId != null ? lineupByPlayerId.get(lineupPlayerId) ?? null : null;
      if (lineupInfoFinal == null) {
        const byName = lineupByNormalizedName.get(normalizedName);
        if (byName) lineupInfoFinal = { positionId: byName.positionId, teamId: byName.teamId, confirmedStarter: byName.confirmedStarter };
      }

      const selections = (player as { selections?: Array<{ line?: number; overOdds?: number | null; underOdds?: number | null; bookmakerName?: string }> }).selections ?? [];
      if (import.meta.env.DEV && isPhysicalPropMarketForDev && selections.length === 0) {
        foulRowsSkipped += 1;
        skipReasonsBreakdown.noSelections += 1;
      }
      for (const sel of selections) {
        const line = sel.line ?? 0;
        const overOddsRaw = (sel as { overOdds?: number | null }).overOdds ?? (sel as { over_odds?: number | null }).over_odds;
        const overOdds = typeof overOddsRaw === "number" ? overOddsRaw : Number(overOddsRaw);
        const bookmakerId = (sel as { bookmakerId?: number }).bookmakerId ?? (sel as { bookmaker_id?: number }).bookmaker_id ?? null;
        const bookmakerName = (sel as { bookmakerName?: string }).bookmakerName ?? (sel as { bookmaker_name?: string }).bookmaker_name ?? "Unknown bookmaker";

        const addRow = (outcome: "Over" | "Under", odds: number) => {
          const oddsNum = Number(odds);
          if (typeof oddsNum !== "number" || !Number.isFinite(oddsNum) || oddsNum <= 1.01) {
            skipReasons.invalidOdds += 1;
            if (import.meta.env.DEV && isPhysicalPropMarketForDev) {
              foulRowsSkipped += 1;
              skipReasonsBreakdown.invalidOdds += 1;
            }
            return;
          }
          const bookmakerProbability = 1 / oddsNum;
          if (!Number.isFinite(bookmakerProbability)) {
            skipReasons.invalidOdds += 1;
            if (import.meta.env.DEV && isPhysicalPropMarketForDev) {
              foulRowsSkipped += 1;
              skipReasonsBreakdown.invalidOdds += 1;
            }
            return;
          }
          const dedupeKey = `${playerName}|${marketId}|${line}|${outcome}|${bookmakerName}|${oddsNum}`;
          if (seen.has(dedupeKey)) {
            if (import.meta.env.DEV && isPhysicalPropMarketForDev) {
              foulRowsSkipped += 1;
              skipReasonsBreakdown.duplicate += 1;
            }
            return;
          }
          if (!Number.isFinite(line)) {
            skipReasons.invalidLine += 1;
            if (import.meta.env.DEV && isPhysicalPropMarketForDev) {
              foulRowsSkipped += 1;
              skipReasonsBreakdown.invalidLine += 1;
            }
            return;
          }
          seen.add(dedupeKey);

          if (stats) {
            const onFoulsReject = isPhysicalPropMarketForDev
              ? (reason: string) => {
                  foulRowsSkipped += 1;
                  skipReasonsBreakdown[reason] = (skipReasonsBreakdown[reason] ?? 0) + 1;
                }
              : undefined;
            const built = buildValueBetRowFields(
              stats,
              marketId,
              line,
              outcome,
              oddsNum,
              lineupInfoFinal,
              fixture,
              lineupConfirmed,
              matchedById,
              playerName,
              onFoulsReject
            );
            if (!built) {
              skipReasons.modelReturnedNull += 1;
              return;
            }
            const modelProb = built.calibratedProbability;
            const modelEdgeVal = built.modelEdge;
            const probValid = typeof modelProb === "number" && Number.isFinite(modelProb);
            const edgeValid = typeof modelEdgeVal === "number" && Number.isFinite(modelEdgeVal);
            if (!probValid) skipReasons.probabilityInvalid += 1;
            if (!edgeValid) skipReasons.edgeInvalid += 1;
            if (!probValid || !edgeValid) return;
            const dataConfidence = built.dataConfidence;
            const dataConfidenceScore = built.dataConfidenceScore;
            const betQualityScore = computeBetQualityScore({
              modelEdge: modelEdgeVal,
              calibratedProbability: modelProb,
              odds: oddsNum,
              line,
              marketId,
              dataConfidence,
            });
            const betQuality = betQualityBucket(betQualityScore);
            const modelEdge = modelEdgeVal;
            const bookmakerProb = built.bookmakerProbability;
            if (bookmakerProb < 0 || bookmakerProb > 1 || modelProb < 0 || modelProb > 1 || modelEdge < -1 || modelEdge > 1) {
              if (import.meta.env.DEV && isPhysicalPropMarketForDev) {
                foulRowsSkipped += 1;
                skipReasonsBreakdown.probabilityOrEdgeOutOfRange += 1;
              }
              return;
            }
            const edgeCheck = modelProb - bookmakerProb;
            if (import.meta.env.DEV && Math.abs(edgeCheck - modelEdge) > 0.0001) {
              edgeMismatchCount += 1;
            }
            if (
              import.meta.env.DEV &&
              lambdaInspectionLogCount < LAMBDA_INSPECTION_CAP &&
              (modelProb < 0.01 || modelEdge > 0)
            ) {
              const lambda = built.modelInputs?.adjustedLambda ?? built.modelInputs?.lambda ?? null;
              console.log("[value-bets] lambda inspection", {
                playerName,
                marketName,
                line,
                odds: oddsNum,
                lambda,
                rawProbability: built.rawModelProbability,
                calibratedProbability: modelProb,
              });
              lambdaInspectionLogCount += 1;
            }
            if (
              import.meta.env.DEV &&
              (marketId === MARKET_ID_PLAYER_SHOTS || marketId === MARKET_ID_PLAYER_SHOTS_ON_TARGET) &&
              marketStatMappingLogCount < MARKET_STAT_MAPPING_CAP
            ) {
              const mi = built.modelInputs;
              const statUsed = marketId === MARKET_ID_PLAYER_SHOTS ? "shots" : "shotsOnTarget";
              const statValue = marketId === MARKET_ID_PLAYER_SHOTS ? mi?.shots : mi?.shotsOnTarget;
              console.log("[value-bets] market stat mapping check", {
                playerName,
                marketId,
                marketName,
                statUsed,
                statValue,
                minutesPlayed: mi?.minutesPlayed,
                per90: mi?.per90,
                adjustedLambda: mi?.adjustedLambda,
              });
              marketStatMappingLogCount += 1;
            }
            if (
              import.meta.env.DEV &&
              (marketId === MARKET_ID_PLAYER_SHOTS || marketId === MARKET_ID_PLAYER_SHOTS_ON_TARGET) &&
              lambdaAdjustmentAuditLogCount < LAMBDA_ADJUSTMENT_AUDIT_CAP
            ) {
              const mi = built.modelInputs;
              const baseLambda = mi?.lambda ?? 0;
              const adjustedLambda = mi?.adjustedLambda ?? 0;
              const adjustmentRatio =
                typeof baseLambda === "number" && baseLambda > 0 ? adjustedLambda / baseLambda : null;
              console.log("[value-bets] lambda adjustment audit", {
                playerName,
                marketId,
                marketName,
                per90: mi?.per90,
                expectedMinutes: mi?.expectedMinutes,
                baseLambda,
                positionMultiplier: mi?.positionMultiplier,
                teamAttackFactor: mi?.teamAttackFactor,
                opponentDefenceFactor: mi?.opponentDefenceFactor,
                homeAwayFactor: mi?.homeAwayFactor,
                adjustedLambda,
                adjustmentRatio,
              });
              lambdaAdjustmentAuditLogCount += 1;
            }
            if (
              import.meta.env.DEV &&
              (marketId === MARKET_ID_PLAYER_SHOTS || marketId === MARKET_ID_PLAYER_SHOTS_ON_TARGET) &&
              rawShotStatAuditLogCount < RAW_SHOT_STAT_AUDIT_CAP
            ) {
              const mi = built.modelInputs;
              const statsShots = mi?.shots ?? 0;
              const statsShotsOnTarget = mi?.shotsOnTarget ?? 0;
              const statValueUsed =
                marketId === MARKET_ID_PLAYER_SHOTS ? statsShots : statsShotsOnTarget;
              console.log("[value-bets] raw shot stat audit", {
                playerName,
                marketId,
                marketName,
                statsShots,
                statsShotsOnTarget,
                minutesPlayed: mi?.minutesPlayed,
                statValueUsed,
                per90Used: mi?.per90,
              });
              rawShotStatAuditLogCount += 1;
            }
            const row: ValueBetRow = {
              playerName,
              marketName,
              line,
              outcome,
              odds: oddsNum,
              bookmakerId,
              bookmakerName,
              bookmakerProbability: built.bookmakerProbability,
              modelProbability: modelProb,
              rawModelProbability: built.rawModelProbability,
              calibratedProbability: modelProb,
              probabilityPct: built.probabilityPct,
              edgePct: built.edgePct,
              modelEdge,
              edge: modelEdge,
              dataConfidence,
              dataConfidenceScore,
              betQuality,
              betQualityScore,
              modelInputs: built.modelInputs,
              isStrongBet: false,
            };
            row.calibrationBucketValid = isBucketCalibrated(built.rawModelProbability);
            row.isStrongBet = isStrongBetCandidate(row);
            if (lineupPlayerId != null) row.sportmonksPlayerId = lineupPlayerId;
            if (lineupInfoFinal?.teamId != null) row.sportmonksTeamId = lineupInfoFinal.teamId;
            if (
              import.meta.env.DEV &&
              (row.sportmonksPlayerId == null || row.sportmonksTeamId == null)
            ) {
              console.log("[row ids]", {
                player: row.playerName,
                rowPlayerId: row.sportmonksPlayerId,
                rowTeamId: row.sportmonksTeamId,
                marketName: row.marketName,
                line: row.line,
                outcome: row.outcome,
              });
              const cat =
                row.marketName?.includes("Player Tackles") ||
                (row.marketName?.includes("Tackles") && !row.marketName?.includes("Foul"))
                  ? "tackles"
                  : row.marketName?.includes("Shots On Target")
                    ? "shotsOnTarget"
                    : row.marketName?.includes("Shots")
                      ? "shots"
                      : row.marketName?.includes("Fouls Committed")
                        ? "foulsCommitted"
                        : row.marketName?.includes("Fouls Won")
                          ? "foulsWon"
                          : null;
              if (cat && marketDiagnostics[cat]) {
                const d = marketDiagnostics[cat];
                d.rowCount += 1;
                if (modelEdge > 0) d.positiveEdgeCount += 1;
                d.sumOdds += oddsNum;
                d.sumBookProb += bookmakerProb;
                d.sumModelProb += modelProb;
                d.sumEdge += modelEdge;
                const mi = built.modelInputs;
                const baseLambda = mi?.lambda;
                const adjustedLambdaDiag = mi?.adjustedLambda;
                if (typeof baseLambda === "number" && baseLambda > 0) {
                  d.sumBaseLambda += baseLambda;
                  d.countBaseLambda += 1;
                  if (typeof adjustedLambdaDiag === "number") {
                    d.sumAdjustedLambda += adjustedLambdaDiag;
                    d.countAdjustmentRatio += 1;
                    d.sumAdjustmentRatio += adjustedLambdaDiag / baseLambda;
                  }
                }
                // Line-bucket diagnostics
                let bucket: string | null = null;
                if (line === 0.5) bucket = "0.5";
                else if (line === 1.5) bucket = "1.5";
                else if (line === 2.5) bucket = "2.5";
                else if (line >= 3.5) bucket = "3.5plus";
                if (bucket) {
                  const b =
                    d.buckets[bucket] ??
                    (d.buckets[bucket] = {
                      rowCount: 0,
                      positiveEdgeCount: 0,
                      sumOdds: 0,
                      sumBookProb: 0,
                      sumModelProb: 0,
                      sumEdge: 0,
                      sumAdjustedLambda: 0,
                      countAdjustedLambda: 0,
                    });
                  b.rowCount += 1;
                  if (modelEdge > 0) b.positiveEdgeCount += 1;
                  b.sumOdds += oddsNum;
                  b.sumBookProb += bookmakerProb;
                  b.sumModelProb += modelProb;
                  b.sumEdge += modelEdge;
                  const adjL = built.modelInputs?.adjustedLambda;
                  if (typeof adjL === "number") {
                    b.sumAdjustedLambda += adjL;
                    b.countAdjustedLambda += 1;
                  }
                }
              }
            }
            if (import.meta.env.DEV && line === 0.5) {
              const lowCat =
                row.marketName?.includes("Player Tackles") ||
                (row.marketName?.includes("Tackles") && !row.marketName?.includes("Foul"))
                  ? "tackles"
                  : row.marketName?.includes("Shots On Target")
                    ? "shotsOnTarget"
                    : row.marketName?.includes("Shots")
                      ? "shots"
                      : row.marketName?.includes("Fouls Committed")
                        ? "foulsCommitted"
                        : row.marketName?.includes("Fouls Won")
                          ? "foulsWon"
                          : null;
              if (lowCat && lowLineByMarket[lowCat]) {
                const minutesPlayedVal = stats.minutesPlayed ?? built.modelInputs?.minutesPlayed ?? 0;
                const statValue = getRelevantStatForMarket(stats, marketId, minutesPlayedVal);
                const appearances = stats.appearances ?? 0;
                const empiricalPerAppearance =
                  appearances > 0 && statValue != null ? statValue / appearances : 0;
                const empiricalAtLeastOneApprox =
                  built.empiricalAtLeastOneApprox ?? Math.min(empiricalPerAppearance, 1);
                const originalModelProbability = built.originalCalibratedProbability;
                const blendedProbability = modelProb;
                const low = lowLineByMarket[lowCat];
                low.rowCount += 1;
                // Keep baseline logs comparing against the original (pre-blend) model probability.
                low.sumModelProbability += originalModelProbability;
                low.sumBookmakerProbability += bookmakerProb;
                low.sumEmpiricalAtLeastOneApprox += empiricalAtLeastOneApprox;
                low.sumExpectedMinutes += built.modelInputs?.expectedMinutes ?? 0;
                low.sumAdjustedLambda += built.modelInputs?.adjustedLambda ?? 0;
                const blend = lowLineBlendByMarket[lowCat];
                blend.rowCount += 1;
                blend.sumOriginalModelProbability += originalModelProbability;
                blend.sumEmpiricalAtLeastOneApprox += empiricalAtLeastOneApprox;
                blend.sumBlendedProbability += blendedProbability;
                blend.sumBookmakerProbability += bookmakerProb;
                if (modelEdge > 0) blend.positiveEdgeCountAfterBlend += 1;
                if (lowLineBaselineAuditLogCount < LOW_LINE_BASELINE_AUDIT_CAP) {
                  console.log("[value-bets] low-line baseline audit", {
                    playerName,
                    marketName,
                    statValue: statValue ?? 0,
                    minutesPlayed: minutesPlayedVal,
                    appearances,
                    expectedMinutes: built.modelInputs?.expectedMinutes,
                    per90Used: built.modelInputs?.per90,
                    baseLambda: built.modelInputs?.lambda,
                    adjustedLambda: built.modelInputs?.adjustedLambda,
                    modelProbability: originalModelProbability,
                    bookmakerProbability: bookmakerProb,
                    empiricalAtLeastOneApprox,
                  });
                  lowLineBaselineAuditLogCount += 1;
                }
              }
            }
            if (marketId === MARKET_ID_PLAYER_SHOTS) {
              const mi = built.modelInputs;
              const minutesPlayedForShots = mi?.minutesPlayed ?? 0;
              const expectedMinutesForShots = mi?.expectedMinutes ?? 0;
              const effectiveMinutesForShots =
                Math.max(minutesPlayedForShots, expectedMinutesForShots * 8);
              const rawPer90 =
                minutesPlayedForShots > 0 && typeof mi?.shots === "number"
                  ? (mi.shots / minutesPlayedForShots) * 90
                  : 0;
              const per90Used = mi?.per90 ?? rawPer90;
              const effectiveChanged =
                minutesPlayedForShots > 0 &&
                expectedMinutesForShots > 0 &&
                effectiveMinutesForShots !== minutesPlayedForShots;

              playerShotsRowsBuilt += 1;
              if (modelEdge > 0) playerShotsPositiveEdgeRows += 1;
              if (effectiveChanged) {
                playerShotsRowsWhereEffectiveMinutesChanged += 1;
              } else {
                playerShotsRowsWhereEffectiveMinutesUnchanged += 1;
              }

              if (
                import.meta.env.DEV &&
                shotsFloorValidationLogCount < SHOTS_FLOOR_VALIDATION_CAP &&
                (modelEdge > 0 || shotsFloorValidationLogCount < 15)
              ) {
                console.log("[value-bets] shots floor validation", {
                  playerName,
                  marketName,
                  line,
                  odds: oddsNum,
                  minutesPlayed: minutesPlayedForShots,
                  effectiveMinutesForShots,
                  rawPer90,
                  per90Used,
                  expectedMinutes: expectedMinutesForShots,
                  baseLambda: mi?.lambda,
                  adjustedLambda: mi?.adjustedLambda,
                  rawProbability: built.rawModelProbability,
                  calibratedProbability: modelProb,
                  modelEdge,
                });
                shotsFloorValidationLogCount += 1;
              }
            }
            rows.push(row);
            if (import.meta.env.DEV && isPhysicalPropMarketForDev) {
              foulRowsCreated += 1;
            }
          } else {
            if (!Number.isFinite(line)) {
              skipReasons.invalidLine += 1;
              if (import.meta.env.DEV && isPhysicalPropMarketForDev) {
                foulRowsSkipped += 1;
                skipReasonsBreakdown.noStatsAndInvalidOdds += 1;
              }
              return;
            }
            skipReasons.statsMissing += 1;
            if (import.meta.env.DEV && isPhysicalPropMarketForDev) {
              foulRowsSkipped += 1;
              skipReasonsBreakdown.statsMissing += 1;
            }
          }
        };

        if (Number.isFinite(overOdds)) addRow("Over", overOdds);
        const underOddsRaw = (sel as { underOdds?: number | null }).underOdds ?? (sel as { under_odds?: number | null }).under_odds;
        const underOdds = typeof underOddsRaw === "number" ? underOddsRaw : Number(underOddsRaw);
        if (Number.isFinite(underOdds)) addRow("Under", underOdds);
      }
    }
  }

  if (import.meta.env.DEV) {
    const byMarket = { shots: 0, shotsOnTarget: 0, foulsCommitted: 0, foulsWon: 0, tackles: 0 };
    for (const row of rows) {
      const name = row.marketName ?? "";
      if (name.includes("Fouls Won")) byMarket.foulsWon += 1;
      else if (name.includes("Fouls Committed")) byMarket.foulsCommitted += 1;
      else if (name.includes("Player Tackles") || (name.includes("Tackles") && !name.includes("Foul")))
        byMarket.tackles += 1;
      else if (name.includes("Shots On Target")) byMarket.shotsOnTarget += 1;
      else if (name.includes("Shots")) byMarket.shots += 1;
    }
    console.log("[value-bets] row counts by market", byMarket);
    const totalRowsSkipped = Object.values(skipReasons).reduce((a, b) => a + b, 0);
    console.log("[value-bets] skipped rows summary", {
      skipReasons,
      totalRowsBuilt: rows.length,
      totalRowsSkipped,
      edgeMismatchCount,
    });
    if (playerShotsRowsBuilt > 0) {
      console.log("[value-bets] shots effective-minutes summary", {
        playerShotsRowsBuilt,
        playerShotsPositiveEdgeRows,
        playerShotsRowsWhereEffectiveMinutesChanged,
        playerShotsRowsWhereEffectiveMinutesUnchanged,
      });
    }
    const diagSummary = (key: keyof typeof marketDiagnostics) => {
      const d = marketDiagnostics[key];
      if (!d.rowCount) return null;
      const avg = (sum: number, count: number) => (count > 0 ? sum / count : 0);
      return {
        rowCount: d.rowCount,
        positiveEdgeCount: d.positiveEdgeCount,
        averageOdds: avg(d.sumOdds, d.rowCount),
        averageBookmakerProbability: avg(d.sumBookProb, d.rowCount),
        averageModelProbability: avg(d.sumModelProb, d.rowCount),
        averageEdge: avg(d.sumEdge, d.rowCount),
        averageBaseLambda: avg(d.sumBaseLambda, d.countBaseLambda),
        averageAdjustedLambda: avg(d.sumAdjustedLambda, d.countBaseLambda),
        averageAdjustmentRatio: avg(d.sumAdjustmentRatio, d.countAdjustmentRatio),
        buckets: (() => {
          const out: Record<string, unknown> = {};
          const avgBucket = (sum: number, count: number) => (count > 0 ? sum / count : 0);
          for (const [bucketKey, b] of Object.entries(d.buckets)) {
            if (!b.rowCount) continue;
            out[bucketKey] = {
              rowCount: b.rowCount,
              positiveEdgeCount: b.positiveEdgeCount,
              averageOdds: avgBucket(b.sumOdds, b.rowCount),
              averageBookmakerProbability: avgBucket(b.sumBookProb, b.rowCount),
              averageModelProbability: avgBucket(b.sumModelProb, b.rowCount),
              averageEdge: avgBucket(b.sumEdge, b.rowCount),
              averageAdjustedLambda: avgBucket(b.sumAdjustedLambda, b.countAdjustedLambda),
            };
          }
          return out;
        })(),
      };
    };
    console.log("[value-bets] market diagnostics summary", {
      shots: diagSummary("shots"),
      shotsOnTarget: diagSummary("shotsOnTarget"),
      foulsCommitted: diagSummary("foulsCommitted"),
      foulsWon: diagSummary("foulsWon"),
      tackles: diagSummary("tackles"),
    });
    const bucketDiagSummary = (key: keyof typeof marketDiagnostics) => {
      const d = marketDiagnostics[key];
      const avg = (sum: number, count: number) => (count > 0 ? sum / count : 0);
      const out: Record<
        string,
        {
          rowCount: number;
          positiveEdgeCount: number;
          averageOdds: number;
          averageBookmakerProbability: number;
          averageModelProbability: number;
          averageEdge: number;
          averageAdjustedLambda: number;
        }
      > = {};
      for (const [bucketKey, b] of Object.entries(d.buckets)) {
        if (!b.rowCount) continue;
        out[bucketKey] = {
          rowCount: b.rowCount,
          positiveEdgeCount: b.positiveEdgeCount,
          averageOdds: avg(b.sumOdds, b.rowCount),
          averageBookmakerProbability: avg(b.sumBookProb, b.rowCount),
          averageModelProbability: avg(b.sumModelProb, b.rowCount),
          averageEdge: avg(b.sumEdge, b.rowCount),
          averageAdjustedLambda: avg(b.sumAdjustedLambda, b.countAdjustedLambda),
        };
      }
      return out;
    };
    console.log("[value-bets] market line-bucket diagnostics", {
      shots: bucketDiagSummary("shots"),
      shotsOnTarget: bucketDiagSummary("shotsOnTarget"),
      foulsCommitted: bucketDiagSummary("foulsCommitted"),
      foulsWon: bucketDiagSummary("foulsWon"),
      tackles: bucketDiagSummary("tackles"),
    });
    const lowLineSummary = (key: keyof typeof lowLineByMarket) => {
      const s = lowLineByMarket[key];
      if (!s.rowCount) return null;
      const avg = (sum: number, count: number) => (count > 0 ? sum / count : 0);
      return {
        rowCount: s.rowCount,
        averageModelProbability: avg(s.sumModelProbability, s.rowCount),
        averageBookmakerProbability: avg(s.sumBookmakerProbability, s.rowCount),
        averageEmpiricalAtLeastOneApprox: avg(s.sumEmpiricalAtLeastOneApprox, s.rowCount),
        averageExpectedMinutes: avg(s.sumExpectedMinutes, s.rowCount),
        averageAdjustedLambda: avg(s.sumAdjustedLambda, s.rowCount),
      };
    };
    console.log("[value-bets] low-line baseline summary", {
      shots: lowLineSummary("shots"),
      shotsOnTarget: lowLineSummary("shotsOnTarget"),
      foulsCommitted: lowLineSummary("foulsCommitted"),
      foulsWon: lowLineSummary("foulsWon"),
      tackles: lowLineSummary("tackles"),
    });
    const lowLineBlendSummary = (key: keyof typeof lowLineBlendByMarket) => {
      const s = lowLineBlendByMarket[key];
      if (!s.rowCount) return null;
      const avg = (sum: number, count: number) => (count > 0 ? sum / count : 0);
      return {
        rowCount: s.rowCount,
        averageOriginalModelProbability: avg(s.sumOriginalModelProbability, s.rowCount),
        averageEmpiricalAtLeastOneApprox: avg(s.sumEmpiricalAtLeastOneApprox, s.rowCount),
        averageBlendedProbability: avg(s.sumBlendedProbability, s.rowCount),
        averageBookmakerProbability: avg(s.sumBookmakerProbability, s.rowCount),
        positiveEdgeCountAfterBlend: s.positiveEdgeCountAfterBlend,
      };
    };
    console.log("[value-bets] low-line blend summary", {
      shots: lowLineBlendSummary("shots"),
      shotsOnTarget: lowLineBlendSummary("shotsOnTarget"),
      foulsCommitted: lowLineBlendSummary("foulsCommitted"),
      foulsWon: lowLineBlendSummary("foulsWon"),
      tackles: lowLineBlendSummary("tackles"),
    });
    console.log("[builder-debug] buildValueBetRows fouls summary", {
      foulMarketsSeen,
      foulPlayersSeen,
      foulRowsCreated,
      foulRowsSkipped,
      foulStatsAvailable,
      foulSkipReasonsBreakdown: skipReasonsBreakdown,
    });
  }
  return { rows, foulStatsAvailable, foulMarketsSeen };
}

export function LineupModal({
  open,
  onClose,
  fixture,
  loading,
  error,
  lineup,
  formations,
  coaches,
}: LineupModalProps) {
  useAutoResolveCombos(fixture?.id ?? null, open && fixture != null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);
  const [selectedTeamName, setSelectedTeamName] = useState<string | null>(null);
  const [loadingValueBets, setLoadingValueBets] = useState(false);
  const [valueBetRows, setValueBetRows] = useState<ValueBetRow[] | null>(null);
  const [valueBetStartingCount, setValueBetStartingCount] = useState<number | null>(null);
  const [foulsMarketsStatus, setFoulsMarketsStatus] = useState<{
    foulStatsAvailable: boolean;
    foulMarketsSeen: number;
  } | null>(null);
  const [sortConfig, setSortConfig] = useState<{ key: ValueSortKey; direction: "asc" | "desc" }>({
    key: "edge",
    direction: "desc",
  });
  const [hideNegativeEdge, setHideNegativeEdge] = useState(false);
  const [selectedBookmaker, setSelectedBookmaker] = useState<string>("all");
  const [buildModalOpen, setBuildModalOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setSelectedPlayerId(null);
      setSelectedTeamName(null);
      setLoadingValueBets(false);
      setValueBetRows(null);
      setValueBetStartingCount(null);
      setFoulsMarketsStatus(null);
      setSelectedBookmaker("all");
      setBuildModalOpen(false);
    }
  }, [open]);

  const handleSortConfigChange = (key: ValueSortKey) => {
    setSortConfig((prev) => {
      if (prev.key !== key) return { key, direction: "desc" };
      if (prev.direction === "desc") return { key, direction: "asc" };
      return { key: "edge", direction: "desc" };
    });
  };

  const handlePlayerClick = (playerId: number, teamName?: string) => {
    setSelectedPlayerId(playerId);
    setSelectedTeamName(teamName ?? null);
  };

  const getValueBetRowsForFixture = useCallback(async (): Promise<{
    rows: ValueBetRow[];
    foulStatsAvailable: boolean;
    foulMarketsSeen: number;
  }> => {
    if (fixture == null || lineup == null) return { rows: [], foulStatsAvailable: false, foulMarketsSeen: 0 };
    const entries = lineup.data as RawLineupEntry[];
    if (!Array.isArray(entries) || entries.length === 0) return { rows: [], foulStatsAvailable: false, foulMarketsSeen: 0 };
    const [data, leagueSeason] = await Promise.all([
      loadPlayerPropsForFixture(fixture.id),
      fixture.league?.name ? fetchLeagueCurrentSeason(fixture.league.name).catch(() => null) : Promise.resolve(null),
    ]);
    if (import.meta.env.DEV) {
      const allMarketsList = data.markets ?? [];
      const getMid = (m: { marketId?: number; market_id?: number; id?: number }) => (m as { marketId?: number }).marketId ?? (m as { market_id?: number }).market_id ?? (m as { id?: number }).id;
      const m334 = allMarketsList.find((m) => getMid(m as { marketId?: number; market_id?: number; id?: number }) === 334);
      const m336 = allMarketsList.find((m) => getMid(m as { marketId?: number; market_id?: number; id?: number }) === 336);
      const m338 = allMarketsList.find((m) => getMid(m as { marketId?: number; market_id?: number; id?: number }) === 338);
      const m339 = allMarketsList.find((m) => getMid(m as { marketId?: number; market_id?: number; id?: number }) === 339);
      const m340 = allMarketsList.find((m) => getMid(m as { marketId?: number; market_id?: number; id?: number }) === 340);
      const players = (mar: { players?: unknown[] } | undefined) => mar?.players?.length ?? 0;
      const selections = (mar: { players?: Array<{ selections?: unknown[] }> } | undefined) =>
        mar?.players?.reduce((sum, p) => sum + (p.selections?.length ?? 0), 0) ?? 0;
      console.log("[player-props frontend] supported market summary", {
        market334Players: players(m334),
        market336Players: players(m336),
        market338Players: players(m338),
        market339Players: players(m339),
        market340Players: players(m340),
        market334Selections: selections(m334),
        market336Selections: selections(m336),
        market338Selections: selections(m338),
        market339Selections: selections(m339),
        market340Selections: selections(m340),
      });
    }
    const startingPlayerIds = getStartingPlayerIds(entries);
    const startingPlayerNames = getStartingPlayerNames(entries);
    const nameToPlayerId = getNameToPlayerIdMap(entries);
    const statsByPlayerId = new Map<number, PlayerSeasonStats>();
    const seasonId = leagueSeason?.currentSeasonId;
    if (seasonId != null && seasonId > 0) {
      await Promise.all(
        Array.from(startingPlayerIds).map(async (playerId) => {
          try {
            const stats = await loadPlayerSeasonStats(playerId, seasonId);
            if (stats) statsByPlayerId.set(playerId, stats);
          } catch {
            // ignore
          }
        })
      );
    }
    const result = buildValueBetRows(
      data,
      entries,
      fixture,
      lineup?.lineupConfirmed === true,
      startingPlayerIds,
      startingPlayerNames,
      statsByPlayerId,
      nameToPlayerId
    );
    if (import.meta.env.DEV) {
      const candidateSelections = (data.markets ?? []).reduce(
        (sum, m) => sum + ((m as { players?: Array<{ selections?: unknown[] }> }).players ?? []).reduce((s, p) => s + (p.selections?.length ?? 0), 0),
        0
      );
      console.log("[player-props frontend] value bet row counts", {
        candidateSelections,
        finalValueBetRows: result.rows.length,
      });
    }
    return { rows: result.rows, foulStatsAvailable: result.foulStatsAvailable, foulMarketsSeen: result.foulMarketsSeen };
  }, [fixture, lineup]);

  const handleFindValueBets = async () => {
    if (fixture == null || lineup == null) return;
    const entries = lineup.data as RawLineupEntry[];
    if (!Array.isArray(entries) || entries.length === 0) return;
    setLoadingValueBets(true);
    setValueBetRows(null);
    setValueBetStartingCount(null);
    try {
      const { rows, foulStatsAvailable, foulMarketsSeen } = await getValueBetRowsForFixture();
      const startingPlayerIds = getStartingPlayerIds(entries);
      setValueBetRows(rows);
      setValueBetStartingCount(startingPlayerIds.size);
      setFoulsMarketsStatus({ foulStatsAvailable, foulMarketsSeen });
      if (rows.length > 0) {
        if (import.meta.env.DEV) {
          console.log("[snapshot frontend] before POST /api/backtest-snapshots", {
            fixtureId: fixture.id,
            rowCount: rows.length,
            firstRowPreview: rows[0] ? { playerName: rows[0].playerName, marketName: rows[0].marketName, line: rows[0].line } : null,
          });
        }
        try {
          await appendBacktestSnapshots(fixture.id, fixture.startingAt, rows);
        } catch (snapshotErr) {
          if (import.meta.env.DEV) console.error("[snapshot frontend] POST backtest-snapshots failed", snapshotErr);
        }
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error("Failed to load player props", err);
      setValueBetRows([]);
      setValueBetStartingCount(null);
      setFoulsMarketsStatus(null);
    } finally {
      setLoadingValueBets(false);
    }
  };

  if (!open) return null;

  const kickoff = fixture ? formatKickoff(fixture.startingAt) : "";
  /**
   * Badge: "Released" only when metadata lineup_confirmed is true.
   * Otherwise when lineup array exists show "Lineups available" or "Unconfirmed lineup data".
   */
  const lineupStatusBadge =
    lineup == null
      ? null
      : lineup.lineupConfirmed === true
        ? "Released"
        : lineup.lineupConfirmed === false
          ? "Unconfirmed lineup data"
          : "Lineups available";

  return (
    <>
      <div
        className="lineup-modal__overlay"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lineup-modal-title"
      >
        <div className="lineup-modal" onClick={(e) => e.stopPropagation()}>
          <LineupModalHeader
            fixture={fixture}
            kickoff={kickoff}
            lineupStatusBadge={lineupStatusBadge}
            onClose={onClose}
          />
          <div className="lineup-modal__body">
            <LineupContent
              fixture={fixture}
              loading={loading}
              error={error}
              lineup={lineup}
              formations={formations}
              coaches={coaches}
              onPlayerClick={handlePlayerClick}
              onFindValueBets={handleFindValueBets}
              onBuildValueBets={fixture != null && lineup != null ? () => setBuildModalOpen(true) : undefined}
              loadingValueBets={loadingValueBets}
              valueBetRows={valueBetRows}
              valueBetStartingCount={valueBetStartingCount}
              foulsMarketsStatus={foulsMarketsStatus}
              sortConfig={sortConfig}
              onSortConfigChange={handleSortConfigChange}
              hideNegativeEdge={hideNegativeEdge}
              onHideNegativeEdgeChange={setHideNegativeEdge}
              selectedBookmaker={selectedBookmaker}
              onSelectedBookmakerChange={setSelectedBookmaker}
            />
          </div>
        </div>
      </div>
      <PlayerProfileModal
        open={selectedPlayerId != null}
        playerId={selectedPlayerId}
        onClose={() => {
          setSelectedPlayerId(null);
          setSelectedTeamName(null);
        }}
        leagueName={fixture?.league.name}
        teamName={selectedTeamName}
      />
      <BuildValueBetsModal
        open={buildModalOpen}
        onClose={() => setBuildModalOpen(false)}
        fixture={fixture}
        getCandidates={async () => {
          const { rows } = await getValueBetRowsForFixture();
          return rows;
        }}
        lineupContext={buildLineupContextForBuild(lineup, fixture)}
      />
    </>
  );
}
