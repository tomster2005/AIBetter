/**
 * Small API server for fixtures. Keeps Sportmonks token server-side.
 * Run with: tsx server/index.ts (or node after build).
 * Loads .env from project root if present (SPORTMONKS_API_TOKEN).
 */
import "dotenv/config";
import cors from "cors";
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
import { getHeadToHeadFixtureContext } from "../src/api/headToHeadContext.js";
import * as cache from "./cache.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { StoredBacktestRow, BacktestDataset } from "../src/lib/backtestDataset.js";
import { makeBacktestRowKey } from "../src/lib/backtestDataset.js";
import { resolveRecentPlayerStats } from "./recentPlayerStats.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const BACKTEST_DATASET_PATH = join(PROJECT_ROOT, "data", "backtestRows.json");
const SHARED_BETS_PATH = join(PROJECT_ROOT, "server", "data", "bets.json");

type SharedBetRecord = {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

function loadDataset(): BacktestDataset {
  try {
    const raw = readFileSync(BACKTEST_DATASET_PATH, "utf-8");
    const data = JSON.parse(raw) as BacktestDataset;
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    if (process.env.NODE_ENV !== "production") {
      console.log("[snapshot write] loadDataset fileExists=true parsedExistingRowCount=" + rows.length);
    }
    return { rows };
  } catch {
    if (process.env.NODE_ENV !== "production") {
      console.log("[snapshot write] loadDataset file missing or parse failed parsedExistingRowCount=0");
    }
    return { rows: [] };
  }
}

function saveDataset(data: BacktestDataset): void {
  const dir = join(PROJECT_ROOT, "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(BACKTEST_DATASET_PATH, JSON.stringify(data, null, 2), "utf-8");
  if (process.env.NODE_ENV !== "production") {
    console.log("[snapshot write] saveDataset finalSavedRowCount=" + data.rows.length);
  }
}

function appendBacktestRows(newRows: StoredBacktestRow[]): number {
  const fileExists = existsSync(BACKTEST_DATASET_PATH);
  const incomingRowCount = newRows.length;
  if (process.env.NODE_ENV !== "production") {
    console.log("[snapshot write] appendBacktestRows fileExists=" + fileExists + " incomingRowCount=" + incomingRowCount);
    if (newRows.length > 0) {
      console.log("[snapshot write] sample dedupe key (first row):", makeBacktestRowKey(newRows[0]));
    }
  }
  const data = loadDataset();
  const existingKeys = new Set(data.rows.map((r) => makeBacktestRowKey(r)));
  let appended = 0;
  for (const row of newRows) {
    const key = makeBacktestRowKey(row);
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      data.rows.push(row);
      appended += 1;
    }
  }
  const duplicateRowCountSkipped = incomingRowCount - appended;
  const finalRowCountAfterMerge = data.rows.length;
  if (process.env.NODE_ENV !== "production") {
    console.log("[snapshot write] appendBacktestRows duplicateRowCountSkipped=" + duplicateRowCountSkipped + " appendedCount=" + appended + " finalRowCountAfterMerge=" + finalRowCountAfterMerge);
  }
  if (appended > 0) saveDataset(data);
  if (process.env.NODE_ENV !== "production") {
    console.log("[backtest-dataset] appended rows:", appended);
  }
  return appended;
}

function loadSharedBets(): SharedBetRecord[] {
  try {
    const raw = readFileSync(SHARED_BETS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const arr = Array.isArray(parsed) ? parsed : [];
    return arr
      .filter((x): x is SharedBetRecord => !!x && typeof x === "object" && typeof (x as any).id === "string")
      .sort((a, b) => Date.parse(String((b as any).createdAt ?? "")) - Date.parse(String((a as any).createdAt ?? "")));
  } catch {
    return [];
  }
}

function saveSharedBets(rows: SharedBetRecord[]): void {
  const dir = dirname(SHARED_BETS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SHARED_BETS_PATH, JSON.stringify(rows, null, 2), "utf-8");
}

const app = express();
/** Render sets PORT; API_PORT remains available for local override. */
const PORT = Number(process.env.PORT || process.env.API_PORT) || 3001;

const allowedOrigins =
  process.env.NODE_ENV !== "production"
    ? ["http://localhost:5173", "http://127.0.0.1:5173"]
    : [];

const JSON_LIMIT = "2mb";
app.use(express.json({ limit: JSON_LIMIT }));
if (allowedOrigins.length > 0) {
  app.use(cors({ origin: allowedOrigins }));
  if (process.env.NODE_ENV !== "production") {
    console.log("[api] CORS allowed origins:", allowedOrigins.join(", "));
    console.log("[api] express.json limit:", JSON_LIMIT);
  }
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("AIBetter API is live");
});

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
          { marketId: 338, marketName: "Player Fouls Committed", players: [] },
          { marketId: 339, marketName: "Player Fouls Won", players: [] },
        ],
        lineupSource: "none",
        playerCount: 0,
      },
    });
  }
});

/**
 * Compact fixture head-to-head context (derived on backend, frontend-safe).
 * Uses Sportmonks: GET /v3/football/fixtures/head-to-head/{team1}/{team2}?include=participants;statistics
 */
app.get("/api/head-to-head/:team1/:team2/context", async (req, res) => {
  const team1 = parseInt(req.params.team1, 10);
  const team2 = parseInt(req.params.team2, 10);
  if (Number.isNaN(team1) || team1 <= 0 || Number.isNaN(team2) || team2 <= 0) {
    res.status(400).json({ error: "Invalid team IDs." });
    return;
  }
  const cacheKey = cache.getHeadToHeadContextCacheKey(team1, team2);
  const cached = cache.get<unknown>(cacheKey);
  if (cached != null) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[h2h] cache hit", { team1, team2, cacheKey });
    }
    return res.json({ data: cached });
  }
  try {
    const context = await getHeadToHeadFixtureContext(team1, team2);
    const payload = {
      team1Id: team1,
      team2Id: team2,
      context,
    };
    cache.set(cacheKey, payload, cache.getHeadToHeadContextTtlMs());
    if (process.env.NODE_ENV !== "production") {
      console.log("[h2h] context response", {
        team1,
        team2,
        hasContext: context != null,
        sampleSize: context?.sampleSize ?? 0,
      });
    }
    res.json({ data: payload });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[h2h] GET /api/head-to-head/:team1/:team2/context failed", {
        team1,
        team2,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    res.json({ data: { team1Id: team1, team2Id: team2, context: null } });
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

app.post("/api/backtest-snapshots", (req, res) => {
  if (process.env.NODE_ENV !== "production") {
    console.log("[snapshot backend] POST /api/backtest-snapshots hit", {
      bodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body) : [],
      rowCountReceived: Array.isArray((req.body as { rows?: unknown[] })?.rows) ? (req.body as { rows: unknown[] }).rows.length : 0,
      firstRowPreview:
        Array.isArray((req.body as { rows?: StoredBacktestRow[] })?.rows) && (req.body as { rows: StoredBacktestRow[] }).rows[0]
          ? {
              playerName: (req.body as { rows: StoredBacktestRow[] }).rows[0].playerName,
              marketName: (req.body as { rows: StoredBacktestRow[] }).rows[0].marketName,
              line: (req.body as { rows: StoredBacktestRow[] }).rows[0].line,
            }
          : null,
      resolvedDatasetPath: BACKTEST_DATASET_PATH,
    });
  }
  try {
    const body = req.body as { rows?: StoredBacktestRow[] };
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (rows.length === 0) {
      res.status(204).end();
      return;
    }
    if (process.env.NODE_ENV !== "production") {
      console.log("[snapshot backend] rowCountBeforeWrite=" + rows.length);
    }
    const appended = appendBacktestRows(rows);
    if (process.env.NODE_ENV !== "production") {
      console.log("[snapshot backend] success appended=" + appended);
    }
    res.status(200).json({ appended });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[snapshot backend] caught error", err);
    }
    res.status(500).json({ error: "Failed to save backtest snapshots." });
  }
});

app.get("/api/backtest-snapshots/debug", (_req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).end();
    return;
  }
  const fileExists = existsSync(BACKTEST_DATASET_PATH);
  let rowCount = 0;
  try {
    const data = loadDataset();
    rowCount = data.rows.length;
  } catch {
    // ignore
  }
  res.json({
    debugOnly: true,
    resolvedDatasetPath: BACKTEST_DATASET_PATH,
    fileExists,
    rowCount,
  });
});

app.post("/api/recent-player-stats", async (req, res) => {
  try {
    console.log("=== RECENT STATS ROUTE HIT ===", {
      time: new Date().toISOString(),
      pid: process.pid,
      playersCount: Array.isArray(req.body?.players) ? req.body.players.length : null,
    });
    const body = req.body ?? {};
    if (process.env.NODE_ENV !== "production") {
      console.log("[recent-stats API body]", (body as { players?: unknown }).players);
    }
    const stats = await resolveRecentPlayerStats(body);
    if (process.env.NODE_ENV !== "production") {
      console.log("[recent-stats result]", stats);
    }
    console.log("=== RECENT STATS ROUTE RETURN ===", {
      time: new Date().toISOString(),
      pid: process.pid,
    });
    res.json(stats);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[recent-player-stats] POST /api/recent-player-stats failed", err);
    }
    res.status(500).json({ error: "Failed to get recent player stats." });
  }
});

app.get("/api/bets", (_req, res) => {
  try {
    const rows = loadSharedBets();
    res.json(rows);
  } catch {
    res.json([]);
  }
});

app.post("/api/bets", (req, res) => {
  try {
    const body = req.body as SharedBetRecord;
    if (!body || typeof body !== "object" || typeof body.id !== "string" || body.id.trim() === "") {
      res.status(400).json({ error: "Invalid bet payload (id required)." });
      return;
    }
    const rows = loadSharedBets();
    const existingIdx = rows.findIndex((r) => r.id === body.id);
    if (existingIdx >= 0) {
      rows[existingIdx] = { ...rows[existingIdx], ...body };
    } else {
      rows.unshift(body);
    }
    rows.sort((a, b) => Date.parse(String(b.createdAt ?? "")) - Date.parse(String(a.createdAt ?? "")));
    saveSharedBets(rows);
    res.status(201).json(body);
  } catch {
    res.status(500).json({ error: "Failed to save bet." });
  }
});

app.put("/api/bets/:id", (req, res) => {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "Bet id is required." });
      return;
    }
    const rows = loadSharedBets();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) {
      res.status(404).json({ error: "Bet not found." });
      return;
    }
    const patch = req.body as Record<string, unknown>;
    rows[idx] = { ...rows[idx], ...patch, id };
    saveSharedBets(rows);
    res.json(rows[idx]);
  } catch {
    res.status(500).json({ error: "Failed to update bet." });
  }
});

app.delete("/api/bets/:id", (req, res) => {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "Bet id is required." });
      return;
    }
    const rows = loadSharedBets();
    const next = rows.filter((r) => r.id !== id);
    if (next.length === rows.length) {
      res.status(404).json({ error: "Bet not found." });
      return;
    }
    saveSharedBets(next);
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "Failed to delete bet." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API server listening on 0.0.0.0:${PORT}`);
});
