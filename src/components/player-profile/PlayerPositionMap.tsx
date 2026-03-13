import type { PlayerProfile } from "../../types/player.js";

interface PlayerPositionMapProps {
  player: PlayerProfile;
}

/** Small pitch graphic with position hint. Position names map roughly to pitch zones. */
export function PlayerPositionMap({ player }: PlayerPositionMapProps) {
  const position = player.detailedPosition || player.position || "–";
  return (
    <div className="player-position-map">
      <h3 className="player-position-map__title">Position</h3>
      <div className="player-position-map__pitch" aria-hidden>
        <div className="player-position-map__field">
          <span className="player-position-map__position-label">{position}</span>
        </div>
      </div>
    </div>
  );
}
