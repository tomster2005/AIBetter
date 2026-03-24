import { useCallback, useEffect, useMemo, useState } from "react";
import { formatBetLegDisplayLabel } from "../lib/betLegDisplayLabel.js";
import {
  getAllStoredComboRecords,
  getBetHistoryStats,
  getFinishedStoredComboRecords,
  getOddsBandBreakdown,
  getUnfinishedStoredComboRecords,
  resolveUnfinishedCombosFromFixtures,
  forceReResolveStoredCombosForFixture,
  devAuditBetHistoryCombos,
  devAuditFinishedBetHistoryCombos,
  forceRecheckHistorySettlements,
  deriveBetHistoryDisplayStatus,
  type DisplayStoredComboRecord,
} from "../services/comboPerformanceService.js";
import "./BetHistoryPage.css";

type HistoryTab = "unfinished" | "finished" | "stats";

function fmtDate(value: string | null | undefined): string {
  if (!value) return "-";
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return value;
  return new Date(t).toLocaleString();
}

function fmtOdds(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "-";
}

function fmtScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "-";
}

function HistoryCard({ record, showResult }: { record: DisplayStoredComboRecord; showResult: boolean }) {
  const displayStatus = deriveBetHistoryDisplayStatus(record);
  let statusClass: string;
  let statusText: string;
  if (displayStatus === "settled_win") {
    statusClass = "bet-history__badge bet-history__badge--win";
    statusText = "Won";
  } else if (displayStatus === "settled_loss") {
    statusClass = "bet-history__badge bet-history__badge--loss";
    statusText = "Lost";
  } else if (displayStatus === "pending_resolution") {
    statusClass = "bet-history__badge bet-history__badge--awaiting";
    statusText = "Awaiting resolution";
  } else {
    statusClass = "bet-history__badge bet-history__badge--pending";
    statusText = "Pending match";
  }

  const reasonLine =
    displayStatus === "pending_resolution"
      ? record.resolutionMeta?.pendingReasonSummary ??
        "Full time reported, but one or more legs could not be settled from available data."
      : displayStatus === "pending_fixture" && record.resolutionMeta?.lastResolutionAttemptAt
        ? `Not full time yet (last check ${fmtDate(record.resolutionMeta.lastResolutionAttemptAt)}).`
        : displayStatus === "pending_fixture"
          ? "Match still live or not reported as finished — will retry automatically."
          : null;

  const blockers = record.resolutionMeta?.legBlockers;

  return (
    <article className="bet-history__card">
      <header className="bet-history__card-header">
        <div className="bet-history__card-meta">
          <span className="bet-history__meta-item">Fixture #{record.fixtureId}</span>
          <span className="bet-history__meta-item">Created {fmtDate(record.createdAt)}</span>
          {showResult && <span className="bet-history__meta-item">Resolved {fmtDate(record.resolvedAt)}</span>}
        </div>
        <span className={statusClass}>{statusText}</span>
      </header>

      {reasonLine ? <p className="bet-history__status-reason">{reasonLine}</p> : null}
      {displayStatus === "pending_resolution" && blockers && blockers.length > 0 ? (
        <ul className="bet-history__blocker-list">
          {blockers.map((b, i) => {
            const leg =
              typeof b.legIndex === "number" && record.legs[b.legIndex] != null ? record.legs[b.legIndex] : null;
            const blockerTitle = leg ? formatBetLegDisplayLabel(leg) : b.label;
            return (
              <li key={`${record.id}-block-${i}`} className="bet-history__blocker-item">
                <span className="bet-history__blocker-label">{blockerTitle}</span>
                <span className="bet-history__blocker-reason">{b.reason}</span>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="bet-history__card-grid">
        <p>
          <strong>Odds:</strong> {fmtOdds(record.odds)}
        </p>
        <p>
          <strong>Model Score:</strong> {fmtScore(record.displayNormalizedScore)}
        </p>
        <p>
          <strong>Legs:</strong> {record.legs.length}
        </p>
        {showResult && (
          <p>
            <strong>Result:</strong> {record.result === "win" ? "Win" : record.result === "loss" ? "Loss" : "—"}
          </p>
        )}
      </div>

      <div className="bet-history__legs">
        {record.legs.length === 0 ? (
          <p className="bet-history__empty-inline">No legs recorded for this entry.</p>
        ) : (
          <ul className="bet-history__leg-list">
            {record.legs.map((leg, idx) => (
              <li key={`${record.id}-leg-${idx}`} className="bet-history__leg-item">
                <span className="bet-history__leg-main">{formatBetLegDisplayLabel(leg)}</span>
                <span className="bet-history__leg-meta">
                  {leg.marketFamily || "unknown"} | {leg.bookmakerName || "bookmaker n/a"} | leg odds {fmtOdds(leg.odds ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

export function BetHistoryPage() {
  const [activeTab, setActiveTab] = useState<HistoryTab>("unfinished");
  const [allRecords, setAllRecords] = useState<DisplayStoredComboRecord[]>([]);
  const [finishedRecords, setFinishedRecords] = useState<DisplayStoredComboRecord[]>([]);
  const [unfinishedRecords, setUnfinishedRecords] = useState<DisplayStoredComboRecord[]>([]);

  const refresh = useCallback(() => {
    setAllRecords(getAllStoredComboRecords());
    setFinishedRecords(getFinishedStoredComboRecords());
    setUnfinishedRecords(getUnfinishedStoredComboRecords());
  }, []);

  useEffect(() => {
    refresh();
    const onStorage = () => refresh();
    window.addEventListener("storage", onStorage);
    if (import.meta.env.DEV) {
      (window as any).forceReResolveComboFixture = async (fixtureId: number) => {
        const count = await forceReResolveStoredCombosForFixture(fixtureId);
        refresh();
        return count;
      };
      (window as any).auditBetHistory = async () => {
        await devAuditFinishedBetHistoryCombos();
        await devAuditBetHistoryCombos();
        refresh();
      };
      (window as any).forceRecheckHistorySettlements = async () => {
        const summary = await forceRecheckHistorySettlements();
        refresh();
        return summary;
      };
    }
    return () => {
      window.removeEventListener("storage", onStorage);
      if (import.meta.env.DEV) {
        delete (window as any).forceReResolveComboFixture;
        delete (window as any).auditBetHistory;
        delete (window as any).forceRecheckHistorySettlements;
      }
    };
  }, [refresh]);

  /** Combo resolution only ran on Odds/Lineup via useAutoResolveCombos; Bet History must trigger the same pipeline. */
  const runBetHistoryRefresh = useCallback(async () => {
    const ts = new Date().toISOString();
    const before = getUnfinishedStoredComboRecords();
    const pendingBefore = before.length;
    if (pendingBefore <= 0) {
      if (import.meta.env.DEV) {
        console.log("[bet-history-refresh]", {
          timestamp: ts,
          skipped: true,
          reason: "no unfinished bets",
          betsFetched: getAllStoredComboRecords().length,
          unfinishedCount: 0,
        });
      }
      refresh();
      return;
    }
    const resolvedThisPass = await resolveUnfinishedCombosFromFixtures();
    const allNow = getAllStoredComboRecords();
    const unfinishedNow = getUnfinishedStoredComboRecords();
    if (import.meta.env.DEV) {
      console.log("[bet-history-refresh]", {
        timestamp: ts,
        betsFetched: allNow.length,
        unfinishedCount: unfinishedNow.length,
        resolvedThisPass,
      });
    }
    refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      await runBetHistoryRefresh();
      if (cancelled) return;
    };
    void pull();
    const intervalMs = 30000;
    const t = window.setInterval(() => void pull(), intervalMs);
    const onFocus = () => void pull();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [runBetHistoryRefresh]);

  const stats = useMemo(() => getBetHistoryStats(), [allRecords, finishedRecords, unfinishedRecords]);
  const oddsBands = useMemo(() => getOddsBandBreakdown(), [allRecords, finishedRecords, unfinishedRecords]);

  useEffect(() => {
    if (import.meta.env.DEV) {
      console.log("[bet-history] loaded", {
        total: allRecords.length,
        finished: finishedRecords.length,
        unfinished: unfinishedRecords.length,
      });
    }
  }, [allRecords.length, finishedRecords.length, unfinishedRecords.length]);

  return (
    <div className="bet-history">
      <h1 className="bet-history__title">Bet History</h1>
      <div>
        <button
          type="button"
          className="bet-history__tab"
          onClick={() => void runBetHistoryRefresh()}
        >
          Refresh Settlement
        </button>
      </div>

      <div className="bet-history__tabs" role="tablist" aria-label="Bet history views">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "unfinished"}
          className={`bet-history__tab ${activeTab === "unfinished" ? "bet-history__tab--active" : ""}`}
          onClick={() => setActiveTab("unfinished")}
        >
          Unfinished ({unfinishedRecords.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "finished"}
          className={`bet-history__tab ${activeTab === "finished" ? "bet-history__tab--active" : ""}`}
          onClick={() => setActiveTab("finished")}
        >
          Finished ({finishedRecords.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "stats"}
          className={`bet-history__tab ${activeTab === "stats" ? "bet-history__tab--active" : ""}`}
          onClick={() => setActiveTab("stats")}
        >
          Stats
        </button>
      </div>

      {activeTab === "unfinished" && (
        <section className="bet-history__section" aria-label="Unfinished bets">
          <p className="bet-history__tab-hint">
            Unsettled bets: <strong>Pending match</strong> = not full time yet. <strong>Awaiting resolution</strong> = full
            time, but a stat or market (e.g. corners) is still missing from the feed.
          </p>
          {unfinishedRecords.length === 0 ? (
            <p className="bet-history__empty">No unfinished bets.</p>
          ) : (
            unfinishedRecords.map((record) => <HistoryCard key={record.id} record={record} showResult={false} />)
          )}
        </section>
      )}

      {activeTab === "finished" && (
        <section className="bet-history__section" aria-label="Finished bets">
          {finishedRecords.length === 0 ? (
            <p className="bet-history__empty">No finished bets yet.</p>
          ) : (
            finishedRecords.map((record) => <HistoryCard key={record.id} record={record} showResult />)
          )}
        </section>
      )}

      {activeTab === "stats" && (
        <section className="bet-history__section" aria-label="Bet performance stats">
          <div className="bet-history__stats-grid">
            <div className="bet-history__stat-card"><span>Total bets</span><strong>{allRecords.length}</strong></div>
            <div className="bet-history__stat-card"><span>Finished (settled)</span><strong>{stats.finishedBets}</strong></div>
            <div className="bet-history__stat-card"><span>Unfinished total</span><strong>{stats.unfinishedBets}</strong></div>
            <div className="bet-history__stat-card">
              <span>FT, awaiting stats</span>
              <strong>{stats.pendingResolutionCombos}</strong>
            </div>
            <div className="bet-history__stat-card">
              <span>Match not FT</span>
              <strong>{stats.pendingFixtureCombos}</strong>
            </div>
            <div className="bet-history__stat-card"><span>Wins</span><strong>{stats.wins}</strong></div>
            <div className="bet-history__stat-card"><span>Losses</span><strong>{stats.losses}</strong></div>
            <div className="bet-history__stat-card"><span>Win %</span><strong>{(stats.winRate * 100).toFixed(1)}%</strong></div>
            <div className="bet-history__stat-card"><span>Avg odds</span><strong>{fmtOdds(stats.avgOdds)}</strong></div>
            <div className="bet-history__stat-card"><span>Avg model score</span><strong>{fmtScore(stats.avgScore)}</strong></div>
            <div className="bet-history__stat-card"><span>Avg model score (win)</span><strong>{fmtScore(stats.avgScoreWin)}</strong></div>
            <div className="bet-history__stat-card"><span>Avg model score (loss)</span><strong>{fmtScore(stats.avgScoreLoss)}</strong></div>
            <div className="bet-history__stat-card"><span>Profit</span><strong>{stats.profit.toFixed(2)}</strong></div>
            <div className="bet-history__stat-card"><span>ROI</span><strong>{(stats.roi * 100).toFixed(1)}%</strong></div>
            <div className="bet-history__stat-card"><span>Avg odds (win)</span><strong>{fmtOdds(stats.avgOddsWin)}</strong></div>
            <div className="bet-history__stat-card"><span>Avg odds (loss)</span><strong>{fmtOdds(stats.avgOddsLoss)}</strong></div>
            <div className="bet-history__stat-card"><span>Best winning odds</span><strong>{stats.bestWinningOdds == null ? "-" : fmtOdds(stats.bestWinningOdds)}</strong></div>
            <div className="bet-history__stat-card"><span>Worst losing odds</span><strong>{stats.worstLosingOdds == null ? "-" : fmtOdds(stats.worstLosingOdds)}</strong></div>
          </div>

          <div className="bet-history__table-wrap">
            <h2 className="bet-history__subheading">Odds-Band Win Rates</h2>
            <table className="bet-history__table">
              <thead>
                <tr>
                  <th>Odds band</th>
                  <th>Settled</th>
                  <th>Wins</th>
                  <th>Losses</th>
                  <th>Win %</th>
                  <th>Profit</th>
                </tr>
              </thead>
              <tbody>
                {oddsBands.map((band) => (
                  <tr key={band.label}>
                    <td>{band.label}</td>
                    <td>{band.total}</td>
                    <td>{band.wins}</td>
                    <td>{band.losses}</td>
                    <td>{band.total > 0 ? `${(band.winRate * 100).toFixed(1)}%` : "-"}</td>
                    <td>{band.profit.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
