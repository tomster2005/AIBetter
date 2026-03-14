/**
 * Small API server for fixtures. Keeps Sportmonks token server-side.
 * Run with: tsx server/index.ts (or node after build).
 * Loads .env from project root if present (SPORTMONKS_API_TOKEN).
 */
import "dotenv/config";
import express from "express";
import { getFixturesBetween } from "../src/api/sportmonks.js";

const token = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
if (!token || typeof token !== "string") {
  console.warn(
    "\n⚠️  SPORTMONKS_API_TOKEN is not set. Create a .env file (see .env.example) and add your token.\n   Requests to /api/fixtures will fail until this is set.\n"
  );
}
import { getFixtureDetails } from "../src/api/fixtureDetails.js";
import { getOddsByFixtureId } from "../src/api/odds.js";
import { getPlayerOddsForFixture } from "../src/api/playerOdds.js";
import { getPlayerDetails } from "../src/api/playerDetails.js";
import { getLeagueCurrentSeason } from "../src/api/leagueSearch.js";
import { getStatsContext } from "../src/api/statsContext.js";
import { getPlayerSeasonStatsForProps } from "../src/api/playerSeasonStats.js";
import * as cache from "./cache.js";

const app = express();
const PORT = Number(process.env.API_PORT) || 3001;

app.get("/api/fixtures", async (req, res) => {
  const startParam = req.query.start as string | undefined;
  const endParam = req.query.end as string | undefined;
  if (!startParam || !endParam) {
    res.status(400).json({ error: "Query params 'start' and 'end' (YYYY-MM-DD) are required." });
    return;
  }
  const start = new Date(startParam);
  const end = new Date(endParam);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
    return;
  }
  const cacheKey = cache.getFixturesCacheKey(startParam, endParam);
  const cached = cache.get<unknown[]>(cacheKey);
  if (cached != null) {
    return res.json(cached);
  }
  try {
    const fixtures = await getFixturesBetween(start, end);
    const ttlMs = cache.getFixturesTtlMs(startParam, endParam);
    cache.set(cacheKey, fixtures, ttlMs);
    res.json(fixtures);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to fetch fixtures." });
  }
});

app.get("/api/fixtures/:id/odds", async (req, res) => {
  const idParam = req.params.id;
  const id = parseInt(idParam, 10);
  if (Number.isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid fixture ID." });
    return;
  }
  try {
    const data = await getOddsByFixtureId(id);
    res.json({ data });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[odds] GET /api/fixtures/:id/odds unexpected error", {
        fixtureId: id,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    res.json({ data: { fixtureId: id, bookmakers: [] } });
  }
});

app.get("/api/fixtures/:id/player-odds", async (req, res) => {
  const idParam = req.params.id;
  const id = parseInt(idParam, 10);
  if (Number.isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid fixture ID." });
    return;
  }
  const bookmakerIdParam = req.query.bookmakerId;
  const bookmakerId =
    bookmakerIdParam != null && bookmakerIdParam !== ""
      ? parseInt(String(bookmakerIdParam), 10)
      : undefined;
  const cacheKey = cache.getPlayerOddsCacheKey(id) + (bookmakerId != null ? `-${bookmakerId}` : "");
  const cached = cache.get<unknown>(cacheKey);
  if (cached != null) {
    return res.json({ data: cached });
  }
  try {
    const data = await getPlayerOddsForFixture(id, bookmakerId);
    cache.set(cacheKey, data, cache.getPlayerOddsTtlMs());
    res.json({ data });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[player-odds] GET /api/fixtures/:id/player-odds error", {
        fixtureId: id,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    res.json({
      data: {
        fixtureId: id,
        markets: [
          { marketId: 336, marketName: "Player Shots", players: [] },
          { marketId: 334, marketName: "Player Shots On Target", players: [] },
        ],
        lineupSource: "none",
        playerCount: 0,
      },
    });
  }
});

app.get("/api/fixtures/:id", async (req, res) => {
  const idParam = req.params.id;
  const id = parseInt(idParam, 10);
  if (Number.isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid fixture ID." });
    return;
  }
  const cacheKey = cache.getLineupCacheKey(id);
  const cached = cache.get<unknown>(cacheKey);
  if (cached != null) {
    return res.json(cached);
  }
  try {
    const details = await getFixtureDetails(id);
    cache.set(cacheKey, details, cache.getLineupTtlMs());
    res.json(details);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch fixture details.";
    const status = (err as Error & { status?: number }).status ?? 500;
    if (process.env.NODE_ENV !== "production") {
      console.error("[lineup] GET /api/fixtures/:id failed", {
        fixtureId: id,
        statusCode: status,
        errorMessage: message,
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
    res.status(status).json({ error: message });
  }
});

app.get("/api/players/:id", async (req, res) => {
  const idParam = req.params.id;
  const id = parseInt(idParam, 10);
  if (Number.isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid player ID." });
    return;
  }
  const leagueParam = typeof req.query.league === "string" ? req.query.league.trim() : undefined;

  let seasonId: number | undefined;
  let leagueName: string | undefined;
  let seasonName: string | undefined;
  let usedFilter = false;

  if (leagueParam && leagueParam.length > 0) {
    try {
      const leagueResult = await getLeagueCurrentSeason(leagueParam);
      if (leagueResult) {
        seasonId = leagueResult.currentSeasonId;
        leagueName = leagueResult.leagueName;
        seasonName = leagueResult.currentSeasonName;
        usedFilter = true;
        }
    } catch {
      // fallback to unfiltered stats
    }
  }

  const cacheKey = cache.getPlayerCacheKey(id, seasonId);
  const cached = cache.get<unknown>(cacheKey);
  if (cached != null) {
    return res.json(cached);
  }

  try {
    const details = await getPlayerDetails(id, seasonId != null ? { seasonId } : undefined);
    const ttlMs = cache.getPlayerTtlMs();
    if (usedFilter && leagueName != null && seasonName != null) {
      const payload = {
        data: details,
        meta: { leagueName, seasonName, filtered: true as const },
      };
      cache.set(cacheKey, payload, ttlMs);
      return res.json(payload);
    }
    if (leagueParam && !usedFilter) {
      const payload = {
        data: details,
        meta: { filtered: false as const },
      };
      cache.set(cacheKey, payload, ttlMs);
      return res.json(payload);
    }
    cache.set(cacheKey, details, ttlMs);
    res.json(details);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch player details.";
    const status = (err as Error & { status?: number }).status ?? 500;
    if (process.env.NODE_ENV !== "production") {
      console.error("[player] GET /api/players/:id failed", { playerId: id, statusCode: status, errorMessage: message });
    }
    res.status(status).json({ error: message });
  }
});

app.get("/api/player-stats/:playerId", async (req, res) => {
  const playerIdParam = req.params.playerId;
  const seasonParam = req.query.season as string | undefined;
  const playerId = parseInt(playerIdParam, 10);
  const seasonId = seasonParam != null ? parseInt(seasonParam, 10) : NaN;
  if (Number.isNaN(playerId) || playerId <= 0) {
    res.status(400).json({ error: "Invalid player ID." });
    return;
  }
  if (Number.isNaN(seasonId) || seasonId <= 0) {
    res.status(400).json({ error: "Query param 'season' (season ID) is required and must be a positive number." });
    return;
  }
  try {
    const stats = await getPlayerSeasonStatsForProps(playerId, seasonId);
    if (stats == null) {
      return res.status(404).json({ error: "No season statistics found for this player." });
    }
    res.json(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch player statistics.";
    const status = (err as Error & { status?: number }).status ?? 500;
    if (process.env.NODE_ENV !== "production") {
      console.error("[player-stats] GET /api/player-stats/:playerId failed", { playerId, seasonId, errorMessage: message });
    }
    res.status(status).json({ error: message });
  }
});

app.get("/api/league-current-season", async (req, res) => {
  const leagueParam = req.query.league as string | undefined;
  if (!leagueParam || typeof leagueParam !== "string" || !leagueParam.trim()) {
    res.status(400).json({ error: "Query param 'league' is required." });
    return;
  }
  try {
    const result = await getLeagueCurrentSeason(leagueParam.trim());
    if (result == null) {
      return res.status(404).json({ error: "League or current season not found." });
    }
    res.json({
      currentSeasonId: result.currentSeasonId,
      leagueName: result.leagueName,
      currentSeasonName: result.currentSeasonName,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to resolve league season.";
    if (process.env.NODE_ENV !== "production") {
      console.error("[league-current-season] GET /api/league-current-season failed", { errorMessage: message });
    }
    res.status(500).json({ error: message });
  }
});

app.get("/api/stats-context", async (req, res) => {
  const seasonParam = req.query.seasonId as string | undefined;
  const teamParam = req.query.teamId as string | undefined;
  const seasonId = seasonParam != null ? parseInt(seasonParam, 10) : NaN;
  if (Number.isNaN(seasonId) || seasonId <= 0) {
    res.status(400).json({ error: "Query param 'seasonId' is required and must be a positive number." });
    return;
  }
  const teamId = teamParam != null ? parseInt(teamParam, 10) : undefined;
  if (teamParam != null && (Number.isNaN(teamId!) || teamId! <= 0)) {
    res.status(400).json({ error: "Query param 'teamId' must be a positive number when provided." });
    return;
  }
  const cacheKey = cache.getStatsContextCacheKey(seasonId, teamId);
  const cached = cache.get<unknown>(cacheKey);
  if (cached != null) {
    return res.json(cached);
  }
  try {
    const ctx = await getStatsContext(seasonId, teamId);
    cache.set(cacheKey, ctx, cache.getStatsContextTtlMs());
    res.json(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to resolve stats context.";
    if (process.env.NODE_ENV !== "production") {
      console.error("[stats-context] GET /api/stats-context failed", { seasonId, teamId, errorMessage: message });
    }
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
