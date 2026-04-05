/**
 * Small API server for fixtures. Keeps Sportmonks token server-side.
 * Run with: tsx server/index.ts (or node after build).
 * Loads .env from project root if present (SPORTMONKS_API_TOKEN).
 */
import "dotenv/config";
import cors from "cors";
import express from "express";
import session from "express-session";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
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
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import type { StoredBacktestRow, BacktestDataset } from "../src/lib/backtestDataset.js";
import { makeBacktestRowKey } from "../src/lib/backtestDataset.js";
import { resolveRecentPlayerStats } from "./recentPlayerStats.js";
import { fetchFixtureTeamFormContext } from "./teamRecentFormService.js";
import { BetsStore, type SharedBetRecord } from "./betsStore.js";

declare module "express-session" {
  interface SessionData {
    authenticated?: boolean;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
/** Vite output lives at repo root; use cwd so Render (and `npm start` from root) resolves dist/ reliably. */
const DIST_DIR = resolve(process.cwd(), "dist");
const SPA_INDEX = join(DIST_DIR, "index.html");
const BACKTEST_DATASET_PATH = join(PROJECT_ROOT, "data", "backtestRows.json");
const SHARED_BETS_PATH = join(PROJECT_ROOT, "server", "data", "bets.json");
const APP_LOGIN_USERNAME = process.env.APP_LOGIN_USERNAME;
const APP_LOGIN_PASSWORD = process.env.APP_LOGIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

if (!APP_LOGIN_USERNAME || !APP_LOGIN_PASSWORD) {
  console.warn(
    "\n⚠️  APP_LOGIN_USERNAME / APP_LOGIN_PASSWORD is not set. Login will fail until these are configured.\n"
  );
}
if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
  console.warn(
    "\n⚠️  SESSION_SECRET is missing or too short. Set a long random secret in your environment.\n"
  );
}

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

const betsStore = new BetsStore({
  projectRoot: PROJECT_ROOT,
  legacyJsonPath: SHARED_BETS_PATH,
});

type ValueEvalMarket = "shots" | "shotsOnTarget" | "goals";

function poissonAtLeast(lambda: number, line: number): number {
  if (!Number.isFinite(lambda) || lambda < 0) return 0;
  if (!Number.isFinite(line) || line < 0) return 0;
  // For common betting lines, treat x.5 as needing ceil(line) events.
  const threshold = Math.max(0, Math.ceil(line));
  if (threshold <= 0) return 1;
  let cumulative = 0;
  let term = Math.exp(-lambda);
  cumulative += term; // k=0
  for (let k = 1; k < threshold; k++) {
    term = (term * lambda) / k;
    cumulative += term;
  }
  return Math.max(0, Math.min(1, 1 - cumulative));
}

const app = express();
/** Render sets PORT; API_PORT remains available for local override. */
const PORT = Number(process.env.PORT || process.env.API_PORT) || 3001;
const httpServer = createServer(app);

const allowedOrigins =
  process.env.NODE_ENV !== "production"
    ? ["http://localhost:5173", "http://127.0.0.1:5173"]
    : [];

const JSON_LIMIT = "2mb";
app.set("trust proxy", 1);
app.use(express.json({ limit: JSON_LIMIT }));
if (allowedOrigins.length > 0) {
  app.use(cors({ origin: allowedOrigins }));
  if (process.env.NODE_ENV !== "production") {
    console.log("[api] CORS allowed origins:", allowedOrigins.join(", "));
    console.log("[api] express.json limit:", JSON_LIMIT);
  }
}
app.use(
  session({
    name: "aibetter.sid",
    secret: SESSION_SECRET || "dev-only-insecure-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PRODUCTION,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
  },
});

io.on("connection", (socket) => {
  if (process.env.NODE_ENV !== "production") {
    console.log("[socket] client connected", { id: socket.id });
  }
  socket.on("disconnect", () => {
    if (process.env.NODE_ENV !== "production") {
      console.log("[socket] client disconnected", { id: socket.id });
    }
  });
});

app.post("/api/auth/login", (req, res) => {
  const body = req.body as { username?: unknown; password?: unknown };
  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!APP_LOGIN_USERNAME || !APP_LOGIN_PASSWORD) {
    res.status(500).json({ error: "Login is not configured on this server." });
    return;
  }
  if (username !== APP_LOGIN_USERNAME || password !== APP_LOGIN_PASSWORD) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }
  req.session.authenticated = true;
  req.session.save((err) => {
    if (err) {
      res.status(500).json({ error: "Failed to create session." });
      return;
    }
    res.json({ authenticated: true });
  });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("aibetter.sid");
    res.json({ authenticated: false });
  });
});

app.get("/api/auth/me", (req, res) => {
  res.json({ authenticated: req.session?.authenticated === true });
});

app.use("/api", (req, res, next) => {
  if (req.path === "/auth/login" || req.path === "/auth/logout" || req.path === "/auth/me") {
    return next();
  }
  if (req.session?.authenticated === true) {
    return next();
  }
  res.status(401).json({ error: "Authentication required." });
});

app.get("/health", (_req, res) => {
  res.type("text/plain").send("ok");
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

app.get("/api/fixtures/signals", (_req, res) => {
  const rawIds = typeof _req.query.ids === "string" ? _req.query.ids : "";
  const ids = rawIds
    .split(",")
    .map((v) => parseInt(v.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length === 0) {
    return res.json({ signals: {} as Record<number, { hasSignal: boolean; signalCount: number }> });
  }

  const wanted = new Set(ids);
  const counts = new Map<number, number>();
  const dataRowsByFixture = new Map<number, number>();
  try {
    const data = loadDataset();
    for (const row of data.rows) {
      const fixtureId = row.fixtureId;
      if (!wanted.has(fixtureId)) continue;
      dataRowsByFixture.set(fixtureId, (dataRowsByFixture.get(fixtureId) ?? 0) + 1);
      // Value signal: positive modeled edge at snapshot time.
      if (typeof row.edge !== "number" || !Number.isFinite(row.edge) || row.edge <= 0) continue;
      counts.set(fixtureId, (counts.get(fixtureId) ?? 0) + 1);
    }
  } catch {
    // Silent fallback: return empty signals.
  }

  const out: Record<number, { hasSignal: boolean; signalCount: number; hasRequiredData: boolean; dataRows: number }> = {};
  let fixturesWithRequiredData = 0;
  for (const id of ids) {
    const signalCount = counts.get(id) ?? 0;
    const dataRows = dataRowsByFixture.get(id) ?? 0;
    const hasRequiredData = dataRows > 0;
    if (hasRequiredData) fixturesWithRequiredData += 1;
    out[id] = { hasSignal: signalCount > 0, signalCount, hasRequiredData, dataRows };
  }
  return res.json({
    signals: out,
    readiness: {
      fixturesRequested: ids.length,
      fixturesWithRequiredData,
      hasRequiredData: fixturesWithRequiredData > 0,
    },
  });
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
          { marketId: 340, marketName: "Player Tackles", players: [] },
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

/**
 * Recent finished matches per team (all opponents) — Sportmonks fixtures/between.
 * Cached; one context object per fixture build (reuse for all team legs on the client).
 */
app.get("/api/team-recent-form/:homeTeamId/:awayTeamId", async (req, res) => {
  const homeTeamId = parseInt(req.params.homeTeamId, 10);
  const awayTeamId = parseInt(req.params.awayTeamId, 10);
  if (
    Number.isNaN(homeTeamId) ||
    homeTeamId <= 0 ||
    Number.isNaN(awayTeamId) ||
    awayTeamId <= 0
  ) {
    res.status(400).json({ error: "Invalid team IDs." });
    return;
  }
  const excludeFixtureIdRaw = req.query.excludeFixtureId;
  const excludeFixtureId =
    excludeFixtureIdRaw != null && excludeFixtureIdRaw !== ""
      ? parseInt(String(excludeFixtureIdRaw), 10)
      : undefined;
  const homeTeamName =
    typeof req.query.homeTeamName === "string" && req.query.homeTeamName.trim() !== ""
      ? req.query.homeTeamName.trim()
      : undefined;
  const awayTeamName =
    typeof req.query.awayTeamName === "string" && req.query.awayTeamName.trim() !== ""
      ? req.query.awayTeamName.trim()
      : undefined;

  const cacheKey = cache.getTeamRecentFormContextCacheKey(
    homeTeamId,
    awayTeamId,
    Number.isFinite(excludeFixtureId) ? excludeFixtureId : undefined
  );
  const cached = cache.get<unknown>(cacheKey);
  if (cached != null) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[team-form] cache hit", { homeTeamId, awayTeamId, cacheKey });
    }
    return res.json({ data: cached });
  }
  const context = await fetchFixtureTeamFormContext(homeTeamId, awayTeamId, {
    excludeFixtureId: Number.isFinite(excludeFixtureId) ? excludeFixtureId : undefined,
    homeTeamName,
    awayTeamName,
  });
  const payload = { homeTeamId, awayTeamId, context };
  cache.set(cacheKey, payload, cache.getTeamRecentFormContextTtlMs());
  if (process.env.NODE_ENV !== "production") {
    console.log("[team-form] response", {
      homeTeamId,
      awayTeamId,
      fetchFailed: context.fetchFailed,
      homeN: context.home.sampleSize,
      awayN: context.away.sampleSize,
    });
  }
  res.json({ data: payload });
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

// Player tackles: not in ValueEvalMarket until season tackles + Poisson mapping match getPlayerSeasonStatsForProps.
app.post("/api/value-evaluator", async (req, res) => {
  try {
    const body = req.body as { playerName?: string; market?: ValueEvalMarket; line?: number; odds?: number };
    const playerName = String(body?.playerName ?? "").trim();
    const market = body?.market;
    const line = Number(body?.line);
    const odds = Number(body?.odds);
    if (!playerName) return res.status(400).json({ error: "playerName is required." });
    if (market !== "shots" && market !== "shotsOnTarget" && market !== "goals") {
      return res.status(400).json({ error: "market must be shots, shotsOnTarget, or goals." });
    }
    if (!Number.isFinite(line) || line < 0) return res.status(400).json({ error: "line must be a valid non-negative number." });
    if (!Number.isFinite(odds) || odds <= 1) return res.status(400).json({ error: "odds must be greater than 1." });

    const apiToken = process.env.SPORTMONKS_API_TOKEN ?? process.env.SPORTMONKS_TOKEN;
    if (!apiToken) return res.status(500).json({ error: "Sportmonks API token missing." });

    const searchUrl = `https://api.sportmonks.com/v3/football/players/search/${encodeURIComponent(playerName)}?api_token=${encodeURIComponent(apiToken)}&include=statistics`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return res.status(502).json({ error: "Failed to search player." });
    const searchJson = (await searchRes.json()) as { data?: Array<{ id?: number; display_name?: string; common_name?: string; firstname?: string; lastname?: string; statistics?: unknown[] }> };
    const candidates = Array.isArray(searchJson?.data) ? searchJson.data : [];
    if (candidates.length === 0) return res.status(404).json({ error: "Player not found." });
    const best = candidates[0];
    const playerId = Number(best?.id);
    if (!Number.isFinite(playerId) || playerId <= 0) return res.status(404).json({ error: "Player ID not found." });

    const details = await getPlayerDetails(playerId);
    const stats = Array.isArray((details as any)?.statistics)
      ? (details as any).statistics
      : Array.isArray((details as any)?.data?.statistics)
        ? (details as any).data.statistics
        : [];
    if (!Array.isArray(stats) || stats.length === 0) return res.status(404).json({ error: "No statistics available for this player." });
    const season = stats[0] as any;
    const detailsList = Array.isArray(season?.details) ? season.details : [];
    const findMetric = (names: string[]): number => {
      for (const d of detailsList) {
        const n = String(d?.type?.name ?? d?.type?.code ?? d?.type?.developer_name ?? "")
          .toLowerCase()
          .replace(/[_-]/g, " ")
          .trim();
        if (names.some((x) => x === n)) {
          const v = typeof d?.value === "number" ? d.value : typeof d?.value?.total === "number" ? d.value.total : 0;
          if (Number.isFinite(v)) return v;
        }
      }
      return 0;
    };
    const appearances = findMetric(["appearances", "appearance"]);
    const shots = findMetric(["shots", "shots total", "total shots"]);
    const shotsOnTarget = findMetric(["shots on target", "shots on goal", "on target shots"]);
    const goals = findMetric(["goals", "goals total", "goals scored"]);
    const sampleSize = Math.max(0, Math.round(appearances));
    if (sampleSize <= 0) return res.status(404).json({ error: "Insufficient sample size for evaluation." });

    const metricTotal = market === "shots" ? shots : market === "shotsOnTarget" ? shotsOnTarget : goals;
    const avgPerMatch = metricTotal / sampleSize;
    const estimatedProb = poissonAtLeast(avgPerMatch, line);
    const impliedProb = 1 / odds;
    const edge = estimatedProb - impliedProb;
    const verdict = edge > 0.05 ? "GOOD VALUE" : edge < -0.05 ? "BAD VALUE" : "NEUTRAL";
    const confidence = Math.min(100, sampleSize * 10);
    const playerLabel = String(best?.display_name ?? best?.common_name ?? `${best?.firstname ?? ""} ${best?.lastname ?? ""}`).trim() || playerName;
    res.json({
      playerId,
      playerName: playerLabel,
      market,
      line,
      odds,
      impliedProb,
      estimatedProb,
      edge,
      verdict,
      confidence,
      sampleSize,
      averageStat: avgPerMatch,
      metricTotal,
      method: "Poisson estimate from Sportmonks season totals per appearance",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to evaluate value bet.";
    res.status(500).json({ error: message });
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
    const rows = betsStore.list();
    console.log("[api/bets] GET count=", rows.length);
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
    betsStore.upsert(body);
    console.log("[api/bets] POST saved", { id: body.id, totalCount: betsStore.count() });
    io.emit("bets_updated");
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
    const updated = betsStore.patch(id, req.body as Record<string, unknown>);
    if (!updated) {
      res.status(404).json({ error: "Bet not found." });
      return;
    }
    console.log("[api/bets] PUT updated", { id, totalCount: betsStore.count() });
    io.emit("bets_updated");
    res.json(updated);
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
    const deleted = betsStore.deleteById(id);
    if (!deleted) {
      res.status(404).json({ error: "Bet not found." });
      return;
    }
    console.log("[api/bets] DELETE removed", { id, totalCount: betsStore.count() });
    io.emit("bets_updated");
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "Failed to delete bet." });
  }
});

console.log("[static-path-debug]", {
  cwd: process.cwd(),
  distDir: DIST_DIR,
  spaIndex: SPA_INDEX,
  distExists: existsSync(DIST_DIR),
  indexExists: existsSync(SPA_INDEX),
});

if (existsSync(SPA_INDEX)) {
  app.use(express.static(DIST_DIR));
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) return next();
    res.sendFile(SPA_INDEX, (err) => next(err));
  });
} else {
  app.get("/", (_req, res) => {
    res.type("text/plain").send("AIBetter API is live — run `npm run build` to serve the UI from this service.");
  });
}

httpServer.listen(PORT, "0.0.0.0", () => {
  const servingUi = existsSync(SPA_INDEX);
  console.log(
    servingUi
      ? `Server listening on 0.0.0.0:${PORT} (API + static UI from dist/)`
      : `API server listening on 0.0.0.0:${PORT}`
  );
});
