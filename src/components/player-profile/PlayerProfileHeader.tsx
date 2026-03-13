import type { PlayerProfile } from "../../types/player.js";

interface PlayerProfileHeaderProps {
  player: PlayerProfile;
}

export function PlayerProfileHeader({ player }: PlayerProfileHeaderProps) {
  return (
    <header className="player-profile-header">
      <div className="player-profile-header__photo-wrap">
        {player.image ? (
          <img src={player.image} alt="" className="player-profile-header__photo" />
        ) : (
          <div className="player-profile-header__photo-placeholder" />
        )}
      </div>
      <div className="player-profile-header__main">
        <h2 className="player-profile-header__name">{player.displayName || player.name}</h2>
        {player.teamName && player.teamName !== "–" && (
          <p className="player-profile-header__team">{player.teamName}</p>
        )}
        <div className="player-profile-header__meta">
          {player.nationality && <span className="player-profile-header__nationality">{player.nationality}</span>}
          {player.nationalityFlag && (
            <img src={player.nationalityFlag} alt="" className="player-profile-header__flag" aria-hidden />
          )}
        </div>
      </div>
      {player.shirtNumber != null && (
        <div className="player-profile-header__number" aria-label={`Shirt number ${player.shirtNumber}`}>
          {player.shirtNumber}
        </div>
      )}
    </header>
  );
}
