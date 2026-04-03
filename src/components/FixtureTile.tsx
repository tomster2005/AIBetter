import type { Fixture } from "../types/fixture.js";
import "./FixtureTile.css";

interface FixtureTileProps {
  fixture: Fixture;
  formatTime: (startingAt: string) => string;
  onFixtureClick?: (fixture: Fixture) => void;
  signalCount?: number;
  analysisReady?: boolean;
}

type LineupStatus = "none" | "predicted" | "confirmed";

function getLineupStatus(fixture: Fixture): LineupStatus {
  const rawLineups = (fixture as Fixture & { lineups?: unknown }).lineups;
  const lineups = Array.isArray(rawLineups)
    ? rawLineups
    : rawLineups && typeof rawLineups === "object" && "data" in rawLineups && Array.isArray((rawLineups as { data?: unknown }).data)
      ? ((rawLineups as { data?: unknown[] }).data as unknown[])
      : [];
  if (!Array.isArray(lineups) || lineups.length === 0) return "none";

  const hasOfficialFlag = lineups.some((player) => {
    if (!player || typeof player !== "object") return false;
    const row = player as { confirmed?: unknown; type?: unknown };
    const typeText = typeof row.type === "string" ? row.type.toLowerCase() : "";
    return row.confirmed === true || typeText === "starting_lineup";
  });
  if (hasOfficialFlag) return "confirmed";

  const kickoffMs = Date.parse(fixture.startingAt);
  const nowMs = Date.now();
  const minutesToKickoff = Number.isFinite(kickoffMs) ? (kickoffMs - nowMs) / (1000 * 60) : Number.POSITIVE_INFINITY;
  const isCloseToKickoff = minutesToKickoff <= 75;
  const stateId = fixture.state?.id;
  const isStarted = stateId === 2 || stateId === 5;
  if ((isCloseToKickoff || isStarted) && lineups.length > 0) return "confirmed";

  return "predicted";
}

function getCurrentScore(fixture: Fixture): string | null {
  const current = fixture.scores.filter((s) => s.description === "CURRENT");
  const home = current.find((s) => s.participant === "home")?.goals;
  const away = current.find((s) => s.participant === "away")?.goals;
  if (home === undefined && away === undefined) return null;
  return `${home ?? "-"}–${away ?? "-"}`;
}

function isLive(state: Fixture["state"]): boolean {
  const s = (state.nameShort ?? state.name ?? "").toUpperCase();
  if (!s || s === "FT" || s === "NS" || s === "AET" || s === "FT_PEN") return false;
  return true;
}

export function FixtureTile({
  fixture,
  formatTime,
  onFixtureClick,
  signalCount = 0,
  analysisReady: _analysisReady = false,
}: FixtureTileProps) {
  const score = getCurrentScore(fixture);
  const showScore = score !== null;
  const live = isLive(fixture.state);
  const isClickable = Boolean(onFixtureClick);
  const hasSignalBadges = live || (!showScore && fixture.state?.nameShort && fixture.state.nameShort !== "NS");
  const hasValueSignal = signalCount > 0;

  const lineupStatus = getLineupStatus(fixture);
  const lineupStatusLabel =
    lineupStatus === "confirmed"
      ? "Confirmed lineups"
      : lineupStatus === "predicted"
        ? "Predicted lineups"
        : "No lineups";

  const content = (
    <>
      <div className="fixture-tile__row fixture-tile__row--home">
        <span className="fixture-tile__logo-wrap">
          {fixture.homeTeam.logo ? (
            <img
              src={fixture.homeTeam.logo}
              alt=""
              className="fixture-tile__logo"
            />
          ) : (
            <span className="fixture-tile__logo-placeholder" />
          )}
        </span>
        <span className="fixture-tile__team-name">{fixture.homeTeam.name}</span>
      </div>
      <div className="fixture-tile__row fixture-tile__row--away">
        <span className="fixture-tile__logo-wrap">
          {fixture.awayTeam.logo ? (
            <img
              src={fixture.awayTeam.logo}
              alt=""
              className="fixture-tile__logo"
            />
          ) : (
            <span className="fixture-tile__logo-placeholder" />
          )}
        </span>
        <span className="fixture-tile__team-name">{fixture.awayTeam.name}</span>
      </div>
      {hasSignalBadges && (
        <div className="fixture-tile__signals">
          {live && <span className="fixture-tile__signal fixture-tile__signal--live">Live</span>}
          {!live && !showScore && fixture.state?.nameShort && fixture.state.nameShort !== "NS" && (
            <span className="fixture-tile__signal">{fixture.state.nameShort}</span>
          )}
        </div>
      )}
      <div className="fixture-tile__right">
        {showScore ? (
          <span className="fixture-tile__score">{score}</span>
        ) : (
          <span className="fixture-tile__time">{formatTime(fixture.startingAt)}</span>
        )}
        <span
          className={`fixture-tile__readiness ${
            lineupStatus === "confirmed"
              ? "fixture-tile__readiness--confirmed"
              : lineupStatus === "predicted"
                ? "fixture-tile__readiness--predicted"
                : "fixture-tile__readiness--none"
          }`}
        >
          {lineupStatusLabel}
        </span>
        {hasValueSignal && (
          <span className="fixture-tile__value-badge" title={`${signalCount} value bet${signalCount === 1 ? "" : "s"}`}>
            🔥 {signalCount} value bet{signalCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </>
  );

  if (isClickable && onFixtureClick) {
    const className = `fixture-tile fixture-tile--clickable${hasValueSignal ? " fixture-tile--signal" : ""}`;
    return (
      <button
        type="button"
        className={className}
        onClick={() => onFixtureClick(fixture)}
      >
        {content}
      </button>
    );
  }
  return <div className="fixture-tile">{content}</div>;
}
