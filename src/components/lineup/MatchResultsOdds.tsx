/**
 * Odds display for the fixture modal. Renders all supported markets returned by the backend
 * (Match Results, BTTS, Over/Under Goals, etc.). Single fetch from existing backend odds route.
 */

import { useState, useEffect } from "react";
import { summariseNormalisedOdds, findBestOddsByOutcome } from "../../lib/valueBetEngine.js";
import { generateModelProbabilities, explainModel } from "../../lib/modelProbabilities.js";

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

interface MatchResultsOddsProps {
  fixtureId: number | null;
}

export function MatchResultsOdds({ fixtureId }: MatchResultsOddsProps) {
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
          const bodyPreview = await res.text().catch(() => "");
          if (import.meta.env.DEV) {
            console.warn("[odds] fetch failed", {
              fixtureId,
              responseStatus: res.status,
              shortMessage: bodyPreview.slice(0, 120).trim() || res.statusText || "no body",
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
        if (import.meta.env.DEV) {
          console.warn("[odds] fetch failed", { fixtureId, responseStatus: "network/parse", shortMessage: "request failed" });
        }
        setError((prev) => prev ?? "Odds unavailable");
      })
      .finally(() => setLoading(false));
  }, [fixtureId]);

  useEffect(() => {
    if (import.meta.env?.DEV && data != null) {
      const summary = summariseNormalisedOdds(data);
      const best = findBestOddsByOutcome(data);
      console.log("[valueBet] summariseNormalisedOdds", summary);
      console.log("[valueBet] findBestOddsByOutcome", best);
    }
  }, [data]);

  useEffect(() => {
    if (!import.meta.env?.DEV) return;
    const testInput = {
      homeTeam: {
        played: 10,
        goalsFor: 18,
        goalsAgainst: 10,
        homePlayed: 5,
        homeGoalsFor: 10,
        homeGoalsAgainst: 4,
      },
      awayTeam: {
        played: 10,
        goalsFor: 14,
        goalsAgainst: 12,
        awayPlayed: 5,
        awayGoalsFor: 6,
        awayGoalsAgainst: 7,
      },
    };
    const testModel = generateModelProbabilities(testInput);
    console.log("[model] testModel", testModel);
    console.log("[model] explainModel(...)", explainModel(testInput));
  }, []);

  if (fixtureId == null || fixtureId <= 0) return null;

  if (loading) {
    return (
      <section className="match-results-odds" aria-label="Odds">
        <p className="match-results-odds__message">Loading odds…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="match-results-odds" aria-label="Odds">
        <p className="match-results-odds__message">Odds unavailable</p>
      </section>
    );
  }

  const bookmakers = data?.bookmakers ?? [];
  const uniqueMarkets: Array<{ marketId: number; marketName: string }> = [];
  const seenMarketIds = new Set<number>();
  for (const b of bookmakers) {
    for (const m of b.markets) {
      if (m.selections.length > 0 && !seenMarketIds.has(m.marketId)) {
        seenMarketIds.add(m.marketId);
        uniqueMarkets.push({ marketId: m.marketId, marketName: m.marketName });
      }
    }
  }

  if (import.meta.env?.DEV) {
    console.log("[odds] fixtureId:", fixtureId, "| markets:", uniqueMarkets.length, "| bookmakers:", bookmakers.length);
  }

  return (
    <section className="match-results-odds" aria-label="Odds">
      {uniqueMarkets.length === 0 ? (
        <p className="match-results-odds__message">No odds available</p>
      ) : (
        uniqueMarkets.map((market, marketIndex) => {
          const bookmakersWithMarket = bookmakers
            .map((b) => {
              const m = b.markets.find((x) => x.marketId === market.marketId && x.selections.length > 0);
              return m ? { bookmaker: b, market: m } : null;
            })
            .filter((x): x is { bookmaker: OddsBookmaker; market: OddsMarket } => x != null);
          return (
            <div key={market.marketId}>
              <h3
                className={
                  marketIndex === 0
                    ? "match-results-odds__title"
                    : "match-results-odds__title match-results-odds__title--section"
                }
              >
                {market.marketName}
              </h3>
              <div className="match-results-odds__list">
                {bookmakersWithMarket.map(({ bookmaker, market: m }) => (
                  <div key={bookmaker.bookmakerId} className="match-results-odds__bookmaker">
                    <div className="match-results-odds__bookmaker-name">{bookmaker.bookmakerName}</div>
                    <div className="match-results-odds__selections">
                      {m.selections.map((sel, i) => (
                        <span key={i} className="match-results-odds__row">
                          <span className="match-results-odds__label">{sel.label}:</span>
                          <span className="match-results-odds__value">
                            {sel.odds != null ? String(sel.odds) : "—"}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
