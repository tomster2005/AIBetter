import { useEffect, useRef } from "react";
import { getBetPerformanceSummary, resolveStoredCombosForFixture } from "../services/comboPerformanceService.js";
import { fetchFixtureResolutionData } from "../services/comboResolutionDataService.js";

const SESSION_KEY_PREFIX = "resolved_fixture_";

export function useAutoResolveCombos(fixtureId: number | null | undefined, enabled = true): void {
  const resolvedFixturesRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!enabled || fixtureId == null || !Number.isFinite(fixtureId) || fixtureId <= 0) return;
    if (resolvedFixturesRef.current.has(fixtureId)) return;
    const sessionKey = `${SESSION_KEY_PREFIX}${fixtureId}`;
    if (typeof window !== "undefined" && window.sessionStorage.getItem(sessionKey) === "1") {
      resolvedFixturesRef.current.add(fixtureId);
      return;
    }

    let cancelled = false;
    (async () => {
      const resolutionData = await fetchFixtureResolutionData(fixtureId);
      if (cancelled) return;
      if (!resolutionData.isFinished || resolutionData.playerResults.length === 0) return;

      const { resolved } = resolveStoredCombosForFixture(fixtureId, {
        isFinished: resolutionData.isFinished,
        playerResults: resolutionData.playerResults,
        playerStatsById: resolutionData.playerStatsById,
        teamLegResultsByLabel: {},
      });

      resolvedFixturesRef.current.add(fixtureId);
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(sessionKey, "1");
      }

      if (import.meta.env.DEV) {
        const perf = getBetPerformanceSummary();
        console.log("[auto-resolve]", {
          fixtureId,
          resolvedNow: resolved,
          totalResolved: perf.wins + perf.losses,
          winRate: Number((perf.winRate * 100).toFixed(1)),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fixtureId, enabled]);
}
