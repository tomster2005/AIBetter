import type { Fixture } from "../../types/fixture.js";

interface LineupModalHeaderProps {
  fixture: Fixture | null;
  kickoff: string;
  /** Badge label when lineup data is shown; null hides badge */
  lineupStatusBadge: string | null;
  onClose: () => void;
}

function formatKickoff(startingAt: string): string {
  const part = startingAt.trim().split(/\s+/)[1];
  if (!part) return "";
  const [h, m] = part.split(":");
  return `${h}:${m ?? "00"}`;
}

export function LineupModalHeader({ fixture, kickoff, lineupStatusBadge, onClose }: LineupModalHeaderProps) {
  const displayKickoff = kickoff || (fixture ? formatKickoff(fixture.startingAt) : "");

  return (
    <header className="lineup-header">
      <h2 id="lineup-modal-title" className="lineup-header__sr-only">Lineup</h2>
      <div className="lineup-header__top">
        <div className="lineup-header__team lineup-header__team--home">
          {fixture?.homeTeam.logo && (
            <img src={fixture.homeTeam.logo} alt="" className="lineup-header__logo" />
          )}
          <span className="lineup-header__team-name">{fixture?.homeTeam.name ?? "Home"}</span>
        </div>
        <div className="lineup-header__center">
          {displayKickoff && <span className="lineup-header__kickoff">Kick-off {displayKickoff}</span>}
          {lineupStatusBadge && (
            <span className="lineup-header__badge">{lineupStatusBadge}</span>
          )}
        </div>
        <div className="lineup-header__team lineup-header__team--away">
          <span className="lineup-header__team-name">{fixture?.awayTeam.name ?? "Away"}</span>
          {fixture?.awayTeam.logo && (
            <img src={fixture.awayTeam.logo} alt="" className="lineup-header__logo" />
          )}
        </div>
      </div>
      <button type="button" className="lineup-header__close" onClick={onClose} aria-label="Close">
        ×
      </button>
    </header>
  );
}
