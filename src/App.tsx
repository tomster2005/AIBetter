import { useState, useEffect, useMemo, type FormEvent } from "react";
import { CalendarPage } from "./pages/CalendarPage.js";
import { BetTrackerPage } from "./pages/BetTrackerPage.js";
import { setCalibrationTable } from "./lib/valueBetCalibration.js";
import type { CalibrationBucket } from "./lib/valueBetCalibration.js";
import { getAllBookmakerStats, getTrackedBetStats, getTrackedBets } from "./services/betTrackerService.js";
import "./App.css";

type AppTab = "calendar" | "betTracker";

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>("calendar");
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [sidebarTick, setSidebarTick] = useState(0);

  useEffect(() => {
    const onStorage = () => setSidebarTick((v) => v + 1);
    const onTrackerEvent = () => setSidebarTick((v) => v + 1);
    window.addEventListener("storage", onStorage);
    window.addEventListener("app:tracker-updated", onTrackerEvent as EventListener);
    const t = window.setInterval(() => setSidebarTick((v) => v + 1), 5000);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("app:tracker-updated", onTrackerEvent as EventListener);
      window.clearInterval(t);
    };
  }, []);

  const quickStats = useMemo(() => {
    try {
      const tracker = getTrackedBetStats();
      const books = getAllBookmakerStats();
      const bets = getTrackedBets();
      const bankroll = books.reduce((sum, b) => sum + (Number.isFinite(b.currentBalance) ? b.currentBalance : 0), 0);
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const todayStartMs = startOfToday.getTime();
      const todayProfit = bets.reduce((sum, b) => {
        const createdMs = Date.parse(b.createdAt);
        if (!Number.isFinite(createdMs) || createdMs < todayStartMs) return sum;
        if (b.status === "win") return sum + (b.returnAmount - b.stake);
        if (b.status === "loss") return sum - b.stake;
        return sum;
      }, 0);
      return {
        bankroll,
        todayProfit,
        totalProfit: tracker.totalProfit,
        openBets: tracker.pendingBets,
        totalBets: tracker.totalBets,
      };
    } catch {
      return {
        bankroll: null as number | null,
        todayProfit: null as number | null,
        totalProfit: null as number | null,
        openBets: null as number | null,
        totalBets: null as number | null,
      };
    }
  }, [sidebarTick]);

  const fmtMoney = (n: number | null): string => {
    if (n == null || !Number.isFinite(n)) return "—";
    return `£${Math.abs(n).toFixed(2)}`;
  };

  const fmtSignedMoney = (n: number | null): string => {
    if (n == null || !Number.isFinite(n)) return "—";
    if (n === 0) return "£0.00";
    return `${n > 0 ? "+" : "-"}£${Math.abs(n).toFixed(2)}`;
  };

  const emit = (name: string) => window.dispatchEvent(new CustomEvent(name));

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : { authenticated: false }))
      .then((data: { authenticated?: boolean }) => {
        setAuthenticated(data?.authenticated === true);
      })
      .catch(() => setAuthenticated(false))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    fetch("/calibration.json")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { calibrationTable?: CalibrationBucket[] } | null) => {
        if (data?.calibrationTable && Array.isArray(data.calibrationTable)) {
          setCalibrationTable(data.calibrationTable);
        }
      })
      .catch(() => {});
  }, [authenticated]);

  async function handleLogin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || "Login failed.");
      }
      setAuthenticated(true);
      setPassword("");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    setAuthenticated(false);
  }

  if (!authChecked) {
    return <div className="auth-screen">Checking session...</div>;
  }

  if (!authenticated) {
    return (
      <div className="auth-screen">
        <form className="auth-card" onSubmit={handleLogin}>
          <h1>AIBetter Login</h1>
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {authError ? <p className="auth-error">{authError}</p> : null}
          <button type="submit" disabled={authBusy}>
            {authBusy ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <nav className="app-nav" aria-label="Main">
        <div className="app-nav__group">
          <button
            type="button"
            className={`app-nav__tab ${activeTab === "calendar" ? "app-nav__tab--active" : ""}`}
            onClick={() => setActiveTab("calendar")}
          >
            Calendar
          </button>
          <button
            type="button"
            className={`app-nav__tab ${activeTab === "betTracker" ? "app-nav__tab--active" : ""}`}
            onClick={() => setActiveTab("betTracker")}
          >
            Bet Tracker
          </button>
        </div>

        <section className="app-nav__panel app-nav__panel--stats" aria-label="Quick Stats">
          <h3 className="app-nav__panel-title">Quick Stats</h3>
          <div className="app-nav__stat-row"><span>Bankroll</span><strong>{fmtMoney(quickStats.bankroll)}</strong></div>
          <div className="app-nav__stat-row">
            <span>Today P/L</span>
            <strong className={quickStats.todayProfit != null ? (quickStats.todayProfit > 0 ? "app-nav__value--profit" : quickStats.todayProfit < 0 ? "app-nav__value--loss" : "") : ""}>
              {fmtSignedMoney(quickStats.todayProfit)}
            </strong>
          </div>
          <div className="app-nav__stat-row">
            <span>Total P/L</span>
            <strong className={quickStats.totalProfit != null ? (quickStats.totalProfit > 0 ? "app-nav__value--profit" : quickStats.totalProfit < 0 ? "app-nav__value--loss" : "") : ""}>
              {fmtSignedMoney(quickStats.totalProfit)}
            </strong>
          </div>
          <div className="app-nav__stat-row"><span>Open Bets</span><strong>{quickStats.openBets ?? "—"}</strong></div>
          <div className="app-nav__stat-row"><span>Total Bets</span><strong>{quickStats.totalBets ?? "—"}</strong></div>
        </section>

        <section className="app-nav__panel app-nav__panel--actions" aria-label="Quick Actions">
          <h3 className="app-nav__panel-title">Quick Actions</h3>
          <button
            type="button"
            className="app-nav__quick-btn"
            onClick={() => {
              setActiveTab("betTracker");
              emit("app:quick-add-bet");
            }}
          >
            ➕ Add Bet
          </button>
          <button
            type="button"
            className="app-nav__quick-btn"
            onClick={() => {
              setActiveTab("betTracker");
              emit("app:scroll-insights");
            }}
          >
            📊 Insights
          </button>
          <button
            type="button"
            className="app-nav__quick-btn"
            onClick={() => {
              setActiveTab("calendar");
              emit("app:calendar-today");
            }}
          >
            📅 Back to Today
          </button>
        </section>

        <button type="button" className="app-nav__tab app-nav__logout" onClick={handleLogout}>
          Log out
        </button>
      </nav>
      <main className="app-main">
        {activeTab === "calendar" && <CalendarPage />}
        {activeTab === "betTracker" && <BetTrackerPage />}
      </main>
    </div>
  );
}
