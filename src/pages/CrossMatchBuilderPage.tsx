import { useCallback, useEffect, useMemo, useState } from "react";
import type { Fixture } from "../types/fixture.js";
import { getFixtureDateKey } from "../utils/groupFixturesByDate.js";
import { useLeagueFavourites } from "../hooks/useLeagueFavourites.js";
import {
  scanCrossMatchFixtures,
  type CrossMatchMarketMode,
  type CrossMatchScanResult,
} from "../services/crossMatchScanService.js";
import {
  filterPlayerSingles,
  filterTeamSingles,
  getPlayerSingleReason,
  rankPlayerSingles,
  rankTeamSingles,
  valueBetRowToCandidate,
  type CrossMatchPlayerSingle,
  type CrossMatchTeamSingle,
} from "../lib/crossMatchRanking.js";
import { tagLegForCrossFixture, buildCrossFixtureCombos } from "../lib/crossMatchCombos.js";
import { filterPlayerCandidates, type BuildCombo, type BuildLeg } from "../lib/valueBetBuilder.js";
import "./CrossMatchBuilderPage.css";

const LONDON = "Europe/London";
const MAX_FIXTURES_SCAN = 48;
const COMBO_PLAYER_CAP = 44;
const COMBO_TEAM_CAP = 24;
const COMBO_LEG_POOL_CAP = 72;

type DateScope = "today" | "24h" | "48h" | "manual";
type LeagueScope = "all" | "favourites";

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

/** London wall-clock "YYYY-MM-DD HH:mm" for lexicographic compare with API fixtures. */
function formatLondonDateTime(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LONDON,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  let hour = parts.find((p) => p.type === "hour")!.value;
  const minute = parts.find((p) => p.type === "minute")!.value;
  if (hour.length === 1) hour = `0${hour}`;
  return `${y}-${m}-${day} ${hour}:${minute}`;
}

function parseNum(v: string, fallback: number): number {
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : fallback;
}

function buildComboLegPool(players: CrossMatchPlayerSingle[], teams: CrossMatchTeamSingle[]): BuildLeg[] {
  const out: BuildLeg[] = [];
  const pSlice = players.slice(0, COMBO_PLAYER_CAP);
  const tSlice = teams.slice(0, COMBO_TEAM_CAP);
  for (const row of pSlice) {
    const legs = filterPlayerCandidates([valueBetRowToCandidate(row)], null);
    const l = legs[0];
    if (l) out.push(tagLegForCrossFixture(l, row.fixtureId));
  }
  for (const t of tSlice) {
    out.push(tagLegForCrossFixture(t.leg, t.fixtureId));
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, COMBO_LEG_POOL_CAP);
}

function comboFixtureSummary(c: BuildCombo, idToLabel: Map<number, string>): string {
  const labels = new Set<string>();
  for (const leg of c.legs) {
    const m = /^xf:(\d+):/.exec(leg.marketFamily);
    if (m) {
      const id = Number(m[1]);
      labels.add(idToLabel.get(id) ?? `Fixture ${id}`);
    }
  }
  const sorted = [...labels].sort((a, b) => a.localeCompare(b));
  return `${sorted.length} matches: ${sorted.join(" · ")}`;
}

export function CrossMatchBuilderPage() {
  const { favouriteIds } = useLeagueFavourites();
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [fixturesLoading, setFixturesLoading] = useState(true);
  const [fixturesError, setFixturesError] = useState<string | null>(null);

  const [dateScope, setDateScope] = useState<DateScope>("today");
  const [manualDateKey, setManualDateKey] = useState<string>(() => toLondonDateKey(new Date()));
  const [leagueScope, setLeagueScope] = useState<LeagueScope>("all");
  const [marketMode, setMarketMode] = useState<CrossMatchMarketMode>("both");

  const [minOdds, setMinOdds] = useState("1.05");
  const [maxOdds, setMaxOdds] = useState("15");
  const [targetOddsInput, setTargetOddsInput] = useState("5");
  const [minEdgePct, setMinEdgePct] = useState("0");
  const [minBetQuality, setMinBetQuality] = useState("0");
  const [minTeamLegScore, setMinTeamLegScore] = useState("10");
  const [bookmaker, setBookmaker] = useState<string>("all");

  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [scanResult, setScanResult] = useState<CrossMatchScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const fetchRange = useMemo(() => {
    const today = toLondonDateKey(new Date());
    if (dateScope === "manual") {
      const key = manualDateKey || today;
      return { start: key, end: key };
    }
    if (dateScope === "today") return { start: today, end: today };
    const end = new Date();
    end.setDate(end.getDate() + (dateScope === "24h" ? 1 : 2));
    return { start: today, end: toLondonDateKey(end) };
  }, [dateScope, manualDateKey]);

  useEffect(() => {
    setFixturesLoading(true);
    setFixturesError(null);
    const { start, end } = fetchRange;
    fetch(`/api/fixtures?start=${start}&end=${end}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          const msg =
            typeof (data as { error?: string })?.error === "string"
              ? (data as { error: string }).error
              : res.statusText;
          throw new Error(msg);
        }
        return data as Fixture[];
      })
      .then(setFixtures)
      .catch((e) => setFixturesError(e instanceof Error ? e.message : "Failed to load fixtures"))
      .finally(() => setFixturesLoading(false));
  }, [fetchRange.start, fetchRange.end]);

  const eligibleFixtures = useMemo(() => {
    const todayKeyLocal = toLondonDateKey(new Date());
    let list = fixtures.slice();
    if (leagueScope === "favourites") {
      list = list.filter((f) => favouriteIds.has(f.league.id));
    }
    if (dateScope === "manual") {
      const key = manualDateKey || todayKeyLocal;
      list = list.filter((f) => getFixtureDateKey(f) === key);
    } else if (dateScope === "today") {
      list = list.filter((f) => getFixtureDateKey(f) === todayKeyLocal);
    } else if (dateScope === "24h" || dateScope === "48h") {
      const nowStr = formatLondonDateTime(new Date());
      const endMs = Date.now() + (dateScope === "24h" ? 24 * 3600 * 1000 : 48 * 3600 * 1000);
      const endStr = formatLondonDateTime(new Date(endMs));
      list = list.filter((f) => {
        const k = f.startingAt?.trim() ?? "";
        return k >= nowStr && k <= endStr;
      });
    }
    list.sort((a, b) => {
      const c = a.startingAt.localeCompare(b.startingAt);
      return c !== 0 ? c : a.id - b.id;
    });
    return list.slice(0, MAX_FIXTURES_SCAN);
  }, [fixtures, leagueScope, dateScope, manualDateKey, favouriteIds]);

  const singleFilters = useMemo(
    () => ({
      minOdds: parseNum(minOdds, 1.01),
      maxOdds: parseNum(maxOdds, 50),
      minEdge: parseNum(minEdgePct, 0) / 100,
      minBetQualityScore: parseNum(minBetQuality, 0),
      bookmaker,
    }),
    [minOdds, maxOdds, minEdgePct, minBetQuality, bookmaker]
  );

  const targetOddsNumber = useMemo(() => {
    const t = parseNum(targetOddsInput, NaN);
    return Number.isFinite(t) && t > 1 ? t : null;
  }, [targetOddsInput]);

  const filteredPlayer = useMemo(() => {
    if (!scanResult) return [];
    return filterPlayerSingles(scanResult.playerRows, singleFilters);
  }, [scanResult, singleFilters]);

  const filteredTeam = useMemo(() => {
    if (!scanResult) return [];
    return filterTeamSingles(scanResult.teamItems, singleFilters, parseNum(minTeamLegScore, 0));
  }, [scanResult, singleFilters, minTeamLegScore]);

  const rankedPlayer = useMemo(
    () => rankPlayerSingles(filteredPlayer, targetOddsNumber),
    [filteredPlayer, targetOddsNumber]
  );
  const rankedTeam = useMemo(
    () => rankTeamSingles(filteredTeam, targetOddsNumber),
    [filteredTeam, targetOddsNumber]
  );

  const fixtureIdToLabel = useMemo(() => {
    const m = new Map<number, string>();
    for (const f of eligibleFixtures) {
      m.set(f.id, `${f.homeTeam.name} vs ${f.awayTeam.name}`);
    }
    return m;
  }, [eligibleFixtures]);

  const crossCombos = useMemo(() => {
    if (targetOddsNumber == null) return [];
    const pool = buildComboLegPool(rankedPlayer, rankedTeam);
    if (pool.length < 2) return [];
    return buildCrossFixtureCombos(pool, targetOddsNumber, { maxCombos: 20, maxLegs: 3 });
  }, [rankedPlayer, rankedTeam, targetOddsNumber]);

  const bookmakerOptions = useMemo(() => {
    if (!scanResult) return ["all"] as string[];
    const names = new Set<string>();
    for (const r of scanResult.playerRows) {
      if (r.bookmakerName?.trim()) names.add(r.bookmakerName.trim());
    }
    for (const t of scanResult.teamItems) {
      if (t.leg.bookmakerName?.trim()) names.add(t.leg.bookmakerName.trim());
    }
    return ["all", ...[...names].sort((a, b) => a.localeCompare(b))];
  }, [scanResult]);

  const runScan = useCallback(async () => {
    if (eligibleFixtures.length === 0) {
      setScanError("No fixtures match your scope.");
      return;
    }
    setScanning(true);
    setScanError(null);
    setScanResult(null);
    setScanProgress({ done: 0, total: eligibleFixtures.length });
    try {
      const res = await scanCrossMatchFixtures(eligibleFixtures, {
        marketMode,
        maxConcurrent: 3,
        onProgress: (done, total) => setScanProgress({ done, total }),
      });
      setScanResult(res);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  }, [eligibleFixtures, marketMode]);

  const failedTraces = scanResult?.traces.filter((t) => !t.ok) ?? [];
  const softTraces = scanResult?.traces.filter((t) => t.ok && t.reason) ?? [];

  return (
    <div className="cross-match-page">
      <p className="cross-match-page__label">Cross-Match Builder</p>
      <h1 className="cross-match-page__title">Value bets across today&apos;s card</h1>
      <p className="cross-match-page__intro">
        Scans multiple fixtures using the same player model as the lineup value table and the same team markets as Build
        Value Bets. <strong>Target odds</strong> sorts singles toward that price (after edge and quality) and drives
        cross-match <strong>combo</strong> generation (2–3 legs from <em>different</em> fixtures) via the shared combo
        engine.
      </p>

      <section className="cross-match-page__toolbar" aria-label="Filters">
        <div className="cross-match-page__field">
          <span className="cross-match-page__field-label">Fixture scope</span>
          <select
            className="cross-match-page__select"
            value={dateScope}
            onChange={(e) => setDateScope(e.target.value as DateScope)}
          >
            <option value="today">Today (London)</option>
            <option value="24h">Next 24h</option>
            <option value="48h">Next 48h</option>
            <option value="manual">Manual date</option>
          </select>
        </div>
        {dateScope === "manual" ? (
          <label className="cross-match-page__field">
            <span className="cross-match-page__field-label">Date</span>
            <input
              type="date"
              className="cross-match-page__input"
              value={manualDateKey}
              onChange={(e) => setManualDateKey(e.target.value)}
            />
          </label>
        ) : null}
        <div className="cross-match-page__field">
          <span className="cross-match-page__field-label">Leagues</span>
          <select
            className="cross-match-page__select"
            value={leagueScope}
            onChange={(e) => setLeagueScope(e.target.value as LeagueScope)}
          >
            <option value="all">All leagues</option>
            <option value="favourites">Favourite leagues only</option>
          </select>
        </div>
        <div className="cross-match-page__field">
          <span className="cross-match-page__field-label">Markets</span>
          <select
            className="cross-match-page__select"
            value={marketMode}
            onChange={(e) => setMarketMode(e.target.value as CrossMatchMarketMode)}
          >
            <option value="player">Player props only</option>
            <option value="team">Team props only</option>
            <option value="both">Player + team</option>
          </select>
        </div>
        <label className="cross-match-page__field">
          <span className="cross-match-page__field-label">Min odds</span>
          <input className="cross-match-page__input" value={minOdds} onChange={(e) => setMinOdds(e.target.value)} />
        </label>
        <label className="cross-match-page__field">
          <span className="cross-match-page__field-label">Max odds</span>
          <input className="cross-match-page__input" value={maxOdds} onChange={(e) => setMaxOdds(e.target.value)} />
        </label>
        <label className="cross-match-page__field">
          <span className="cross-match-page__field-label">Target odds (combos + sort)</span>
          <input
            className="cross-match-page__input"
            value={targetOddsInput}
            onChange={(e) => setTargetOddsInput(e.target.value)}
          />
        </label>
        <label className="cross-match-page__field">
          <span className="cross-match-page__field-label">Min edge %</span>
          <input className="cross-match-page__input" value={minEdgePct} onChange={(e) => setMinEdgePct(e.target.value)} />
        </label>
        <label className="cross-match-page__field">
          <span className="cross-match-page__field-label">Min bet quality (player)</span>
          <input
            className="cross-match-page__input"
            value={minBetQuality}
            onChange={(e) => setMinBetQuality(e.target.value)}
          />
        </label>
        {(marketMode === "team" || marketMode === "both") && (
          <label className="cross-match-page__field">
            <span className="cross-match-page__field-label">Min team leg score</span>
            <input
              className="cross-match-page__input"
              value={minTeamLegScore}
              onChange={(e) => setMinTeamLegScore(e.target.value)}
            />
          </label>
        )}
        <div className="cross-match-page__field">
          <span className="cross-match-page__field-label">Bookmaker</span>
          <select
            className="cross-match-page__select"
            value={bookmaker}
            onChange={(e) => setBookmaker(e.target.value)}
          >
            {bookmakerOptions.map((b) => (
              <option key={b} value={b}>
                {b === "all" ? "All" : b}
              </option>
            ))}
          </select>
        </div>
      </section>

      <div className="cross-match-page__actions">
        <button
          type="button"
          className="cross-match-page__scan"
          disabled={scanning || fixturesLoading || eligibleFixtures.length === 0}
          onClick={() => void runScan()}
        >
          {scanning ? "Scanning…" : "Run cross-match scan"}
        </button>
        <span className="cross-match-page__meta">
          {fixturesLoading
            ? "Loading fixtures…"
            : fixturesError
              ? `Fixture load error: ${fixturesError}`
              : `${eligibleFixtures.length} fixture(s) in scope (cap ${MAX_FIXTURES_SCAN}) · fetch ${fetchRange.start}→${fetchRange.end}`}
        </span>
      </div>

      {scanProgress ? (
        <p className="cross-match-page__progress" role="status">
          Progress: {scanProgress.done}/{scanProgress.total} fixtures
        </p>
      ) : null}
      {scanError ? <p className="cross-match-page__error">{scanError}</p> : null}

      {failedTraces.length > 0 ? (
        <details className="cross-match-page__details">
          <summary>Skipped or failed fixtures ({failedTraces.length})</summary>
          <ul>
            {failedTraces.map((t) => (
              <li key={t.fixtureId}>
                <strong>{t.matchLabel}</strong> — {t.reason ?? "unknown"}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {softTraces.length > 0 ? (
        <details className="cross-match-page__details">
          <summary>Partial / empty scans ({softTraces.length})</summary>
          <ul>
            {softTraces.map((t) => (
              <li key={`${t.fixtureId}-soft`}>
                <strong>{t.matchLabel}</strong> — {t.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {scanResult && !scanning ? (
        <>
          <section className="cross-match-page__results" aria-label="Singles">
            <h2>Singles</h2>
            <p className="cross-match-page__hint">
              Player rows reuse the value-bet model; reasoning lines come from the same builder text as the Build Value Bets
              flow. Team rows use the team-leg scorer from fixture odds. Target odds refines ordering after edge and quality.
            </p>
            {marketMode !== "team" && rankedPlayer.length === 0 ? (
              <p className="cross-match-page__empty">No player singles match filters.</p>
            ) : null}
            {marketMode !== "team" && rankedPlayer.length > 0 ? (
              <ul className="cross-match-page__card-list">
                {rankedPlayer.slice(0, 80).map((row, idx) => (
                  <li key={`${row.fixtureId}-${row.playerName}-${row.marketName}-${row.line}-${row.outcome}-${row.bookmakerName}-${idx}`} className="cross-match-card cross-match-card--player">
                    <div className="cross-match-card__head">
                      <span className="cross-match-card__fixture">{row.matchLabel}</span>
                      <span className="cross-match-card__league">{row.leagueName}</span>
                    </div>
                    <div className="cross-match-card__pick">
                      {row.playerName} · {row.marketName} {row.line} {row.outcome} @ {row.odds.toFixed(2)}{" "}
                      <span className="cross-match-card__bm">({row.bookmakerName})</span>
                    </div>
                    <div className="cross-match-card__stats">
                      Edge {(row.modelEdge ?? row.edge ?? 0) * 100 >= 0 ? "+" : ""}
                      {((row.modelEdge ?? row.edge ?? 0) * 100).toFixed(1)}% · Quality {row.betQualityScore.toFixed(0)} (
                      {row.betQuality}) · Model {row.probabilityPct}
                      {targetOddsNumber != null ? (
                        <>
                          {" "}
                          · Δ target {Math.abs(row.odds - targetOddsNumber).toFixed(2)}
                        </>
                      ) : null}
                    </div>
                    <p className="cross-match-card__reason">{getPlayerSingleReason(row)}</p>
                  </li>
                ))}
              </ul>
            ) : null}

            {marketMode !== "player" && rankedTeam.length === 0 ? (
              <p className="cross-match-page__empty">No team singles match filters.</p>
            ) : null}
            {marketMode !== "player" && rankedTeam.length > 0 ? (
              <ul className="cross-match-page__card-list">
                {rankedTeam.slice(0, 60).map((t, idx) => (
                  <li key={`${t.fixtureId}-${t.leg.id}-${idx}`} className="cross-match-card cross-match-card--team">
                    <div className="cross-match-card__head">
                      <span className="cross-match-card__fixture">{t.matchLabel}</span>
                      <span className="cross-match-card__league">{t.leagueName}</span>
                    </div>
                    <div className="cross-match-card__pick">
                      {t.leg.label} @ {t.leg.odds.toFixed(2)}{" "}
                      <span className="cross-match-card__bm">({t.leg.bookmakerName})</span>
                    </div>
                    <div className="cross-match-card__stats">
                      Builder score {t.leg.score.toFixed(0)}
                      {typeof t.leg.edge === "number" ? <> · Edge {(t.leg.edge * 100).toFixed(1)}%</> : null}
                      {targetOddsNumber != null ? (
                        <>
                          {" "}
                          · Δ target {Math.abs(t.leg.odds - targetOddsNumber).toFixed(2)}
                        </>
                      ) : null}
                    </div>
                    {t.leg.reason ? <p className="cross-match-card__reason">{t.leg.reason}</p> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="cross-match-page__results" aria-label="Cross-match combos">
            <h2>Cross-match combos</h2>
            {targetOddsNumber == null ? (
              <p className="cross-match-page__hint">Set a valid target odds (&gt;1) to rank combos near that combined price.</p>
            ) : crossCombos.length === 0 ? (
              <p className="cross-match-page__empty">
                No multi-fixture combos passed the shared EV / distance rules. Try widening odds, lowering min edge, or
                scanning more matches.
              </p>
            ) : (
              <ul className="cross-match-page__card-list">
                {crossCombos.map((c, idx) => (
                  <li key={c.fingerprint ?? `combo-${idx}`} className="cross-match-card cross-match-card--combo">
                    <div className="cross-match-card__head">
                      <span className="cross-match-card__fixture">{comboFixtureSummary(c, fixtureIdToLabel)}</span>
                      <span className="cross-match-card__stats">
                        Combined {c.combinedOdds.toFixed(2)} · Δ vs target {c.distanceFromTarget.toFixed(2)} · EV{" "}
                        {(c.comboEV * 100).toFixed(1)}% · Stake ~{(c.kellyStakePct * 100).toFixed(2)}%
                      </span>
                    </div>
                    <ol className="cross-match-combo__legs">
                      {c.legs.map((leg) => (
                        <li key={leg.id}>
                          <strong>{leg.label}</strong> @ {leg.odds.toFixed(2)} ({leg.bookmakerName})
                          {leg.reason ? <span className="cross-match-combo__leg-reason"> — {leg.reason}</span> : null}
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
