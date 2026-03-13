import type { PlayerProfile } from "../../types/player.js";

interface PlayerInfoCardProps {
  player: PlayerProfile;
}

function row(label: string, value: string | number | null | undefined) {
  if (value == null || value === "") return null;
  return (
    <div key={label} className="player-info-card__row">
      <span className="player-info-card__label">{label}</span>
      <span className="player-info-card__value">{value}</span>
    </div>
  );
}

export function PlayerInfoCard({ player }: PlayerInfoCardProps) {
  const heightStr = player.height != null ? `${player.height} cm` : null;
  const weightStr = player.weight != null ? `${player.weight} kg` : null;
  return (
    <div className="player-info-card">
      <h3 className="player-info-card__title">Info</h3>
      <div className="player-info-card__body">
        {row("Height", heightStr)}
        {row("Weight", weightStr)}
        {row("Age", player.age)}
        {row("Date of birth", player.dateOfBirth)}
        {row("Preferred foot", player.preferredFoot)}
        {row("Country", player.nationality)}
        {row("Position", player.position)}
        {row("Detailed position", player.detailedPosition)}
      </div>
    </div>
  );
}
