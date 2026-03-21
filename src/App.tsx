import { useState, useEffect, type FormEvent } from "react";
import { CalendarPage } from "./pages/CalendarPage.js";
import { BetHistoryPage } from "./pages/BetHistoryPage.js";
import { BetTrackerPage } from "./pages/BetTrackerPage.js";
import { setCalibrationTable } from "./lib/valueBetCalibration.js";
import type { CalibrationBucket } from "./lib/valueBetCalibration.js";
import "./App.css";

type AppTab = "calendar" | "betTracker" | "betHistory";

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>("calendar");
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

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
        <button
          type="button"
          className={`app-nav__tab ${activeTab === "betHistory" ? "app-nav__tab--active" : ""}`}
          onClick={() => setActiveTab("betHistory")}
        >
          Bet History
        </button>
        <button type="button" className="app-nav__tab app-nav__logout" onClick={handleLogout}>
          Log out
        </button>
      </nav>
      <main className="app-main">
        {activeTab === "calendar" && <CalendarPage />}
        {activeTab === "betTracker" && <BetTrackerPage />}
        {activeTab === "betHistory" && <BetHistoryPage />}
      </main>
    </div>
  );
}
