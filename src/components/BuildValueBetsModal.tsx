/**
 * Modal to build multi-leg value bets: target odds input and suggested 2–5 leg combos.
 * Reuses value-bet candidate pipeline and fixture odds team props.
 */

import { useState, useCallback, useEffect } from "react";
import type { Fixture } from "../types/fixture.js";
import type { ValueBetRow } from "./LineupModal.js";
import {
  buildValueBetCombos,
  buildEvidenceContextFromRows,
  type BuildCombo,
  type OddsBookmakerInput,
  type FixtureCornersContext,
  type LineupContext,
  type BuildEvidenceContext,
  type RecentStatsByNormalizedName,
} from "../lib/valueBetBuilder.js";
import { formatBetLegDisplayLabel } from "../lib/betLegDisplayLabel.js";
import { loadHeadToHeadContext } from "../services/headToHeadContextService.js";
import { loadFixtureTeamFormContext } from "../services/teamRecentFormContextService.js";
import { saveGeneratedCombosForFixture, getBetPerformanceSummary, resolveStoredCombosForFixture } from "../services/comboPerformanceService.js";
import { fetchFixtureResolutionData } from "../services/comboResolutionDataService.js";
import {
  addTrackedBetShared,
  findDuplicateTrackedBet,
  getBookmakers,
  getBookmakerStats,
  getUnitSize,
  settleTrackedBetsForFixture,
  type DuplicateMatch,
  type TrackedBookmaker,
} from "../services/betTrackerService.js";
import "./BuildValueBetsModal.css";

function getApiOrigin(): string {
  const base =
    typeof import.meta.env !== "undefined" && import.meta.env?.VITE_API_ORIGIN;
  return typeof base === "string" && base !== "" ? base.replace(/\/$/, "") : "";
}

function getOddsApiUrl(fixtureId: number): string {
  return `${getApiOrigin()}/api/fixtures/${fixtureId}/odds`;
}

function getRecentPlayerStatsApiUrl(): string {
  return `${getApiOrigin()}/api/recent-player-stats`;
}

async function fetchFixtureOddsBookmakers(fixtureId: number): Promise<OddsBookmakerInput[] | null> {
  try {
    const res = await fetch(getOddsApiUrl(fixtureId));
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { bookmakers?: OddsBookmakerInput[] }; bookmakers?: OddsBookmakerInput[] };
    const data = json?.data ?? json;
    const bookmakers = data?.bookmakers;
    return Array.isArray(bookmakers) ? bookmakers : null;
  } catch {
    return null;
  }
}

/** Display string for combo EV% (ROI-style `comboEVPercent`). UI-only. */
function formatComboEvPercentLabel(comboEVPercent: number): string {
  const pct = comboEVPercent * 100;
  if (pct > 0) return `+${pct.toFixed(1)}% EV`;
  if (pct < 0) return `(−${Math.abs(pct).toFixed(1)}% EV)`;
  return `0.0% EV`;
}

/**
 * Fetch recent match-by-match stats from the API (Sportmonks-backed when player/team IDs are present).
 * Map keyed by normalized player name (aligned with valueBetBuilder).
 */
async function fetchRecentPlayerStats(
  playerRows: ValueBetRow[],
  excludeFixtureId: number
): Promise<RecentStatsByNormalizedName> {
  const players: Array<{ playerName: string; playerId: number; teamId: number }> = [];
  const seen = new Set<string>();
  for (const r of playerRows) {
    const key = (r.playerName || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) continue;
    const pid = r.sportmonksPlayerId;
    const tid = r.sportmonksTeamId;
    if (typeof pid !== "number" || typeof tid !== "number") continue;
    if (!Number.isFinite(pid) || !Number.isFinite(tid)) continue;
    seen.add(key);
    players.push({ playerName: r.playerName, playerId: pid, teamId: tid });
  }
  if (players.length === 0) {
    if (import.meta.env.DEV) {
      console.log("[recent-stats request skipped] no valid sportmonks ids found", {
        uniquePlayerRows: playerRows.length,
      });
    }
    return {};
  }

  const playersPayload = { players, excludeFixtureId, limit: 10 };
  if (import.meta.env.DEV) console.log("[recent-stats request]", playersPayload);

  try {
    const res = await fetch(getRecentPlayerStatsApiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(playersPayload),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as RecentStatsByNormalizedName;
    if (import.meta.env.DEV) console.log("[recent-stats response]", data);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/** Group flat explanation lines into per-pick blocks (each ✍️ starts a new block). Skips legacy "---" rows if present. */
function splitWhyLinesIntoLegBlocks(lines: readonly string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (line === "---") continue;
    if (line.startsWith("✍️")) {
      if (cur.length) out.push(cur);
      cur = [line];
    } else if (cur.length === 0) {
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Classify body lines under a ✍️ header for presentation only (does not alter copy). */
/** First line of compressed team-prop “Why” copy — slightly stronger typography (player/corner blocks unchanged). */
function isCompressedTeamInsightPrimaryLine(line: string): boolean {
  const t = line.trim();
  return (
    /^Avg total goals ~/.test(t) ||
    /^Expected total goals ~/.test(t) ||
    /^BTTS hit /.test(t) ||
    /^Goals: /.test(t) ||
    /^Thin form /.test(t) ||
    /^Recent league form unavailable/.test(t) ||
    /^Down-ranked: /.test(t)
  );
}

function classifyWhyBodyLine(line: string): "stats" | "context" | "line" | "spacer" {
  if (line === "") return "spacer";
  const t = line.trim();
  /** Comma-separated ints only (no spaces) — matches tipster series output. */
  const isStatsRow = /^(\d+,)*\d+$/.test(t);
  if (isStatsRow) return "stats";
  if (/^Recent\b.*:$/.test(t)) return "line";
  const low = t.toLowerCase();
  const isContextLike =
    low.startsWith("opponent profile") ||
    low.startsWith("role and positioning") ||
    low.startsWith("shot quality") ||
    low.startsWith("role and minutes") ||
    low.includes("opponent draws") ||
    low.includes("opponent commits") ||
    low.includes("matchup") ||
    low.includes("attacking matchup") ||
    (low.includes("opponent") && t.length > 12);
  if (isContextLike) return "context";
  return "line";
}

export interface BuildValueBetsModalProps {
  open: boolean;
  onClose: () => void;
  fixture: Fixture | null;
  /** Returns player value-bet candidates (same pipeline as Find Value Bets). */
  getCandidates: () => Promise<ValueBetRow[]>;
  /** Optional team corners for/against for fixture expected corners model. When null, default expectation is used. */
  fixtureCornersContext?: FixtureCornersContext | null;
  /** Optional lineup (home/away starters with position) for matchup-aware foul boosts. */
  lineupContext?: LineupContext | null;
  /** Optional evidence for evidence-style explanations (recent player stats, H2H corners). When provided, "Why this build" uses it. */
  evidenceContext?: BuildEvidenceContext | null;
}

export function BuildValueBetsModal({
  open,
  onClose,
  fixture,
  getCandidates,
  fixtureCornersContext = null,
  lineupContext = null,
  evidenceContext: evidenceContextProp = null,
}: BuildValueBetsModalProps) {
  const [targetOdds, setTargetOdds] = useState("");
  const [oddsMode, setOddsMode] = useState<"specific" | "range" | "auto">("specific");
  const [targetOddsMin, setTargetOddsMin] = useState("");
  const [targetOddsMax, setTargetOddsMax] = useState("");
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trackerError, setTrackerError] = useState<string | null>(null);
  const [trackerSuccess, setTrackerSuccess] = useState<string | null>(null);
  const [bookmakers, setBookmakers] = useState<TrackedBookmaker[]>([]);
  const [trackerOpenIdx, setTrackerOpenIdx] = useState<number | null>(null);
  const [trackerBookmakerId, setTrackerBookmakerId] = useState<string>("");
  const [trackerStake, setTrackerStake] = useState<string>("");
  const [trackerOddsTaken, setTrackerOddsTaken] = useState<string>("");
  const [unitSize, setUnitSizeState] = useState<number>(2);
  const [trackerAvailableBalance, setTrackerAvailableBalance] = useState<number | null>(null);
  const [trackerStakeTouched, setTrackerStakeTouched] = useState(false);
  const [result, setResult] = useState<{
    combos: BuildCombo[];
    candidateCount: number;
    legCount: number;
  } | null>(null);
  const [trackerDuplicate, setTrackerDuplicate] = useState<{ match: DuplicateMatch; comboIdx: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const current = getBookmakers();
    setUnitSizeState(getUnitSize());
    setBookmakers(current);
    if (current.length > 0) {
      setTrackerBookmakerId((prev) => (prev && current.some((b) => b.id === prev) ? prev : current[0]!.id));
    } else {
      setTrackerBookmakerId("");
    }
  }, [open]);

  useEffect(() => {
    if (!open || fixture == null) return;
    let cancelled = false;
    (async () => {
      try {
        const resolutionInput = await fetchFixtureResolutionData(fixture.id);
        if (cancelled) return;
        const { resolved } = resolveStoredCombosForFixture(fixture.id, {
          isFinished: resolutionInput.isFinished,
          playerResults: resolutionInput.playerResults,
          playerStatsById: resolutionInput.playerStatsById,
          teamLegResultsByLabel: {},
          homeGoals: resolutionInput.homeGoals,
          awayGoals: resolutionInput.awayGoals,
        });
        const trackedSettled = await settleTrackedBetsForFixture(fixture.id);
        if (import.meta.env.DEV) {
          const perf = getBetPerformanceSummary();
          console.log("[bet-performance update]", {
            fixtureId: fixture.id,
            resolvedThisRun: resolved,
            trackedBetsSettled: trackedSettled,
            totalResolved: perf.wins + perf.losses,
            winRate: Number((perf.winRate * 100).toFixed(1)),
            avgScoreWin: Number(perf.avgScoreWin.toFixed(2)),
            avgScoreLoss: Number(perf.avgScoreLoss.toFixed(2)),
            profit: Number(perf.profit.toFixed(2)),
          });
        }
      } catch (err) {
        if (import.meta.env.DEV) console.warn("[bet-performance update] auto-resolution skipped", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, fixture?.id]);

  const handleBuild = useCallback(async () => {
    if (fixture == null) return;
    let target = 1.01;
    let oddsMin: number | null = null;
    let oddsMax: number | null = null;
    let sortMode: "target" | "ev" = "target";
    if (oddsMode === "specific") {
      target = parseFloat(targetOdds.replace(/,/g, "."));
      if (!Number.isFinite(target) || target < 1.1 || target > 1000) {
        setError("Enter a valid target odds (e.g. 5.0 or 10)");
        return;
      }
    } else if (oddsMode === "range") {
      const minVal = parseFloat(targetOddsMin.replace(/,/g, "."));
      const maxVal = parseFloat(targetOddsMax.replace(/,/g, "."));
      if (!Number.isFinite(minVal) || !Number.isFinite(maxVal) || minVal < 1.1 || maxVal < 1.1 || maxVal <= minVal) {
        setError("Enter a valid odds range (min < max). e.g. 3 to 10");
        return;
      }
      oddsMin = minVal;
      oddsMax = maxVal;
      target = (minVal + maxVal) / 2;
    } else {
      sortMode = "ev";
    }
    setError(null);
    setResult(null);
    setBuilding(true);
    try {
      const [playerRows, bookmakers, h2h, teamFormRes] = await Promise.all([
        getCandidates(),
        fetchFixtureOddsBookmakers(fixture.id),
        loadHeadToHeadContext(fixture.homeTeam.id, fixture.awayTeam.id),
        loadFixtureTeamFormContext(fixture.homeTeam.id, fixture.awayTeam.id, {
          excludeFixtureId: fixture.id,
          homeTeamName: fixture.homeTeam.name,
          awayTeamName: fixture.awayTeam.name,
        }),
      ]);
      const recentStatsByNormalizedName = await fetchRecentPlayerStats(playerRows, fixture.id);
      const fromRows = buildEvidenceContextFromRows(playerRows, fixture, recentStatsByNormalizedName);
      const evidenceContext: BuildEvidenceContext | null = {
        ...fromRows,
        ...evidenceContextProp,
        playerRecentStats: evidenceContextProp?.playerRecentStats ?? fromRows.playerRecentStats,
      };
      const headToHeadContext = h2h?.context ?? null;
      const teamFormContext = teamFormRes?.context ?? null;
      if (import.meta.env.DEV) {
        console.log("[build-value-bets] headToHeadContext", {
          fixtureId: fixture.id,
          homeTeamId: fixture.homeTeam.id,
          awayTeamId: fixture.awayTeam.id,
          hasContext: headToHeadContext != null,
          sampleSize: headToHeadContext?.sampleSize ?? 0,
          averageTotalGoals: headToHeadContext?.averageTotalGoals ?? null,
          averageTotalCorners: headToHeadContext?.averageTotalCorners ?? null,
          bttsRate: headToHeadContext?.bttsRate ?? null,
          drawRate: headToHeadContext?.drawRate ?? null,
        });
      }
      if (import.meta.env.DEV) {
        console.log("[build-value-bets] teamFormContext", {
          fixtureId: fixture.id,
          fetchFailed: teamFormContext?.fetchFailed ?? true,
          homeN: teamFormContext?.home.sampleSize ?? 0,
          awayN: teamFormContext?.away.sampleSize ?? 0,
          homeAvgTotal: teamFormContext?.home.avgMatchTotalGoals ?? null,
          awayAvgTotal: teamFormContext?.away.avgMatchTotalGoals ?? null,
        });
      }
      if (import.meta.env.DEV) {
        const n = evidenceContext?.playerRecentStats?.length ?? 0;
        const sample = evidenceContext?.playerRecentStats?.slice(0, 5).map((e) => ({
          playerName: e.playerName,
          marketCategory: e.marketCategory,
          recentValuesLength: e.recentValues?.length ?? 0,
          recentValuesSample: (e.recentValues?.length ?? 0) > 0 ? e.recentValues!.slice(0, 5) : undefined,
        }));
        console.log("[build-value-bets] evidenceContext", {
          playerRecentStatsCount: n,
          sampleRecentStats: sample,
          hasCornersH2hTotals: Boolean(evidenceContext?.cornersH2hTotals?.length),
        });
      }
      const { combos, candidateCount, legCount } = buildValueBetCombos(
        playerRows as Parameters<typeof buildValueBetCombos>[0],
        bookmakers,
        target,
        {
          maxCombos: oddsMode === "auto" ? 6 : 30,
          fixtureCornersContext,
          lineupContext,
          evidenceContext,
          headToHeadContext,
          teamFormContext,
          sortMode,
        }
      );
      const filteredCombos =
        oddsMin != null && oddsMax != null
          ? combos.filter((c) => c.combinedOdds >= oddsMin! && c.combinedOdds <= oddsMax!)
          : combos;
      const finalCombos = oddsMode === "auto" ? filteredCombos.slice(0, 6) : filteredCombos;
      const stored = saveGeneratedCombosForFixture(fixture.id, finalCombos, Math.max(1, finalCombos.length));
      if (import.meta.env.DEV) {
        const perf = getBetPerformanceSummary();
        console.log("[bet-performance]", {
          ...perf,
          savedFromBuild: stored.length,
          avgScoreWin: Number(perf.avgScoreWin.toFixed(2)),
          avgScoreLoss: Number(perf.avgScoreLoss.toFixed(2)),
          winRate: Number((perf.winRate * 100).toFixed(1)),
          profit: Number(perf.profit.toFixed(2)),
        });
      }
      setResult({ combos: finalCombos, candidateCount, legCount });
      if (import.meta.env.DEV) {
        for (const c of combos) {
          console.log("[build-bet combo]", {
            fingerprint: c.fingerprint,
            combinedOdds: c.combinedOdds,
            comboEVPercent: c.comboEVPercent,
            kellyStakePct: c.kellyStakePct,
            combinedProb: c.combinedProb,
            impliedProb: c.impliedProb,
            adjustedComboEdge: c.adjustedComboEdge,
            legs: c.legs.map((l) => ({
              id: l.id,
              label: l.label,
              marketId: l.marketId,
              line: l.line,
              outcome: l.outcome,
              odds: l.odds,
              probability: l.probability,
              edge: l.edge,
              score: l.score,
            })),
          });
        }
      }
      if (finalCombos.length === 0 && import.meta.env.DEV) {
        console.log("[build-value-bets] no combos; candidateCount", candidateCount, "legCount", legCount);
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error("[build-value-bets] build failed", err);
      setError("Failed to build combos");
    } finally {
      setBuilding(false);
    }
  }, [fixture, targetOdds, targetOddsMin, targetOddsMax, oddsMode, getCandidates, fixtureCornersContext, lineupContext, evidenceContextProp]);

  const handleClose = useCallback(() => {
    setTargetOdds("");
    setTargetOddsMin("");
    setTargetOddsMax("");
    setOddsMode("specific");
    setError(null);
    setTrackerError(null);
    setTrackerSuccess(null);
    setTrackerOpenIdx(null);
    setTrackerStake("");
    setTrackerOddsTaken("");
    setTrackerStakeTouched(false);
    setTrackerAvailableBalance(null);
    setResult(null);
    setTrackerDuplicate(null);
    onClose();
  }, [onClose]);

  const openTrackerPanel = useCallback((idx: number, combo: BuildCombo) => {
    const current = getBookmakers();
    setBookmakers(current);
    setTrackerError(null);
    setTrackerSuccess(null);
    setTrackerDuplicate(null);
    setTrackerOpenIdx(idx);
    setTrackerOddsTaken(combo.combinedOdds.toFixed(2));
    setUnitSizeState(getUnitSize());
    if (current.length > 0) {
      const firstId = current[0]!.id;
      setTrackerBookmakerId(firstId);
      const firstStats = getBookmakerStats(firstId);
      setTrackerAvailableBalance(firstStats?.availableBalance ?? null);
      setTrackerStake("");
      setTrackerStakeTouched(false);
    } else {
      setTrackerBookmakerId("");
      setTrackerAvailableBalance(null);
      setTrackerStake("");
      setTrackerStakeTouched(false);
    }
  }, []);

  const handleAddTrackedBet = useCallback(async (combo: BuildCombo, force = false) => {
    if (!fixture) return;
    if (bookmakers.length === 0) {
      setTrackerError("Add a bookmaker first in Bet Tracker.");
      return;
    }
    const stake = Number(trackerStake);
    const oddsTaken = Number(trackerOddsTaken);
    const availableBalance = trackerAvailableBalance;
    if (!trackerBookmakerId) {
      setTrackerError("Select a bookmaker.");
      return;
    }
    if (!Number.isFinite(stake) || stake <= 0) {
      setTrackerError("Enter a valid stake.");
      return;
    }
    if (availableBalance != null && Number.isFinite(availableBalance) && stake > availableBalance) {
      setTrackerError(`Stake exceeds available balance (£${availableBalance.toFixed(2)}).`);
      return;
    }
    if (!Number.isFinite(oddsTaken) || oddsTaken <= 1) {
      setTrackerError("Odds taken must be greater than 1.");
      return;
    }
    if (!force) {
      const duplicate = findDuplicateTrackedBet({
        bookmakerId: trackerBookmakerId,
        fixtureId: fixture.id,
        matchLabel: `${fixture.homeTeam?.name ?? "Home"} v ${fixture.awayTeam?.name ?? "Away"}`,
        legs: combo.legs.map((leg) => ({
          marketName: leg.marketName,
          marketFamily: leg.marketFamily,
          playerName: leg.playerName,
          line: leg.line,
          outcome: leg.outcome,
        })),
      });
      if (duplicate) {
        setTrackerDuplicate({ match: duplicate, comboIdx: trackerOpenIdx ?? -1 });
        if (import.meta.env.DEV) {
          console.log("[duplicate-check]", { incomingBet: combo, matchFound: duplicate });
        }
        return;
      }
    }
    const record = await addTrackedBetShared({
      bookmakerId: trackerBookmakerId,
      stake,
      oddsTaken,
      status: "pending",
      fixtureId: fixture.id,
      matchLabel: `${fixture.homeTeam?.name ?? "Home"} v ${fixture.awayTeam?.name ?? "Away"}`,
      kickoffTime: fixture.startingAt ?? "-",
      leagueName: fixture.league?.name ?? "-",
      combo,
    });
    if (!record) {
      setTrackerError("Could not add bet to tracker (server unavailable).");
      return;
    }
    setTrackerSuccess("Added to Bet Tracker.");
    setTrackerError(null);
    setTrackerOpenIdx(null);
    setTrackerDuplicate(null);
  }, [fixture, bookmakers.length, trackerBookmakerId, trackerStake, trackerOddsTaken, trackerOpenIdx]);

  if (!open) return null;

  const fixtureLabel = fixture
    ? `${fixture.homeTeam?.name ?? "Home"} v ${fixture.awayTeam?.name ?? "Away"}`
    : "";
  const parsedStake = Number(trackerStake);
  const stakeExceedsAvailable =
    trackerAvailableBalance != null &&
    Number.isFinite(trackerAvailableBalance) &&
    Number.isFinite(parsedStake) &&
    parsedStake > trackerAvailableBalance;

  return (
    <div
      className="build-value-bets-modal__overlay"
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="build-value-bets-modal-title"
    >
      <div className="build-value-bets-modal" onClick={(e) => e.stopPropagation()}>
        <div className="build-value-bets-modal__header">
          <h2 id="build-value-bets-modal-title" className="build-value-bets-modal__title">
            Build Value Bets
          </h2>
          <button
            type="button"
            className="build-value-bets-modal__close"
            onClick={handleClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="build-value-bets-modal__body">
          {fixtureLabel && (
            <p className="build-value-bets-modal__fixture">{fixtureLabel}</p>
          )}
          <div className="build-value-bets-modal__input-row">
              <label className="build-value-bets-modal__label" htmlFor="target-odds-mode">
                Target Odds Mode
              </label>
              <select
                id="target-odds-mode"
                className="build-value-bets-modal__input"
                value={oddsMode}
                onChange={(e) => setOddsMode(e.target.value as "specific" | "range" | "auto")}
              >
                <option value="specific">Specific odds</option>
                <option value="range">Odds range</option>
                <option value="auto">Auto (top EV)</option>
              </select>
              {oddsMode === "specific" ? (
                <input
                  id="target-odds-input"
                  className="build-value-bets-modal__input"
                  type="text"
                  placeholder="e.g. 5.0 or 10"
                  value={targetOdds}
                  onChange={(e) => setTargetOdds(e.target.value)}
                />
              ) : oddsMode === "range" ? (
                <div className="build-value-bets-modal__range">
                  <input
                    className="build-value-bets-modal__input"
                    type="text"
                    placeholder="Min (e.g. 3)"
                    value={targetOddsMin}
                    onChange={(e) => setTargetOddsMin(e.target.value)}
                  />
                  <span className="build-value-bets-modal__range-sep">to</span>
                  <input
                    className="build-value-bets-modal__input"
                    type="text"
                    placeholder="Max (e.g. 10)"
                    value={targetOddsMax}
                    onChange={(e) => setTargetOddsMax(e.target.value)}
                  />
                </div>
              ) : (
                <p className="build-value-bets-modal__hint">Builds up to 6 highest EV combos automatically.</p>
              )}
            <button
              type="button"
              className="build-value-bets-modal__build-btn"
              onClick={handleBuild}
              disabled={building || !fixture}
              aria-busy={building}
            >
              {building ? "Building…" : "Build"}
            </button>
          </div>
          {error && (
            <p className="build-value-bets-modal__error" role="alert">
              {error}
            </p>
          )}
          {result && (
            <div className="build-value-bets-modal__results">
              {result.combos.length > 0 && (
                <p className="build-value-bets-modal__results-ev-note">
                  Ranked by distance to target, then edge (preferring fewer legs when close)
                </p>
              )}
              <p className="build-value-bets-modal__results-meta">
                {result.combos.length} combo{result.combos.length !== 1 ? "s" : ""} from {result.legCount} candidate leg
                {result.legCount !== 1 ? "s" : ""} ({result.candidateCount} player rows).
              </p>
              {result.combos.length === 0 ? (
                <p className="build-value-bets-modal__empty">
                  No combos near target. Try running &quot;Find Value Bets&quot; first or a different target.
                </p>
              ) : (
                <ul className="build-value-bets-modal__combo-list">
                  {result.combos.map((combo, i) => (
                    <li key={combo.fingerprint ?? `${combo.combinedOdds}-${i}`} className="build-value-bets-modal__combo-card">
                      <div className="build-value-bets-modal__combo-header">
                        <span className="build-value-bets-modal__combo-leg-count" title="Legs in this combo">
                          {combo.legs.length} pick{combo.legs.length !== 1 ? "s" : ""}
                        </span>
                        <span className="build-value-bets-modal__combo-odds">
                          {combo.combinedOdds.toFixed(2)}×
                        </span>
                        <span className="build-value-bets-modal__combo-distance">
                          {combo.distanceFromTarget < 0.01
                            ? "at target"
                            : `±${combo.distanceFromTarget.toFixed(2)}`}
                        </span>
                        <span
                          className={`build-value-bets-modal__combo-ev ${
                            combo.comboEVPercent > 0 ? "why-ev-positive" : "why-ev-neutral"
                          }`}
                        >
                          {formatComboEvPercentLabel(combo.comboEVPercent)}
                        </span>
                        <span
                          className="build-value-bets-modal__combo-kelly"
                          title="Suggested stake (½ Kelly)"
                        >
                          {` | ${((combo.kellyStakePct ?? 0) * 100).toFixed(1)}% stake`}
                        </span>
                        <button
                          type="button"
                          className="build-value-bets-modal__tracker-add-btn"
                          onClick={() => openTrackerPanel(i, combo)}
                          title="Add this bet to Bet Tracker"
                          aria-label="Add this bet to Bet Tracker"
                        >
                          +
                        </button>
                      </div>
                      {trackerOpenIdx === i && (
                        <div className="build-value-bets-modal__tracker-panel">
                          {bookmakers.length === 0 ? (
                            <p className="build-value-bets-modal__tracker-note">
                              No bookmakers found. Add one in the Bet Tracker tab first.
                            </p>
                          ) : (
                            <>
                              <label>
                                Bookmaker
                                <select
                                  value={trackerBookmakerId}
                                  onChange={(e) => {
                                    const id = e.target.value;
                                    setTrackerBookmakerId(id);
                                    const stats = getBookmakerStats(id);
                                    setTrackerAvailableBalance(stats?.availableBalance ?? null);
                                  }}
                                >
                                  {bookmakers.map((b) => (
                                    <option key={b.id} value={b.id}>
                                      {b.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                Stake
                                <input
                                  type="number"
                                  min={0}
                                  step={0.01}
                                  value={trackerStake}
                                  onChange={(e) => {
                                    setTrackerStake(e.target.value);
                                    setTrackerStakeTouched(true);
                                  }}
                                  placeholder="0.00"
                                />
                              </label>
                              <label>
                                Odds taken
                                <input
                                  type="number"
                                  min={1.01}
                                  step={0.01}
                                  value={trackerOddsTaken}
                                  onChange={(e) => setTrackerOddsTaken(e.target.value)}
                                  placeholder="e.g. 3.20"
                                />
                              </label>
                              <p className="build-value-bets-modal__tracker-available">
                                Available: £
                                {trackerAvailableBalance != null && Number.isFinite(trackerAvailableBalance)
                                  ? trackerAvailableBalance.toFixed(2)
                                  : "0.00"}
                              </p>
                              {stakeExceedsAvailable && (
                                <p className="build-value-bets-modal__tracker-balance-error">
                                  Stake exceeds available balance (£{trackerAvailableBalance?.toFixed(2)}).
                                </p>
                              )}
                              <p className="build-value-bets-modal__tracker-return">
                                Return: £
                                {(() => {
                                  const s = Number(trackerStake);
                                  const o = Number(trackerOddsTaken);
                                  if (!Number.isFinite(s) || !Number.isFinite(o) || s <= 0 || o <= 0) return "0.00";
                                  return (s * o).toFixed(2);
                                })()}
                              </p>
                              <p className="build-value-bets-modal__tracker-suggested">
                                Stake Units:{" "}
                                {(() => {
                                  const s = Number(trackerStake);
                                  if (!Number.isFinite(s) || s <= 0 || unitSize <= 0) return "0.00u";
                                  return `${(s / unitSize).toFixed(2)}u`;
                                })()}
                              </p>
                              <p className="build-value-bets-modal__tracker-suggested">
                                Return Units:{" "}
                                {(() => {
                                  const s = Number(trackerStake);
                                  const o = Number(trackerOddsTaken);
                                  if (!Number.isFinite(s) || !Number.isFinite(o) || s <= 0 || o <= 0 || unitSize <= 0) return "0.00u";
                                  return `${((s * o) / unitSize).toFixed(2)}u`;
                                })()}
                              </p>
                              {trackerStakeTouched && <p className="build-value-bets-modal__tracker-override">Manual override</p>}
                              {trackerDuplicate && trackerDuplicate.comboIdx === i && (
                                <div className="build-value-bets-modal__tracker-duplicate">
                                  <p>⚠️ You already have a similar bet tracked.</p>
                                  <p>
                                    Existing: £{trackerDuplicate.match.existingBet.stake.toFixed(2)} @ {trackerDuplicate.match.existingBet.oddsTaken.toFixed(2)} • {trackerDuplicate.match.existingBet.bookmakerName}
                                  </p>
                                  <div className="build-value-bets-modal__tracker-duplicate-actions">
                                    <button
                                      type="button"
                                      className="secondary"
                                      onClick={() => setTrackerDuplicate(null)}
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleAddTrackedBet(combo, true)}
                                    >
                                      Add Anyway
                                    </button>
                                  </div>
                                </div>
                              )}
                              <button
                                type="button"
                                className="build-value-bets-modal__tracker-save-btn"
                                onClick={() => handleAddTrackedBet(combo)}
                                disabled={stakeExceedsAvailable}
                              >
                                Save to tracker
                              </button>
                            </>
                          )}
                        </div>
                      )}
                      <ul className="build-value-bets-modal__leg-list">
                        {combo.legs.map((leg) => (
                          <li key={leg.id} className="build-value-bets-modal__leg">
                            <span className="build-value-bets-modal__leg-label">{formatBetLegDisplayLabel(leg)}</span>
                            <span className="build-value-bets-modal__leg-odds">{leg.odds.toFixed(2)}</span>
                            {leg.reason && (
                              <span className="build-value-bets-modal__leg-reason">{leg.reason}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                      {combo.explanation?.lines?.some((x) => x.length > 0) && (
                        <div className="build-value-bets-modal__why">
                          <h4 className="build-value-bets-modal__why-title">Why this build</h4>
                          <div className="build-value-bets-modal__why-blocks">
                            {splitWhyLinesIntoLegBlocks(combo.explanation.lines).map((block, bi) => {
                              const headerLine = block[0]?.startsWith("✍️") ? block[0] : null;
                              const bodyLines = headerLine != null ? block.slice(1) : block;
                              const firstBodyIdx = bodyLines.findIndex((l) => l.trim() !== "");
                              return (
                                <div key={bi} className="why-leg-block">
                                  {headerLine != null && (
                                    <div className="why-leg-header">{headerLine}</div>
                                  )}
                                  {bodyLines.map((line, li) => {
                                    const kind =
                                      headerLine != null ? classifyWhyBodyLine(line) : "line";
                                    const teamPrimary =
                                      kind === "line" &&
                                      headerLine != null &&
                                      firstBodyIdx === li &&
                                      isCompressedTeamInsightPrimaryLine(line);
                                    const lineClass =
                                      kind === "stats"
                                        ? "why-leg-stats"
                                        : kind === "context"
                                          ? "why-leg-context"
                                          : kind === "spacer"
                                            ? "why-leg-spacer"
                                            : teamPrimary
                                              ? "why-leg-line why-leg-line--team-primary"
                                              : "why-leg-line";
                                    return (
                                      <div key={li} className={lineClass}>
                                        {line}
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {trackerError && <p className="build-value-bets-modal__error">{trackerError}</p>}
              {trackerSuccess && <p className="build-value-bets-modal__tracker-success">{trackerSuccess}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
