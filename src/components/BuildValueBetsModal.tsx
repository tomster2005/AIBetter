/**
 * Modal to build multi-leg value bets: target odds input and suggested 2/3-leg combos.
 * Reuses value-bet candidate pipeline and fixture odds team props.
 */

import { useState, useCallback } from "react";
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

/** Fetch recent match-by-match stats for given player names. Returns map keyed by normalized name; empty on error. */
async function fetchRecentPlayerStats(playerNames: string[]): Promise<RecentStatsByNormalizedName> {
  const names = [...new Set(playerNames)].filter((n) => (n ?? "").trim() !== "");
  if (names.length === 0) return {};
  try {
    const res = await fetch(getRecentPlayerStatsApiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerNames: names }),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as RecentStatsByNormalizedName;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
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
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    combos: BuildCombo[];
    candidateCount: number;
    legCount: number;
  } | null>(null);

  const handleBuild = useCallback(async () => {
    if (fixture == null) return;
    const target = parseFloat(targetOdds.replace(/,/g, "."));
    if (!Number.isFinite(target) || target < 1.1 || target > 1000) {
      setError("Enter a valid target odds (e.g. 5.0 or 10)");
      return;
    }
    setError(null);
    setResult(null);
    setBuilding(true);
    try {
      const [playerRows, bookmakers] = await Promise.all([
        getCandidates(),
        fetchFixtureOddsBookmakers(fixture.id),
      ]);
      const uniqueNames = [...new Set(playerRows.map((r) => r.playerName).filter((n) => (n ?? "").trim() !== ""))];
      const recentStatsByNormalizedName = await fetchRecentPlayerStats(uniqueNames);
      const fromRows = buildEvidenceContextFromRows(playerRows, fixture, recentStatsByNormalizedName);
      const evidenceContext: BuildEvidenceContext | null = {
        ...fromRows,
        ...evidenceContextProp,
        playerRecentStats: evidenceContextProp?.playerRecentStats ?? fromRows.playerRecentStats,
      };
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
        { maxCombos: 30, fixtureCornersContext, lineupContext, evidenceContext }
      );
      setResult({ combos, candidateCount, legCount });
      if (combos.length === 0 && import.meta.env.DEV) {
        console.log("[build-value-bets] no combos; candidateCount", candidateCount, "legCount", legCount);
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error("[build-value-bets] build failed", err);
      setError("Failed to build combos");
    } finally {
      setBuilding(false);
    }
  }, [fixture, targetOdds, getCandidates, fixtureCornersContext, lineupContext, evidenceContextProp]);

  const handleClose = useCallback(() => {
    setTargetOdds("");
    setError(null);
    setResult(null);
    onClose();
  }, [onClose]);

  if (!open) return null;

  const fixtureLabel = fixture
    ? `${fixture.homeTeam?.name ?? "Home"} v ${fixture.awayTeam?.name ?? "Away"}`
    : "";

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
            <label htmlFor="build-value-bets-target" className="build-value-bets-modal__label">
              Target odds
            </label>
            <input
              id="build-value-bets-target"
              type="text"
              inputMode="decimal"
              placeholder="e.g. 5.0 or 10"
              value={targetOdds}
              onChange={(e) => setTargetOdds(e.target.value)}
              className="build-value-bets-modal__input"
              disabled={building}
            />
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
                    <li key={i} className="build-value-bets-modal__combo-card">
                      <div className="build-value-bets-modal__combo-header">
                        <span className="build-value-bets-modal__combo-odds">
                          {combo.combinedOdds.toFixed(2)}×
                        </span>
                        <span className="build-value-bets-modal__combo-distance">
                          {combo.distanceFromTarget < 0.01
                            ? "at target"
                            : `±${combo.distanceFromTarget.toFixed(2)}`}
                        </span>
                      </div>
                      <ul className="build-value-bets-modal__leg-list">
                        {combo.legs.map((leg) => (
                          <li key={leg.id} className="build-value-bets-modal__leg">
                            <span className="build-value-bets-modal__leg-label">{leg.label}</span>
                            <span className="build-value-bets-modal__leg-odds">{leg.odds.toFixed(2)}</span>
                            {leg.reason && (
                              <span className="build-value-bets-modal__leg-reason">{leg.reason}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                      {combo.explanation?.lines?.length > 0 && (
                        <div className="build-value-bets-modal__why">
                          <h4 className="build-value-bets-modal__why-title">Why this build</h4>
                          <ul className="build-value-bets-modal__why-list">
                            {combo.explanation.lines.map((line, j) => (
                              <li key={j} className="build-value-bets-modal__why-line">{line}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
