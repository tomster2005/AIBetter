import type { PlayerProfile } from "../../types/player.js";

interface PlayerCareerCardProps {
  player: PlayerProfile;
}

export function PlayerCareerCard({ player }: PlayerCareerCardProps) {
  const entries = player.careerEntries;
  if (entries.length === 0) {
    return (
      <div className="player-career-card">
        <h3 className="player-career-card__title">Career</h3>
        <p className="player-career-card__empty">Career history unavailable.</p>
      </div>
    );
  }
  return (
    <div className="player-career-card">
      <h3 className="player-career-card__title">Career</h3>
      <ul className="player-career-card__list">
        {entries.map((entry, i) => (
          <li key={i} className="player-career-card__item">
            {entry.teamLogo && <img src={entry.teamLogo} alt="" className="player-career-card__logo" />}
            <div className="player-career-card__info">
              <span className="player-career-card__team">{entry.teamName}</span>
              {(entry.season || entry.dateRange) && (
                <span className="player-career-card__meta">{entry.season ?? entry.dateRange}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
