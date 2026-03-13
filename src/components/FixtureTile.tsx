import type { Fixture } from "../types/fixture.js";
import "./FixtureTile.css";

interface FixtureTileProps {
  fixture: Fixture;
  formatTime: (startingAt: string) => string;
  onFixtureClick?: (fixture: Fixture) => void;
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

export function FixtureTile({ fixture, formatTime, onFixtureClick }: FixtureTileProps) {
  const score = getCurrentScore(fixture);
  const showScore = score !== null;
  const live = isLive(fixture.state);
  const isClickable = Boolean(onFixtureClick);

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
      <div className="fixture-tile__right">
        {live && <span className="fixture-tile__live">Live</span>}
        {showScore ? (
          <span className="fixture-tile__score">{score}</span>
        ) : (
          <span className="fixture-tile__time">{formatTime(fixture.startingAt)}</span>
        )}
      </div>
    </>
  );

  if (isClickable && onFixtureClick) {
    return (
      <button
        type="button"
        className="fixture-tile fixture-tile--clickable"
        onClick={() => onFixtureClick(fixture)}
      >
        {content}
      </button>
    );
  }
  return <div className="fixture-tile">{content}</div>;
}
