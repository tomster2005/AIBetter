import { useState, useEffect, useMemo } from "react";
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
import {
  loadPlayerPropsForFixture,
  type PlayerOddsResponse as ServicePlayerOddsResponse,
} from "../services/playerPropsService.js";
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
  shouldRejectByHardFilter,
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

  return (
    <div className="lineup-content lineup-content--spaced">
      <div className="lineup-content__find-value-section">
        <h3 className="lineup-content__starting-title">Starting Lineups</h3>
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

/** Normalize player name for matching (same as backend: trim, lower, single spaces). */
function normalizePlayerName(name: string): string {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
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
  modelEdge: number;
  bookmakerProbability: number;
  modelInputs: ValueBetModelInputs;
  dataConfidence: ConfidenceLevel;
  dataConfidenceScore: number;
} | null {
  const appearances = stats.appearances ?? 0;
  const minutesPlayed = stats.minutesPlayed ?? 0;
  const expectedMinutes = computeExpectedMinutes(minutesPlayed, appearances);

  if (import.meta.env.DEV && (marketId === MARKET_ID_PLAYER_FOULS_COMMITTED || marketId === MARKET_ID_PLAYER_FOULS_WON)) {
    const rejected = shouldRejectByHardFilter(appearances, minutesPlayed, expectedMinutes);
    console.log("[value-bets] fouls hard filter check", {
      playerName,
      marketId,
      appearances,
      minutesPlayed,
      expectedMinutes,
      rejected,
    });
  }

  if (shouldRejectByHardFilter(appearances, minutesPlayed, expectedMinutes)) {
    if (import.meta.env.DEV && (marketId === MARKET_ID_PLAYER_FOULS_COMMITTED || marketId === MARKET_ID_PLAYER_FOULS_WON)) {
      const bookmakerProb = sanitizedBookmakerProbability(odds);
      const relevantStat = getRelevantStatForMarket(stats, marketId, minutesPlayed);
      console.log("[value-bets] fouls model precheck", {
        playerName,
        marketId,
        line,
        odds,
        relevantStat,
        appearances,
        minutesPlayed,
        expectedMinutes,
        bookmakerProb,
        reasonIfRejecting: "hard filter rejection",
      });
      onFoulsReject?.("hardFilter");
    }
    return null;
  }
  if (!isOddsSane(odds) || !Number.isFinite(line)) {
    if (import.meta.env.DEV && (marketId === MARKET_ID_PLAYER_FOULS_COMMITTED || marketId === MARKET_ID_PLAYER_FOULS_WON)) {
      const bookmakerProb = sanitizedBookmakerProbability(odds);
      const relevantStat = getRelevantStatForMarket(stats, marketId, minutesPlayed);
      console.log("[value-bets] fouls model precheck", {
        playerName,
        marketId,
        line,
        odds,
        relevantStat,
        appearances,
        minutesPlayed,
        expectedMinutes,
        bookmakerProb,
        reasonIfRejecting: "invalid odds or line",
      });
      onFoulsReject?.("invalidOddsOrLine");
    }
    return null;
  }

  const bookmakerProb = sanitizedBookmakerProbability(odds);
  if (bookmakerProb <= 0) {
    if (import.meta.env.DEV && (marketId === MARKET_ID_PLAYER_FOULS_COMMITTED || marketId === MARKET_ID_PLAYER_FOULS_WON)) {
      const relevantStat = getRelevantStatForMarket(stats, marketId, minutesPlayed);
      console.log("[value-bets] fouls model precheck", {
        playerName,
        marketId,
        line,
        odds,
        relevantStat,
        appearances,
        minutesPlayed,
        expectedMinutes,
        bookmakerProb,
        reasonIfRejecting: "bookmakerProb <= 0",
      });
      onFoulsReject?.("bookmakerProbLte0");
    }
    return null;
  }

  const statValue = getRelevantStatForMarket(stats, marketId, minutesPlayed);
  if (statValue == null) {
    if (import.meta.env.DEV && (marketId === MARKET_ID_PLAYER_FOULS_COMMITTED || marketId === MARKET_ID_PLAYER_FOULS_WON)) {
      console.log("[value-bets] fouls model precheck", {
        playerName,
        marketId,
        line,
        odds,
        relevantStat: null,
        appearances,
        minutesPlayed,
        expectedMinutes,
        bookmakerProb,
        reasonIfRejecting: "no relevant stat",
      });
      onFoulsReject?.("noRelevantStat");
    }
    return null;
  }
  const per90 = calculatePer90(statValue, minutesPlayed);
  const lambda = lambdaFromPer90AndMinutes(per90, expectedMinutes);
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
  const calibratedProbability = calibrateProbability(rawModelProbability, {
    marketId,
    positionId: lineupInfo?.positionId,
    dataConfidence,
  });
  const modelEdge = calculateEdge(calibratedProbability, bookmakerProb);

  const modelInputs: ValueBetModelInputs = {
    shots: stats.shots,
    shotsOnTarget: stats.shotsOnTarget,
    foulsCommitted: stats.foulsCommitted ?? 0,
    foulsWon: stats.foulsWon ?? 0,
    minutesPlayed,
    appearances,
    expectedMinutes,
    per90,
    lambda,
    positionMultiplier,
    adjustedLambda,
    impliedProbability: bookmakerProb,
    rawModelProbability,
    teamAttackFactor,
    opponentDefenceFactor,
    homeAwayFactor: homeAway,
  };

  if (import.meta.env.DEV && (marketId === MARKET_ID_PLAYER_FOULS_COMMITTED || marketId === MARKET_ID_PLAYER_FOULS_WON)) {
    console.log("[value-bets] fouls market row", {
      player: playerName,
      marketId,
      line,
      outcome,
      odds,
      probability: (rawModelProbability * 100).toFixed(1) + "%",
      edge: (modelEdge * 100).toFixed(1) + "%",
    });
  }

  const probabilityPct = (calibratedProbability * 100).toFixed(1) + "%";
  const pct = (modelEdge * 100).toFixed(1);
  const sign = modelEdge >= 0 ? "+" : "";
  return {
    probabilityPct,
    edgePct: `${sign}${pct}%`,
    rawModelProbability,
    calibratedProbability,
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
  const marketIdNum = (m: { marketId?: number }) => (typeof m.marketId === "number" ? m.marketId : 0);
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

  const markets = data.markets ?? [];
  for (const market of markets) {
    const marketId = marketIdNum(market);
    const rawMarketId = (market as { marketId?: number }).marketId ?? (market as { market_id?: number }).market_id ?? (market as { id?: number }).id;
    const isFoulsMarket = rawMarketId === 338 || rawMarketId === 339;

    if (import.meta.env.DEV && isFoulsMarket) {
      foulMarketsSeen += 1;
      console.log("[value-bets] processing fouls market", {
        marketId,
        rawMarketId,
        marketName: (market as { marketName?: string }).marketName ?? (market as { market_name?: string }).market_name,
        playerCount: (market as { players?: unknown[] }).players?.length ?? 0,
      });
    }

    if (!SUPPORTED_VALUE_BET_MARKET_IDS.has(marketId)) {
      if (import.meta.env.DEV && isFoulsMarket) {
        foulRowsSkipped += 1;
        skipReasonsBreakdown.marketNotSupported += 1;
        console.log("[value-bets] skipped fouls row", {
          marketId,
          marketName: (market as { marketName?: string }).marketName ?? (market as { market_name?: string }).market_name,
          playerName: "N/A",
          line: "N/A",
          outcome: "N/A",
          odds: "N/A",
          bookmakerName: "N/A",
          inLineupById: "N/A",
          inLineupByName: "N/A",
          resolvedLineupPlayerId: "N/A",
          hasStats: "N/A",
          appearances: "N/A",
          minutesPlayed: "N/A",
          expectedMinutes: "N/A",
          reason: "market not supported (marketId resolved to " + marketId + ")",
        });
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

      if (import.meta.env.DEV && isFoulsMarket) {
        foulPlayersSeen += 1;
        console.log("[value-bets] fouls market player", {
          marketId,
          playerId: playerIdFromProps,
          playerName,
          inLineupById,
          inLineupByName,
        });
      }

      if (!inLineupById && !inLineupByName) {
        if (import.meta.env.DEV && isFoulsMarket) {
          foulRowsSkipped += 1;
          skipReasonsBreakdown.playerNotInLineup += 1;
          console.log("[value-bets] skipped fouls row", {
            marketId,
            marketName,
            playerName,
            line: "N/A",
            outcome: "N/A",
            odds: "N/A",
            bookmakerName: "N/A",
            inLineupById,
            inLineupByName,
            resolvedLineupPlayerId: null,
            hasStats: false,
            appearances: undefined,
            minutesPlayed: undefined,
            expectedMinutes: undefined,
            reason: "player not in lineup",
          });
          if (!inLineupByName) {
            console.log("[value-bets] fouls lineup name mismatch", {
              marketPlayerName: playerName,
              normalizedMarketPlayerName: normalizedName,
              startingNamesSample: Array.from(startingPlayerNames).slice(0, 10),
            });
          }
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
      if (import.meta.env.DEV && isFoulsMarket && selections.length === 0) {
        foulRowsSkipped += 1;
        skipReasonsBreakdown.noSelections += 1;
        const appearances = stats?.appearances;
        const minutesPlayed = stats?.minutesPlayed ?? 0;
        const expectedMinutes = stats ? computeExpectedMinutes(minutesPlayed, stats.appearances ?? 0) : undefined;
        console.log("[value-bets] skipped fouls row", {
          marketId,
          marketName,
          playerName,
          line: "N/A",
          outcome: "N/A",
          odds: "N/A",
          bookmakerName: "N/A",
          inLineupById,
          inLineupByName,
          resolvedLineupPlayerId: lineupPlayerId ?? undefined,
          hasStats: !!stats,
          appearances,
          minutesPlayed,
          expectedMinutes,
          reason: "no selections",
        });
      }
      for (const sel of selections) {
        const line = sel.line ?? 0;
        const overOdds = (sel as { overOdds?: number | null }).overOdds ?? (sel as { over_odds?: number | null }).over_odds;
        const bookmakerId = (sel as { bookmakerId?: number }).bookmakerId ?? (sel as { bookmaker_id?: number }).bookmaker_id ?? null;
        const bookmakerName = (sel as { bookmakerName?: string }).bookmakerName ?? (sel as { bookmaker_name?: string }).bookmaker_name ?? "Unknown bookmaker";

        const addRow = (outcome: "Over" | "Under", odds: number) => {
          if (outcome !== "Over") return;
          const dedupeKey = `${playerName}|${marketId}|${line}|${outcome}|${bookmakerName}|${odds}`;
          if (seen.has(dedupeKey)) {
            if (import.meta.env.DEV && isFoulsMarket) {
              foulRowsSkipped += 1;
              skipReasonsBreakdown.duplicate += 1;
              const appearances = stats?.appearances;
              const minutesPlayed = stats?.minutesPlayed ?? 0;
              const expectedMinutes = stats ? computeExpectedMinutes(minutesPlayed, stats.appearances ?? 0) : undefined;
              console.log("[value-bets] skipped fouls row", {
                marketId,
                marketName,
                playerName,
                line,
                outcome,
                odds,
                bookmakerName,
                inLineupById,
                inLineupByName,
                resolvedLineupPlayerId: lineupPlayerId ?? undefined,
                hasStats: !!stats,
                appearances,
                minutesPlayed,
                expectedMinutes,
                reason: "duplicate selection",
              });
            }
            return;
          }
          if (odds <= 1.01 || !Number.isFinite(odds)) {
            if (import.meta.env.DEV && isFoulsMarket) {
              foulRowsSkipped += 1;
              skipReasonsBreakdown.invalidOdds += 1;
              const appearances = stats?.appearances;
              const minutesPlayed = stats?.minutesPlayed ?? 0;
              const expectedMinutes = stats ? computeExpectedMinutes(minutesPlayed, stats.appearances ?? 0) : undefined;
              console.log("[value-bets] skipped fouls row", {
                marketId,
                marketName,
                playerName,
                line,
                outcome,
                odds,
                bookmakerName,
                inLineupById,
                inLineupByName,
                resolvedLineupPlayerId: lineupPlayerId ?? undefined,
                hasStats: !!stats,
                appearances,
                minutesPlayed,
                expectedMinutes,
                reason: "odds invalid",
              });
            }
            return;
          }
          if (!Number.isFinite(line)) {
            if (import.meta.env.DEV && isFoulsMarket) {
              foulRowsSkipped += 1;
              skipReasonsBreakdown.invalidLine += 1;
              const appearances = stats?.appearances;
              const minutesPlayed = stats?.minutesPlayed ?? 0;
              const expectedMinutes = stats ? computeExpectedMinutes(minutesPlayed, stats.appearances ?? 0) : undefined;
              console.log("[value-bets] skipped fouls row", {
                marketId,
                marketName,
                playerName,
                line,
                outcome,
                odds,
                bookmakerName,
                inLineupById,
                inLineupByName,
                resolvedLineupPlayerId: lineupPlayerId ?? undefined,
                hasStats: !!stats,
                appearances,
                minutesPlayed,
                expectedMinutes,
                reason: "line invalid",
              });
            }
            return;
          }
          seen.add(dedupeKey);

          if (stats) {
            const onFoulsReject = isFoulsMarket
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
              odds,
              lineupInfoFinal,
              fixture,
              lineupConfirmed,
              matchedById,
              playerName,
              onFoulsReject
            );
            if (!built) {
              if (import.meta.env.DEV && isFoulsMarket) {
                const appearances = stats?.appearances;
                const minutesPlayed = stats?.minutesPlayed ?? 0;
                const expectedMinutes = computeExpectedMinutes(minutesPlayed, stats?.appearances ?? 0);
                console.log("[value-bets] fouls model returned null", {
                  playerName,
                  marketId,
                  line,
                  odds,
                  bookmakerName,
                  appearances,
                  minutesPlayed,
                  expectedMinutes,
                });
              }
              return;
            }
            const dataConfidence = built.dataConfidence;
            const dataConfidenceScore = built.dataConfidenceScore;
            const betQualityScore = computeBetQualityScore({
              modelEdge: built.modelEdge,
              calibratedProbability: built.calibratedProbability,
              odds,
              line,
              marketId,
              dataConfidence,
            });
            const betQuality = betQualityBucket(betQualityScore);
            const modelEdge = built.modelEdge ?? 0;
            const bookmakerProb = built.bookmakerProbability;
            const modelProb = built.calibratedProbability ?? 0;
            if (bookmakerProb < 0 || bookmakerProb > 1 || modelProb < 0 || modelProb > 1 || modelEdge < -1 || modelEdge > 1) {
              if (import.meta.env.DEV && isFoulsMarket) {
                foulRowsSkipped += 1;
                skipReasonsBreakdown.probabilityOrEdgeOutOfRange += 1;
                const appearances = stats?.appearances;
                const minutesPlayed = stats?.minutesPlayed ?? 0;
                const expectedMinutes = computeExpectedMinutes(minutesPlayed, stats?.appearances ?? 0);
                console.log("[value-bets] skipped fouls row", {
                  marketId,
                  marketName,
                  playerName,
                  line,
                  outcome,
                  odds,
                  bookmakerName,
                  inLineupById,
                  inLineupByName,
                  resolvedLineupPlayerId: lineupPlayerId ?? undefined,
                  hasStats: true,
                  appearances,
                  minutesPlayed,
                  expectedMinutes,
                  reason: "probability or edge out of range",
                  bookmakerProb,
                  modelProb,
                  modelEdge,
                });
              }
              return;
            }
            const row: ValueBetRow = {
              playerName,
              marketName,
              line,
              outcome,
              odds,
              bookmakerId,
              bookmakerName,
              bookmakerProbability: built.bookmakerProbability,
              modelProbability: built.calibratedProbability,
              rawModelProbability: built.rawModelProbability,
              calibratedProbability: built.calibratedProbability,
              probabilityPct: built.probabilityPct,
              edgePct: built.edgePct,
              modelEdge: built.modelEdge,
              edge: built.modelEdge,
              dataConfidence,
              dataConfidenceScore,
              betQuality,
              betQualityScore,
              modelInputs: built.modelInputs,
              isStrongBet: false,
            };
            row.calibrationBucketValid = isBucketCalibrated(built.rawModelProbability);
            row.isStrongBet = isStrongBetCandidate(row);
            if (import.meta.env.DEV) {
              console.log("[value-bets] row source", {
                bookmakerId,
                bookmakerName,
                playerName,
                marketId,
                line,
                outcome,
                odds,
              });
            }
            rows.push(row);
            if (import.meta.env.DEV && isFoulsMarket) {
              foulRowsCreated += 1;
            }
          } else {
            if (!isOddsSane(odds) || !Number.isFinite(line)) {
              if (import.meta.env.DEV && isFoulsMarket) {
                foulRowsSkipped += 1;
                skipReasonsBreakdown.noStatsAndInvalidOdds += 1;
                console.log("[value-bets] skipped fouls row", {
                  marketId,
                  marketName,
                  playerName,
                  line,
                  outcome,
                  odds,
                  bookmakerName,
                  inLineupById,
                  inLineupByName,
                  resolvedLineupPlayerId: lineupPlayerId ?? undefined,
                  hasStats: false,
                  appearances: undefined,
                  minutesPlayed: undefined,
                  expectedMinutes: undefined,
                  reason: "no stats and invalid odds or line",
                });
              }
              return;
            }
            if (import.meta.env.DEV && isFoulsMarket) {
              foulRowsSkipped += 1;
              skipReasonsBreakdown.statsMissing += 1;
              console.log("[value-bets] skipped fouls row", {
                marketId,
                marketName,
                playerName,
                line,
                outcome,
                odds,
                bookmakerName,
                inLineupById,
                inLineupByName,
                resolvedLineupPlayerId: lineupPlayerId ?? undefined,
                hasStats: false,
                appearances: undefined,
                minutesPlayed: undefined,
                expectedMinutes: undefined,
                reason: "stats missing",
              });
            }
            const noModel = buildNoModelRow(line, "Over", odds, bookmakerName);
            rows.push({
              playerName,
              marketName,
              line,
              outcome: "Over",
              odds,
              bookmakerId,
              bookmakerName,
              bookmakerProbability: noModel.bookmakerProbability ?? 0,
              probabilityPct: noModel.probabilityPct ?? "—",
              edgePct: noModel.edgePct ?? "—",
              dataConfidence: noModel.dataConfidence ?? "low",
              dataConfidenceScore: noModel.dataConfidenceScore ?? 0,
              betQuality: noModel.betQuality ?? "low",
              betQualityScore: noModel.betQualityScore ?? 0,
              isStrongBet: false,
              ...noModel,
            });
          }
        };

        if (overOdds != null && Number.isFinite(overOdds)) addRow("Over", overOdds);
      }
    }
  }

  if (import.meta.env.DEV) {
    console.log("[value-bets] rows created", rows.length);
    console.log("[value-bets] fouls summary", {
      foulMarketsSeen,
      foulPlayersSeen,
      foulRowsCreated,
      foulRowsSkipped,
    });
    console.log("[fouls-markets] status", {
      foulStatsAvailable,
      foulMarketsSeen,
      message:
        foulMarketsSeen === 0
          ? "Foul stats exist, but no bookmaker foul markets (338/339) are available for this fixture."
          : "Bookmaker foul markets found.",
    });
    console.log("[value-bets] final fouls pipeline summary", {
      foulMarketsSeen,
      foulPlayersSeen,
      foulRowsCreated,
      foulRowsSkipped,
      skipReasonsBreakdown,
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

  useEffect(() => {
    if (!open) {
      setSelectedPlayerId(null);
      setSelectedTeamName(null);
      setLoadingValueBets(false);
      setValueBetRows(null);
      setValueBetStartingCount(null);
      setFoulsMarketsStatus(null);
      setSelectedBookmaker("all");
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

  const handleFindValueBets = async () => {
    if (fixture == null || lineup == null) return;
    const entries = lineup.data as RawLineupEntry[];
    if (!Array.isArray(entries) || entries.length === 0) return;
    setLoadingValueBets(true);
    setValueBetRows(null);
    setValueBetStartingCount(null);
    try {
      const [data, leagueSeason] = await Promise.all([
        loadPlayerPropsForFixture(fixture.id),
        fixture.league?.name ? fetchLeagueCurrentSeason(fixture.league.name).catch(() => null) : Promise.resolve(null),
      ]);

      if (import.meta.env.DEV) {
        const allMarkets = data.markets ?? [];
        console.log(
          "[player-props] all market ids",
          allMarkets.map((m: { marketId?: number; market_id?: number; id?: number; marketName?: string; market_name?: string; name?: string }) => ({
            marketId: (m as { marketId?: number }).marketId ?? (m as { market_id?: number }).market_id ?? (m as { id?: number }).id,
            marketName: (m as { marketName?: string }).marketName ?? (m as { market_name?: string }).market_name ?? (m as { name?: string }).name,
          }))
        );
        const foulsMarkets = allMarkets.filter((m: { marketId?: number; market_id?: number; id?: number }) => {
          const id = (m as { marketId?: number }).marketId ?? (m as { market_id?: number }).market_id ?? (m as { id?: number }).id;
          return id === 338 || id === 339;
        });
        console.log("[player-props] fouls markets count", foulsMarkets.length);
        console.log(
          "[player-props] fouls markets ids",
          foulsMarkets.map((m: { marketId?: number; market_id?: number; id?: number; marketName?: string; market_name?: string; name?: string }) => ({
            marketId: (m as { marketId?: number }).marketId ?? (m as { market_id?: number }).market_id ?? (m as { id?: number }).id,
            marketName: (m as { marketName?: string }).marketName ?? (m as { market_name?: string }).market_name ?? (m as { name?: string }).name,
          }))
        );
        if (foulsMarkets.length > 0) {
          console.log(
            "[player-props] fouls market sample",
            JSON.stringify(foulsMarkets[0], null, 2)
          );
        }
        console.log("[player-props frontend] fouls market summary", {
          foulMarketsSeen: foulsMarkets.length,
          markets: foulsMarkets.map((m: { marketId?: number; market_id?: number; id?: number; marketName?: string; market_name?: string; name?: string; players?: Array<{ playerName?: string; player_name?: string; name?: string; selections?: unknown[] }> }) => ({
            marketId: (m as { marketId?: number }).marketId ?? (m as { market_id?: number }).market_id ?? (m as { id?: number }).id,
            marketName: (m as { marketName?: string }).marketName ?? (m as { market_name?: string }).market_name ?? (m as { name?: string }).name,
            players: (m as { players?: unknown[] }).players?.length ?? 0,
            selectionsPerPlayerSample: (m as { players?: Array<{ playerName?: string; player_name?: string; name?: string; selections?: unknown[] }> }).players?.slice(0, 3).map((p) => ({
              playerName: p.playerName ?? p.player_name ?? p.name,
              selectionCount: p.selections?.length ?? 0,
            })),
          })),
        });
      }

      const startingPlayerIds = getStartingPlayerIds(entries);
      const startingPlayerNames = getStartingPlayerNames(entries);
      const nameToPlayerId = getNameToPlayerIdMap(entries);
      if (import.meta.env.DEV) {
        console.log("[value-bets] lineup entries", entries.length);
        console.log("[value-bets] starting player ids", startingPlayerIds.size, Array.from(startingPlayerIds));
      }

      const statsByPlayerId = new Map<number, PlayerSeasonStats>();
      const seasonId = leagueSeason?.currentSeasonId;
      if (seasonId != null && seasonId > 0) {
        await Promise.all(
          Array.from(startingPlayerIds).map(async (playerId) => {
            try {
              const stats = await loadPlayerSeasonStats(playerId, seasonId);
              if (import.meta.env.DEV) {
                console.log("[player-stats] loaded", { playerId, stats });
                console.log("[player-stats] fouls fields", {
                  playerId,
                  foulsCommitted: stats?.foulsCommitted,
                  foulsWon: stats?.foulsWon,
                  foulsCommittedMissing: stats?.foulsCommitted == null,
                  foulsWonMissing: stats?.foulsWon == null,
                });
              }
              if (stats) statsByPlayerId.set(playerId, stats);
            } catch {
              // ignore per-player failures
            }
          })
        );
      }

      if (import.meta.env.DEV) {
        console.log("[player-stats] statsByPlayerId size", statsByPlayerId.size);
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
      setValueBetRows(result.rows);
      setValueBetStartingCount(startingPlayerIds.size);
      setFoulsMarketsStatus({ foulStatsAvailable: result.foulStatsAvailable, foulMarketsSeen: result.foulMarketsSeen });
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

  if (import.meta.env.DEV && fixture) {
    const lineupExists = lineup != null && Array.isArray(lineup.data) && lineup.data.length > 0;
    console.log("[lineup] modal status", {
      fixtureId: fixture.id,
      lineupExists,
      lineupCount: lineup?.data?.length ?? 0,
      lineupConfirmed: lineup?.lineupConfirmed,
      finalBadgeShown: lineupStatusBadge,
      pitchRendered: lineupExists && !loading && !error,
    });
  }

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
    </>
  );
}
