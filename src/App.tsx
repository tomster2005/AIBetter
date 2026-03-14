import { useState, useEffect } from "react";
import { CalendarPage } from "./pages/CalendarPage.js";
import { OddsPage } from "./pages/OddsPage.js";
import { setCalibrationTable } from "./lib/valueBetCalibration.js";
import type { CalibrationBucket } from "./lib/valueBetCalibration.js";
import "./App.css";

type AppTab = "calendar" | "odds";

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
          className={`app-nav__tab ${activeTab === "odds" ? "app-nav__tab--active" : ""}`}
          onClick={() => setActiveTab("odds")}
        >
          Odds
        </button>
      </nav>
      <main className="app-main">
        {activeTab === "calendar" && <CalendarPage />}
        {activeTab === "odds" && <OddsPage />}
      </main>
    </div>
  );
}
