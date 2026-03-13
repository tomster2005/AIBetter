interface PlayerPositionCardProps {
  jerseyNumber?: number | null;
  playerName: string;
  imageUrl?: string | null;
  role?: "captain" | "goalkeeper" | null;
  /** When set, card is clickable and opens player profile */
  playerId?: number | null;
  /** Team name from lineup context (for profile request debug). */
  teamName?: string | null;
  onPlayerClick?: (playerId: number, teamName?: string) => void;
}

export function PlayerPositionCard({ jerseyNumber, playerName, imageUrl, role, playerId, teamName, onPlayerClick }: PlayerPositionCardProps) {
  const isClickable = playerId != null && playerId > 0 && onPlayerClick;
  const handleClick = () => {
    if (isClickable && playerId != null) onPlayerClick(playerId, teamName ?? undefined);
  };

  const content = (
    <>
      <div className="player-card__image-wrap">
        {imageUrl ? (
          <img src={imageUrl} alt="" className="player-card__image" />
        ) : (
          <div className="player-card__placeholder" />
        )}
      </div>
      <div className="player-card__number">{jerseyNumber != null ? jerseyNumber : "–"}</div>
      <div className="player-card__name" title={playerName}>{playerName || "–"}</div>
      {role && <span className={`player-card__role player-card__role--${role}`}>{role === "goalkeeper" ? "GK" : "C"}</span>}
    </>
  );

  if (isClickable) {
    return (
      <button type="button" className="player-card player-card--clickable" onClick={handleClick} aria-label={`View profile for ${playerName || "player"}`}>
        {content}
      </button>
    );
  }
  return <div className="player-card">{content}</div>;
}
