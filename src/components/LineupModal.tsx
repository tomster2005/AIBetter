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
  isStrongBetCandidate,
  type ConfidenceLevel,
  type BetQualityLevel,
  type ValueBetModelInputs,
} from "../lib/valueBetModel.js";
import { calibrateProbability, isBucketCalibrated } from "../lib/valueBetCalibration.js";
import { MARKET_ID_PLAYER_SHOTS, MARKET_ID_PLAYER_SHOTS_ON_TARGET } from "../constants/marketIds.js";
import "./LineupModal.css";

/** One row for the Value Bet Analysis table. Model outputs are estimates, not guaranteed truth. */
export interface ValueBetRow {
  playerName: string;
  marketName: string;
  line: number;
  outcome: "Over" | "Under";
  odds: number;
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
  sortConfig,
  onSortConfigChange,
  hideNegativeEdge,
  onHideNegativeEdgeChange,
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
  sortConfig?: { key: ValueSortKey; direction: "asc" | "desc" };
  onSortConfigChange?: (key: ValueSortKey) => void;
  hideNegativeEdge?: boolean;
  onHideNegativeEdgeChange?: (value: boolean) => void;
}) {
  const displayRows = useMemo(() => {
    const rows = valueBetRows ?? [];
    if (rows.length === 0) return [];
    let filtered = [...rows];
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
  }, [valueBetRows, hideNegativeEdge, sortConfig?.key, sortConfig?.direction]);

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

/** Supported player-prop markets for the model (Shots, Shots On Target). */
const SUPPORTED_VALUE_BET_MARKET_IDS = new Set([
  MARKET_ID_PLAYER_SHOTS,
  MARKET_ID_PLAYER_SHOTS_ON_TARGET,
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
  playerName?: string
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
  if (shouldRejectByHardFilter(appearances, minutesPlayed, expectedMinutes)) return null;
  if (!isOddsSane(odds) || !Number.isFinite(line)) return null;

  const bookmakerProb = sanitizedBookmakerProbability(odds);
  if (bookmakerProb <= 0) return null;

  const per90 =
    marketId === MARKET_ID_PLAYER_SHOTS
      ? calculatePer90(stats.shots, minutesPlayed)
      : marketId === MARKET_ID_PLAYER_SHOTS_ON_TARGET
        ? calculatePer90(stats.shotsOnTarget, minutesPlayed)
        : 0;
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
): ValueBetRow[] {
  const rows: ValueBetRow[] = [];
  const marketIdNum = (m: { marketId?: number }) => (typeof m.marketId === "number" ? m.marketId : 0);
  const { byPlayerId: lineupByPlayerId, byNormalizedName: lineupByNormalizedName } =
    buildStarterLineupMaps(entries);
  const seen = new Set<string>();

  const markets = data.markets ?? [];
  for (const market of markets) {
    const marketId = marketIdNum(market);
    if (!SUPPORTED_VALUE_BET_MARKET_IDS.has(marketId)) continue;

    const players = market.players ?? [];
    const marketName = (market as { marketName?: string }).marketName ?? (market as { market_name?: string }).market_name ?? "Market";

    for (const player of players) {
      const playerIdFromProps = getPlayerId(player as Parameters<typeof getPlayerId>[0]);
      const playerName = (player as { playerName?: string }).playerName ?? (player as { player_name?: string }).player_name ?? "Unknown";
      const normalizedName = normalizePlayerName(playerName);

      const inLineupById = playerIdFromProps != null && startingPlayerIds.has(playerIdFromProps);
      const inLineupByName = startingPlayerNames.has(normalizedName);
      if (!inLineupById && !inLineupByName) continue;

      const lineupPlayerId = resolvePlayerIdForStats(playerIdFromProps, normalizedName, startingPlayerIds, nameToPlayerId);
      const stats = lineupPlayerId != null ? statsByPlayerId.get(lineupPlayerId) : undefined;
      const matchedById = inLineupById && lineupPlayerId != null;
      let lineupInfoFinal: StarterLineupInfo | null = lineupPlayerId != null ? lineupByPlayerId.get(lineupPlayerId) ?? null : null;
      if (lineupInfoFinal == null) {
        const byName = lineupByNormalizedName.get(normalizedName);
        if (byName) lineupInfoFinal = { positionId: byName.positionId, teamId: byName.teamId, confirmedStarter: byName.confirmedStarter };
      }

      const selections = (player as { selections?: Array<{ line?: number; overOdds?: number | null; underOdds?: number | null; bookmakerName?: string }> }).selections ?? [];
      for (const sel of selections) {
        const line = sel.line ?? 0;
        const overOdds = (sel as { overOdds?: number | null }).overOdds ?? (sel as { over_odds?: number | null }).over_odds;
        const underOdds = (sel as { underOdds?: number | null }).underOdds ?? (sel as { under_odds?: number | null }).under_odds;
        const bookmakerName = (sel as { bookmakerName?: string }).bookmakerName ?? (sel as { bookmaker_name?: string }).bookmaker_name ?? "";

        const addRow = (outcome: "Over" | "Under", odds: number) => {
          const dedupeKey = `${playerName}|${marketId}|${line}|${outcome}|${bookmakerName}|${odds}`;
          if (seen.has(dedupeKey)) return;
          seen.add(dedupeKey);

          if (stats) {
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
              playerName
            );
            if (!built) return;
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
            const row: ValueBetRow = {
              playerName,
              marketName,
              line,
              outcome,
              odds,
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
            rows.push(row);
          } else {
            if (!isOddsSane(odds) || !Number.isFinite(line)) return;
            const noModel = buildNoModelRow(line, outcome, odds, bookmakerName);
            rows.push({
              playerName,
              marketName,
              line,
              outcome,
              odds,
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
        if (underOdds != null && Number.isFinite(underOdds)) addRow("Under", underOdds);
      }
    }
  }

  if (import.meta.env.DEV) {
    console.log("[value-bets] rows created", rows.length);
  }
  return rows;
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
  const [sortConfig, setSortConfig] = useState<{ key: ValueSortKey; direction: "asc" | "desc" }>({
    key: "edge",
    direction: "desc",
  });
  const [hideNegativeEdge, setHideNegativeEdge] = useState(false);

  useEffect(() => {
    if (!open) {
      setSelectedPlayerId(null);
      setSelectedTeamName(null);
      setLoadingValueBets(false);
      setValueBetRows(null);
      setValueBetStartingCount(null);
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

      const rows = buildValueBetRows(
        data,
        entries,
        fixture,
        lineup?.lineupConfirmed === true,
        startingPlayerIds,
        startingPlayerNames,
        statsByPlayerId,
        nameToPlayerId
      );
      setValueBetRows(rows);
      setValueBetStartingCount(startingPlayerIds.size);
    } catch (err) {
      if (import.meta.env.DEV) console.error("Failed to load player props", err);
      setValueBetRows([]);
      setValueBetStartingCount(null);
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
              sortConfig={sortConfig}
              onSortConfigChange={handleSortConfigChange}
              hideNegativeEdge={hideNegativeEdge}
              onHideNegativeEdgeChange={setHideNegativeEdge}
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
