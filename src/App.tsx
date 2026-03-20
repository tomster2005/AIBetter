import { useState, useEffect } from "react";
import { CalendarPage } from "./pages/CalendarPage.js";
import { BetHistoryPage } from "./pages/BetHistoryPage.js";
import { BetTrackerPage } from "./pages/BetTrackerPage.js";
import { setCalibrationTable } from "./lib/valueBetCalibration.js";
import type { CalibrationBucket } from "./lib/valueBetCalibration.js";
import "./App.css";

type AppTab = "calendar" | "betTracker" | "betHistory";

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>("calendar");

  useEffect(() => {
    fetch("/calibration.json")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { calibrationTable?: CalibrationBucket[] } | null) => {
        if (data?.calibrationTable && Array.isArray(data.calibrationTable)) {
          setCalibrationTable(data.calibrationTable);
        }
      })
      .catch(() => {});
  }, []);

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
      </nav>
      <main className="app-main">
        {activeTab === "calendar" && <CalendarPage />}
        {activeTab === "betTracker" && <BetTrackerPage />}
        {activeTab === "betHistory" && <BetHistoryPage />}
      </main>
    </div>
  );
}
