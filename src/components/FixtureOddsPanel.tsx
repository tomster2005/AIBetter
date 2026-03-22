/**
 * Dedicated odds/value panel for a selected fixture.
 * Renders Core Markets (Match Results, BTTS, Match Goals) and Team Props (Total Corners, Team Total Goals).
 * Structure is ready for a future Player Props section.
 */

import { useState, useEffect, useCallback } from "react";
import {
  CORE_MARKET_IDS,
  MARKET_ID_ALTERNATIVE_CORNERS,
  MARKET_ID_ALTERNATIVE_TOTAL_GOALS,
  MARKET_ID_BTTS,
  MARKET_ID_MATCH_RESULTS,
  TEAM_PROP_MARKET_IDS,
} from "../constants/marketIds.js";
import { formatMatchMarketSelectionDisplay } from "../lib/betLegDisplayLabel.js";
import "./FixtureOddsPanel.css";

/** Market IDs expanded by default (Match Results, BTTS). All others start collapsed. */
const DEFAULT_EXPANDED_MARKET_IDS = new Set<number>([MARKET_ID_MATCH_RESULTS, MARKET_ID_BTTS]);

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

export interface FixtureOddsPanelProps {
  fixtureId: number | null;
  /** Optional fixture name for panel header (e.g. "Home vs Away") */
  fixtureLabel?: string | null;
  /** When true, hide the "Player Props / Coming soon" section (e.g. inside LineupModal) */
  hidePlayerPropsSection?: boolean;
}

export function FixtureOddsPanel({ fixtureId, fixtureLabel, hidePlayerPropsSection }: FixtureOddsPanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<NormalisedOddsResponse | null>(null);

  useEffect(() => {
    if (fixtureId == null || fixtureId <= 0) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setError(null);
    setLoading(true);
    setData(null);
    const url = getOddsApiUrl(fixtureId);
    fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          if (import.meta.env.DEV) {
            const bodyPreview = await res.text().catch(() => "");
            console.warn("[odds] fetch failed", {
              fixtureId,
              status: res.status,
              body: bodyPreview.slice(0, 80),
            });
          }
          setError("Odds unavailable");
          return null;
        }
        return res.json() as Promise<{ data?: NormalisedOddsResponse }>;
      })
      .then((json) => {
        if (json === null) return;
        const normalised: unknown =
          json && typeof json === "object" && "data" in json && (json as { data: unknown }).data != null
            ? (json as { data: NormalisedOddsResponse }).data
            : json;
        if (
          normalised &&
          typeof normalised === "object" &&
          Array.isArray((normalised as NormalisedOddsResponse).bookmakers)
        ) {
          setData(normalised as NormalisedOddsResponse);
        } else {
          setData({ fixtureId, bookmakers: [] });
        }
      })
      .catch(() => {
        if (import.meta.env.DEV) console.warn("[odds] fetch failed", { fixtureId });
        setError((prev) => prev ?? "Odds unavailable");
      })
      .finally(() => setLoading(false));
  }, [fixtureId]);

  if (fixtureId == null || fixtureId <= 0) return null;

  return (
    <aside className="fixture-odds-panel" aria-label="Odds and value">
      {fixtureLabel && (
        <h2 className="fixture-odds-panel__title">{fixtureLabel}</h2>
      )}
      {loading && (
        <p className="fixture-odds-panel__message">Loading odds…</p>
      )}
      {error && (
        <p className="fixture-odds-panel__message fixture-odds-panel__message--error">{error}</p>
      )}
      {!loading && !error && data && (
        <FixtureOddsPanelContent
          bookmakers={data.bookmakers}
          hidePlayerPropsSection={hidePlayerPropsSection}
        />
      )}
    </aside>
  );
}

function FixtureOddsPanelContent({
  bookmakers,
  hidePlayerPropsSection,
}: {
  bookmakers: OddsBookmaker[];
  hidePlayerPropsSection?: boolean;
}) {
  const [expandedMarkets, setExpandedMarkets] = useState<Set<number>>(DEFAULT_EXPANDED_MARKET_IDS);

  const toggleMarket = useCallback((marketId: number) => {
    setExpandedMarkets((prev) => {
      const next = new Set(prev);
      if (next.has(marketId)) next.delete(marketId);
      else next.add(marketId);
      return next;
    });
  }, []);

  const coreMarkets = collectMarketsInGroup(bookmakers, isCoreMarket);
  const teamPropMarkets = collectMarketsInGroup(bookmakers, isTeamPropMarket);

  const hasCore = coreMarkets.length > 0;
  const hasTeamProps = teamPropMarkets.length > 0;
  const hasAny = hasCore || hasTeamProps;

  if (!hasAny) {
    return <p className="fixture-odds-panel__message">No odds available</p>;
  }

  return (
    <>
      {hasCore && (
        <section className="fixture-odds-panel__section" aria-label="Core markets">
          <h3 className="fixture-odds-panel__heading">Core Markets</h3>
          {coreMarkets.map((market) => (
            <MarketBlock
              key={market.marketId}
              market={market}
              bookmakers={bookmakers}
              isExpanded={expandedMarkets.has(market.marketId)}
              onToggle={() => toggleMarket(market.marketId)}
            />
          ))}
        </section>
      )}
      {hasTeamProps && (
        <section className="fixture-odds-panel__section" aria-label="Team props">
          <h3 className="fixture-odds-panel__heading">Team Props</h3>
          {teamPropMarkets.map((market) => (
            <MarketBlock
              key={market.marketId}
              market={market}
              bookmakers={bookmakers}
              isExpanded={expandedMarkets.has(market.marketId)}
              onToggle={() => toggleMarket(market.marketId)}
            />
          ))}
        </section>
      )}
      {!hidePlayerPropsSection && (
        <section className="fixture-odds-panel__section fixture-odds-panel__section--player-props" aria-label="Player props">
          <h3 className="fixture-odds-panel__heading">Player Props</h3>
          <p className="fixture-odds-panel__message fixture-odds-panel__message--muted">Coming soon</p>
        </section>
      )}
    </>
  );
}

function collectMarketsInGroup(
  bookmakers: OddsBookmaker[],
  belongsToGroup: (marketId: number) => boolean
): Array<{ marketId: number; marketName: string }> {
  const seen = new Set<number>();
  const out: Array<{ marketId: number; marketName: string }> = [];
  for (const b of bookmakers) {
    for (const m of b.markets) {
      if (m.selections.length > 0 && belongsToGroup(m.marketId) && !seen.has(m.marketId)) {
        seen.add(m.marketId);
        out.push({ marketId: m.marketId, marketName: m.marketName });
      }
    }
  }
  return out;
}

/** Parse numeric line from "Over 2.5" / "Under 2.5" style labels. */
function parseLineFromOverUnderLabel(label: string): number | null {
  const num = parseFloat((label || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(num) ? num : null;
}

function isOverLabel(label: string): boolean {
  const lower = (label || "").toLowerCase();
  return (lower.includes("over") && !lower.includes("under")) || lower === "over";
}

/** Group Over/Under selections by line for alternative goals/corners. */
function groupSelectionsByLine(
  selections: OddsSelection[]
): Array<{ line: number; over: OddsSelection | null; under: OddsSelection | null }> {
  const byLine = new Map<
    number,
    { over: OddsSelection | null; under: OddsSelection | null }
  >();
  for (const sel of selections) {
    const line = parseLineFromOverUnderLabel(sel.label);
    if (line == null) continue;
    const entry = byLine.get(line) ?? { over: null, under: null };
    if (isOverLabel(sel.label)) entry.over = sel;
    else entry.under = sel;
    byLine.set(line, entry);
  }
  return Array.from(byLine.entries())
    .sort(([a], [b]) => a - b)
    .map(([line, { over, under }]) => ({ line, over, under }));
}

const ALTERNATIVE_LINE_MARKET_IDS = new Set<number>([
  MARKET_ID_ALTERNATIVE_TOTAL_GOALS,
  MARKET_ID_ALTERNATIVE_CORNERS,
]);

function MarketBlock({
  market,
  bookmakers,
  isExpanded,
  onToggle,
}: {
  market: { marketId: number; marketName: string };
  bookmakers: OddsBookmaker[];
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const bookmakersWithMarket = bookmakers
    .map((b) => {
      const m = b.markets.find(
        (x) => x.marketId === market.marketId && x.selections.length > 0
      );
      return m ? { bookmaker: b, market: m } : null;
    })
    .filter((x): x is { bookmaker: OddsBookmaker; market: OddsMarket } => x != null);

  if (bookmakersWithMarket.length === 0) return null;

  const useLineGroups = ALTERNATIVE_LINE_MARKET_IDS.has(market.marketId);

  return (
    <div className="fixture-odds-panel__market">
      <button
        type="button"
        className="fixture-odds-panel__market-toggle"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-controls={`fixture-odds-market-${market.marketId}`}
        id={`fixture-odds-market-heading-${market.marketId}`}
      >
        <span className="fixture-odds-panel__market-toggle-icon" aria-hidden>
          {isExpanded ? "▼" : "▶"}
        </span>
        <span className="fixture-odds-panel__market-title">{market.marketName}</span>
      </button>
      <div
        id={`fixture-odds-market-${market.marketId}`}
        className={`fixture-odds-panel__market-body${useLineGroups ? " fixture-odds-panel__market-body--by-line" : ""}`}
        aria-labelledby={`fixture-odds-market-heading-${market.marketId}`}
        hidden={!isExpanded}
      >
        <div className="fixture-odds-panel__list">
          {bookmakersWithMarket.map(({ bookmaker, market: m }) => (
            <div key={bookmaker.bookmakerId} className="fixture-odds-panel__bookmaker">
              <div className="fixture-odds-panel__bookmaker-name">{bookmaker.bookmakerName}</div>
              {useLineGroups ? (
                <div className="fixture-odds-panel__line-groups">
                  {groupSelectionsByLine(m.selections).map(({ line, over, under }) => (
                    <div key={line} className="fixture-odds-panel__line-group">
                      <span className="fixture-odds-panel__line-label">{line}</span>
                      <div className="fixture-odds-panel__line-pair">
                        <span className="fixture-odds-panel__chip fixture-odds-panel__chip--over">
                          O {over?.odds != null ? String(over.odds) : "—"}
                        </span>
                        <span className="fixture-odds-panel__chip fixture-odds-panel__chip--under">
                          U {under?.odds != null ? String(under.odds) : "—"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="fixture-odds-panel__selections">
                  {m.selections.map((sel, i) => (
                    <span key={i} className="fixture-odds-panel__row">
                      <span className="fixture-odds-panel__label">
                        {formatMatchMarketSelectionDisplay(market.marketId, market.marketName, sel.label)}:
                      </span>
                      <span className="fixture-odds-panel__value">
                        {sel.odds != null ? String(sel.odds) : "—"}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
