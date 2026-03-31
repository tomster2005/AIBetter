import type { Fixture } from "../types/fixture.js";
import { FixtureTile } from "./FixtureTile.js";
import "./LeagueSectionCard.css";

interface LeagueSectionCardProps {
  leagueId: number;
  leagueName: string;
  leagueLogo: string | null;
  fixtures: Fixture[];
  formatTime: (startingAt: string) => string;
  onFixtureClick?: (fixture: Fixture) => void;
  /** Favourite state and toggle (optional for backwards compatibility) */
  isFavourite?: boolean;
  onToggleFavourite?: (leagueId: number) => void;
  /** Collapsed by default; header click toggles */
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  fixtureSignalCounts?: Record<number, number>;
  fixtureReadiness?: Record<number, boolean>;
}

export function LeagueSectionCard({
  leagueId,
  leagueName,
  leagueLogo,
  fixtures,
  formatTime,
  onFixtureClick,
  isFavourite = false,
  onToggleFavourite,
  isExpanded = false,
  onToggleExpand,
  fixtureSignalCounts,
  fixtureReadiness,
}: LeagueSectionCardProps) {
  const fixtureCount = fixtures.length;
  const sortedFixtures = [...fixtures].sort((a, b) => {
    const ra = fixtureReadiness?.[a.id] === true ? 1 : 0;
    const rb = fixtureReadiness?.[b.id] === true ? 1 : 0;
    if (rb !== ra) return rb - ra;
    const sa = fixtureSignalCounts?.[a.id] ?? 0;
    const sb = fixtureSignalCounts?.[b.id] ?? 0;
    if (sb !== sa) return sb - sa;
    const tA = a.startingAt;
    const tB = b.startingAt;
    if (tA < tB) return -1;
    if (tA > tB) return 1;
    return a.id - b.id;
  });

  return (
    <section className="league-card" aria-label={`${leagueName} fixtures`}>
      <header
        className="league-card__header"
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-controls={`league-card-body-${leagueId}`}
        id={`league-card-header-${leagueId}`}
        onClick={onToggleExpand}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleExpand?.();
          }
        }}
      >
        <div className="league-card__header-main">
          {leagueLogo ? (
            <img src={leagueLogo} alt="" className="league-card__logo" />
          ) : (
            <span className="league-card__logo-placeholder" />
          )}
          <h2 className="league-card__title">{`${leagueName} (${fixtureCount} ${fixtureCount === 1 ? "match" : "matches"})`}</h2>
          <span className="league-card__count" aria-label={`${fixtureCount} fixtures`}>
            {fixtureCount}
          </span>
        </div>
        <div className="league-card__header-actions">
          {onToggleFavourite != null && (
            <button
              type="button"
              className={`league-card__favourite ${isFavourite ? "league-card__favourite--on" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavourite(leagueId);
              }}
              aria-label={isFavourite ? "Remove from favourites" : "Add to favourites"}
              title={isFavourite ? "Remove from favourites" : "Add to favourites"}
            >
              {isFavourite ? "★" : "☆"}
            </button>
          )}
          <span className={`league-card__chevron ${isExpanded ? "league-card__chevron--expanded" : ""}`} aria-hidden>
            ▼
          </span>
        </div>
      </header>
      <div
        id={`league-card-body-${leagueId}`}
        className="league-card__body"
        hidden={!isExpanded}
      >
        {fixtures.length === 0 ? (
          <p className="league-card__empty">No fixtures available for this competition today.</p>
        ) : (
          <div className="league-card__grid">
            {sortedFixtures.map((f) => (
              <FixtureTile
                key={f.id}
                fixture={f}
                formatTime={formatTime}
                onFixtureClick={onFixtureClick}
                signalCount={fixtureSignalCounts?.[f.id] ?? 0}
                analysisReady={fixtureReadiness?.[f.id] === true}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
