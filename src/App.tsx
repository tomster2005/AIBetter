import { useState } from "react";
import { CalendarPage } from "./pages/CalendarPage.js";
import { OddsPage } from "./pages/OddsPage.js";
import "./App.css";

type AppTab = "calendar" | "odds";

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>("calendar");

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
