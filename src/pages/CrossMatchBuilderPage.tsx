import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type CrossMatchPlayerSingle,
  type CrossMatchTeamSingle,
} from "../lib/crossMatchRanking.js";
import {
  buildCrossFixtureCombosAsync,
  buildStratifiedCrossMatchLegPool,
  type CrossFixtureComboPipelineMetrics,
} from "../lib/crossMatchCombos.js";
import type { BuildCombo, BuildLeg } from "../lib/valueBetBuilder.js";
import "./CrossMatchBuilderPage.css";

const LONDON = "Europe/London";
const MAX_FIXTURES_SCAN = 48;
const FIXTURE_PICKER_PAGE = 40;
const COMBO_RENDER_CAP = 20;

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

function fixtureIdFromTaggedLeg(leg: BuildLeg): number | null {
  const m = /^xf:(\d+):/.exec(leg.marketFamily);
  return m ? Number(m[1]) : null;
}

function emptyPipelineMetrics(): CrossFixtureComboPipelineMetrics {
  return {
    stratifiedPlayerLegsBuilt: 0,
    stratifiedTeamLegsBuilt: 0,
    legPoolSize: 0,
    distinctFixturesInPool: 0,
    generateCombos: {
      preEvComboCount: 0,
      postMinEvComboCount: 0,
      afterPositiveNearFilterCount: 0,
      returnedCount: 0,
      rejectedSameFamilyOverlap: 0,
    },
    afterDistinctFixtureFilter: 0,
    finalRenderedCap: 0,
    comboSearchTruncated: false,
  };
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

  const [selectedFixtureIds, setSelectedFixtureIds] = useState<number[]>([]);
  const [fixturePickerExpanded, setFixturePickerExpanded] = useState(false);
  const [fixturePickerShowAll, setFixturePickerShowAll] = useState(false);

  const [crossCombos, setCrossCombos] = useState<BuildCombo[]>([]);
  const [comboPipelineMetrics, setComboPipelineMetrics] = useState<CrossFixtureComboPipelineMetrics>(emptyPipelineMetrics);
  const [crossComboBusy, setCrossComboBusy] = useState(false);
  const comboGenRef = useRef(0);

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

  const eligibleFixtureIdsKey = useMemo(
    () =>
      eligibleFixtures
        .map((f) => f.id)
        .sort((a, b) => a - b)
        .join(","),
    [eligibleFixtures]
  );

  useEffect(() => {
    const ids = eligibleFixtureIdsKey
      ? eligibleFixtureIdsKey.split(",").map(Number).filter((n) => Number.isFinite(n))
      : [];
    setSelectedFixtureIds(ids);
    setFixturePickerShowAll(false);
  }, [eligibleFixtureIdsKey]);

  const selectedSet = useMemo(() => new Set(selectedFixtureIds), [selectedFixtureIds]);

  const fixturesToScan = useMemo(
    () => eligibleFixtures.filter((f) => selectedSet.has(f.id)),
    [eligibleFixtures, selectedSet]
  );

  const toggleFixture = useCallback((id: number) => {
    setSelectedFixtureIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return [...s].sort((a, b) => a - b);
    });
  }, []);

  const selectAllFixtures = useCallback(() => {
    setSelectedFixtureIds(eligibleFixtures.map((f) => f.id).sort((a, b) => a - b));
  }, [eligibleFixtures]);

  const clearAllFixtures = useCallback(() => {
    setSelectedFixtureIds([]);
  }, []);

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

  const playerRowsInSelection = useMemo(() => {
    if (!scanResult) return [];
    return scanResult.playerRows.filter((r) => selectedSet.has(r.fixtureId));
  }, [scanResult, selectedSet]);

  const teamRowsInSelection = useMemo(() => {
    if (!scanResult) return [];
    return scanResult.teamItems.filter((t) => selectedSet.has(t.fixtureId));
  }, [scanResult, selectedSet]);

  const eligibleLegCountBeforeSingleFilters =
    (marketMode !== "team" ? playerRowsInSelection.length : 0) + (marketMode !== "player" ? teamRowsInSelection.length : 0);

  const filteredPlayer = useMemo(() => {
    return filterPlayerSingles(playerRowsInSelection, singleFilters);
  }, [playerRowsInSelection, singleFilters]);

  const filteredTeam = useMemo(() => {
    return filterTeamSingles(teamRowsInSelection, singleFilters, parseNum(minTeamLegScore, 0));
  }, [teamRowsInSelection, singleFilters, minTeamLegScore]);

  const rankedPlayer = useMemo(
    () => rankPlayerSingles(filteredPlayer, targetOddsNumber),
    [filteredPlayer, targetOddsNumber]
  );
  const rankedTeam = useMemo(
    () => rankTeamSingles(filteredTeam, targetOddsNumber),
    [filteredTeam, targetOddsNumber]
  );

  const eligibleLegCountAfterFilters = rankedPlayer.length + rankedTeam.length;

  const distinctSinglesFixtureCount = useMemo(() => {
    const s = new Set<number>();
    for (const r of rankedPlayer) s.add(r.fixtureId);
    for (const t of rankedTeam) s.add(t.fixtureId);
    return s.size;
  }, [rankedPlayer, rankedTeam]);

  const fixtureMetaById = useMemo(() => {
    const m = new Map<number, { matchLabel: string; leagueName: string; kickoff: string }>();
    for (const f of eligibleFixtures) {
      m.set(f.id, {
        matchLabel: `${f.homeTeam.name} vs ${f.awayTeam.name}`,
        leagueName: f.league?.name ?? "",
        kickoff: f.startingAt?.trim() ?? "",
      });
    }
    if (scanResult) {
      for (const r of scanResult.playerRows) {
        if (!m.has(r.fixtureId)) {
          m.set(r.fixtureId, { matchLabel: r.matchLabel, leagueName: r.leagueName, kickoff: r.kickoff });
        }
      }
      for (const t of scanResult.teamItems) {
        if (!m.has(t.fixtureId)) {
          m.set(t.fixtureId, { matchLabel: t.matchLabel, leagueName: t.leagueName, kickoff: t.kickoff });
        }
      }
    }
    return m;
  }, [eligibleFixtures, scanResult]);

  const finalComboRenderCount = crossCombos.length;

  useEffect(() => {
    const gen = ++comboGenRef.current;
    if (!scanResult || targetOddsNumber == null) {
      setCrossCombos([]);
      setComboPipelineMetrics(emptyPipelineMetrics());
      setCrossComboBusy(false);
      return;
    }
    setCrossComboBusy(true);
    const { legs, stratifiedPlayerLegsBuilt, stratifiedTeamLegsBuilt, legsBeforeFinalCap } = buildStratifiedCrossMatchLegPool(
      rankedPlayer,
      rankedTeam,
      marketMode
    );
    if (legs.length < 2) {
      if (import.meta.env.DEV) {
        console.log("[cross-match-builder] combo path skipped: leg pool < 2", {
          stratifiedPlayerLegsBuilt,
          stratifiedTeamLegsBuilt,
          rankedPlayer: rankedPlayer.length,
          rankedTeam: rankedTeam.length,
        });
      }
      if (gen !== comboGenRef.current) return;
      setCrossCombos([]);
      setComboPipelineMetrics(emptyPipelineMetrics());
      setCrossComboBusy(false);
      return;
    }
    const metrics: CrossFixtureComboPipelineMetrics = { ...emptyPipelineMetrics() };
    void (async () => {
      try {
        const combos = await buildCrossFixtureCombosAsync(legs, targetOddsNumber, {
          maxCombos: COMBO_RENDER_CAP,
          maxLegs: 3,
          metrics,
          stratifiedLegCounts: { player: stratifiedPlayerLegsBuilt, team: stratifiedTeamLegsBuilt },
          legsBeforeFinalCap,
        });
        if (gen !== comboGenRef.current) return;
        setCrossCombos(combos);
        setComboPipelineMetrics(metrics);
        if (import.meta.env.DEV) {
          const g = metrics.generateCombos;
          const b = metrics.bounded;
          console.log("[cross-match-builder] combo pipeline", {
            fixturesInScope: eligibleFixtures.length,
            fixturesSelected: selectedFixtureIds.length,
            fixturesScanned: fixturesToScan.length,
            eligibleLegsBeforeSingleFilters: eligibleLegCountBeforeSingleFilters,
            eligibleLegsAfterSingleFilters: eligibleLegCountAfterFilters,
            distinctFixturesAmongSingles: distinctSinglesFixtureCount,
            stratifiedPlayerLegsBuilt,
            stratifiedTeamLegsBuilt,
            legsBeforeCap: b?.legsInputBeforeFinalCap,
            legPoolSize: metrics.legPoolSize,
            distinctFixturesInLegPool: metrics.distinctFixturesInPool,
            evaluatedLeaves: b?.evaluatedLeaves,
            combosAfterDistinct: metrics.afterDistinctFixtureFilter,
            finalCombosRendered: combos.length,
            comboMs: b?.ms,
            truncated: metrics.comboSearchTruncated,
            rejectedSameFamilyOverlap: g.rejectedSameFamilyOverlap,
          });
        }
      } finally {
        if (gen === comboGenRef.current) setCrossComboBusy(false);
      }
    })();
  }, [
    scanResult,
    targetOddsNumber,
    rankedPlayer,
    rankedTeam,
    marketMode,
    eligibleFixtures.length,
    selectedFixtureIds.length,
    fixturesToScan.length,
    eligibleLegCountBeforeSingleFilters,
    eligibleLegCountAfterFilters,
    distinctSinglesFixtureCount,
  ]);

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
    if (fixturesToScan.length === 0) {
      setScanError("Select at least one fixture to scan.");
      return;
    }
    setScanning(true);
    setScanError(null);
    setScanResult(null);
    setScanProgress({ done: 0, total: fixturesToScan.length });
    try {
      const res = await scanCrossMatchFixtures(fixturesToScan, {
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
  }, [fixturesToScan, marketMode]);

  const failedTraces = scanResult?.traces.filter((t) => !t.ok) ?? [];
  const softTraces = scanResult?.traces.filter((t) => t.ok && t.reason) ?? [];

  const showCombosPrimary = targetOddsNumber != null;
  const fixturesPickerVisible = eligibleFixtures.length;
  const fixturesPickerList = fixturePickerShowAll ? eligibleFixtures : eligibleFixtures.slice(0, FIXTURE_PICKER_PAGE);

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

      {fixturesPickerVisible > 0 ? (
        <section className="cross-match-page__fixture-picker" aria-label="Fixture selection">
          <button
            type="button"
            className="cross-match-page__fixture-picker-toggle"
            onClick={() => setFixturePickerExpanded((v) => !v)}
            aria-expanded={fixturePickerExpanded}
          >
            {fixturePickerExpanded ? "▼" : "▶"} Matches in scope ({eligibleFixtures.length}) — {selectedFixtureIds.length}{" "}
            selected
          </button>
          {fixturePickerExpanded ? (
            <div className="cross-match-page__fixture-picker-body">
              <div className="cross-match-page__fixture-picker-actions">
                <button type="button" className="cross-match-page__fixture-picker-btn" onClick={selectAllFixtures}>
                  Select all
                </button>
                <button type="button" className="cross-match-page__fixture-picker-btn" onClick={clearAllFixtures}>
                  Clear all
                </button>
              </div>
              <ul className="cross-match-page__fixture-picker-list">
                {fixturesPickerList.map((f) => {
                  const checked = selectedSet.has(f.id);
                  return (
                    <li key={f.id} className="cross-match-page__fixture-picker-row">
                      <label className="cross-match-page__fixture-picker-label">
                        <input type="checkbox" checked={checked} onChange={() => toggleFixture(f.id)} />
                        <span className="cross-match-page__fixture-picker-match">
                          {f.homeTeam.name} <span className="cross-match-page__fixture-picker-vs">vs</span> {f.awayTeam.name}
                        </span>
                        <span className="cross-match-page__fixture-picker-meta">
                          {f.league?.name ?? "—"} · {f.startingAt?.trim() || "—"}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {eligibleFixtures.length > FIXTURE_PICKER_PAGE ? (
                <button
                  type="button"
                  className="cross-match-page__fixture-picker-more"
                  onClick={() => setFixturePickerShowAll((v) => !v)}
                >
                  {fixturePickerShowAll ? "Show fewer" : `Show all ${eligibleFixtures.length} fixtures`}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="cross-match-page__actions">
        <button
          type="button"
          className="cross-match-page__scan"
          disabled={scanning || fixturesLoading || fixturesToScan.length === 0}
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
          <p className="cross-match-page__summary" role="status">
            {eligibleFixtures.length} fixtures in scope · {selectedFixtureIds.length} selected for build ·{" "}
            {eligibleLegCountBeforeSingleFilters} raw legs from scan (selection + mode) · {eligibleLegCountAfterFilters}{" "}
            legs after filters · {distinctSinglesFixtureCount} distinct fixtures among filtered singles
            {showCombosPrimary ? (
              <>
                {" "}
                ·{" "}
                {crossComboBusy
                  ? "updating cross-match combos…"
                  : `${finalComboRenderCount} cross-match combo${finalComboRenderCount === 1 ? "" : "s"} shown`}
                {comboPipelineMetrics.bounded && comboPipelineMetrics.legPoolSize > 0 && !crossComboBusy ? (
                  <>
                    {" "}
                    (legs capped {comboPipelineMetrics.bounded.legsInputBeforeFinalCap}→
                    {comboPipelineMetrics.bounded.legsAfterFinalCap} · evaluated{" "}
                    {comboPipelineMetrics.bounded.evaluatedLeaves} · {comboPipelineMetrics.bounded.ms.toFixed(0)}ms)
                  </>
                ) : comboPipelineMetrics.legPoolSize > 0 && !crossComboBusy ? (
                  <>
                    {" "}
                    (pool {comboPipelineMetrics.legPoolSize} legs, {comboPipelineMetrics.distinctFixturesInPool} fixtures)
                  </>
                ) : null}
              </>
            ) : null}
          </p>

          {!showCombosPrimary ? (
            <>
              <section className="cross-match-page__results cross-match-page__results--singles" aria-label="Best singles">
                <h2 className="cross-match-page__section-title">Best Singles</h2>
                <p className="cross-match-page__hint">
                  Primary view when target odds is unset. Enable target odds to surface cross-match combos first.
                </p>
                {marketMode !== "team" && rankedPlayer.length === 0 ? (
                  <p className="cross-match-page__empty">No player singles match filters.</p>
                ) : null}
                {marketMode !== "team" && rankedPlayer.length > 0 ? (
                  <ul className="cross-match-page__card-list">
                    {rankedPlayer.slice(0, 80).map((row, idx) => (
                      <li
                        key={`${row.fixtureId}-${row.playerName}-${row.marketName}-${row.line}-${row.outcome}-${row.bookmakerName}-${idx}`}
                        className="cross-match-card cross-match-card--player"
                      >
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
                        </div>
                        {t.leg.reason ? <p className="cross-match-card__reason">{t.leg.reason}</p> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>

              <section className="cross-match-page__results cross-match-page__results--combos-secondary" aria-label="Cross-match combos unavailable">
                <h2 className="cross-match-page__section-title">Cross-Match Combos</h2>
                <p className="cross-match-page__hint">
                  Set a valid target odds (greater than 1) to rank and build 2–3 leg cross-match combos from different
                  fixtures.
                </p>
              </section>
            </>
          ) : (
            <>
              <section
                className="cross-match-page__results cross-match-page__results--combos-primary"
                aria-label="Cross-match combos"
              >
                <h2 className="cross-match-page__section-title cross-match-page__section-title--combos">Cross-Match Combos</h2>
                <p className="cross-match-page__hint">
                  2–3 legs, each from a different fixture; ordered by closeness to target odds, then EV. Uses the same
                  deterministic combo rules as Build Value Bets (including distinct-fixture enforcement here).
                </p>
                {comboPipelineMetrics.comboSearchTruncated && !crossComboBusy ? (
                  <p className="cross-match-page__speed-note">Showing best combinations (optimised for speed)</p>
                ) : null}
                {distinctSinglesFixtureCount < 2 ? (
                  <p className="cross-match-page__empty cross-match-page__empty--prominent">
                    Cross-match combos need legs from at least two different fixtures. Select more matches or relax filters
                    (odds, edge, bookmaker, quality).
                  </p>
                ) : crossComboBusy ? (
                  <p className="cross-match-page__hint" role="status">
                    Building cross-match combos (bounded search, non-blocking)…
                  </p>
                ) : crossCombos.length === 0 ? (
                  <p className="cross-match-page__empty cross-match-page__empty--prominent">
                    No valid cross-match combos found for current filters.
                  </p>
                ) : (
                  <ul className="cross-match-page__card-list">
                    {crossCombos.map((c, idx) => (
                      <li
                        key={c.fingerprint ?? `combo-${idx}`}
                        className="cross-match-card cross-match-card--combo cross-match-card--combo-hero"
                      >
                        <div className="cross-match-card__combo-metrics">
                          <span className="cross-match-card__combo-metric">
                            <abbr title="Combined decimal odds">Combined</abbr> {c.combinedOdds.toFixed(2)}
                          </span>
                          <span className="cross-match-card__combo-metric">Δ target {c.distanceFromTarget.toFixed(2)}</span>
                          <span className="cross-match-card__combo-metric">EV {(c.comboEV * 100).toFixed(1)}%</span>
                          <span className="cross-match-card__combo-metric">Stake ~{(c.kellyStakePct * 100).toFixed(2)}%</span>
                          <span className="cross-match-card__combo-metric">{c.legs.length} legs</span>
                        </div>
                        <ol className="cross-match-combo__legs cross-match-combo__legs--detailed">
                          {c.legs.map((leg) => {
                            const fid = fixtureIdFromTaggedLeg(leg);
                            const meta = fid != null ? fixtureMetaById.get(fid) : undefined;
                            const fixtureTitle = meta?.matchLabel ?? (fid != null ? `Fixture ${fid}` : "Fixture");
                            return (
                              <li key={leg.id}>
                                <div className="cross-match-combo__leg-fixture">
                                  <strong>{fixtureTitle}</strong>
                                  {meta?.leagueName ? (
                                    <span className="cross-match-combo__leg-league"> · {meta.leagueName}</span>
                                  ) : null}
                                  {meta?.kickoff ? (
                                    <span className="cross-match-combo__leg-kickoff"> · {meta.kickoff}</span>
                                  ) : null}
                                </div>
                                <div className="cross-match-combo__leg-pick">
                                  <strong>{leg.label}</strong> @ {leg.odds.toFixed(2)}{" "}
                                  <span className="cross-match-card__bm">({leg.bookmakerName})</span>
                                </div>
                                {leg.reason ? (
                                  <p className="cross-match-combo__leg-reason-block">{leg.reason}</p>
                                ) : null}
                              </li>
                            );
                          })}
                        </ol>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="cross-match-page__results cross-match-page__results--singles" aria-label="Best singles">
                <h2 className="cross-match-page__section-title">Best Singles</h2>
                <p className="cross-match-page__hint">
                  Supporting picks from the same scan; target odds refines ordering after edge and quality.
                </p>
                {marketMode !== "team" && rankedPlayer.length === 0 ? (
                  <p className="cross-match-page__empty">No player singles match filters.</p>
                ) : null}
                {marketMode !== "team" && rankedPlayer.length > 0 ? (
                  <ul className="cross-match-page__card-list">
                    {rankedPlayer.slice(0, 80).map((row, idx) => (
                      <li
                        key={`${row.fixtureId}-${row.playerName}-${row.marketName}-${row.line}-${row.outcome}-${row.bookmakerName}-${idx}`}
                        className="cross-match-card cross-match-card--player"
                      >
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
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
