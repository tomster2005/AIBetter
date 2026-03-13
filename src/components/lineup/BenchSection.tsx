import { PlayerPositionCard } from "./PlayerPositionCard.js";

export type BenchPlayer = {
  player_id?: number;
  team_id?: number;
  player_name?: string;
  jersey_number?: number | null;
  image_url?: string | null;
};

interface BenchSectionProps {
  homeSubs: BenchPlayer[];
  awaySubs: BenchPlayer[];
  homeTeamName: string;
  awayTeamName: string;
  onPlayerClick?: (playerId: number, teamName?: string) => void;
}

function BenchColumn({
  players,
  teamName,
  onPlayerClick,
}: {
  players: BenchPlayer[];
  teamName: string;
  onPlayerClick?: (playerId: number, teamName?: string) => void;
}) {
  return (
    <div className="bench-column">
      <h4 className="bench-column__title">{teamName}</h4>
      <div className="bench-column__list">
        {players.map((p, i) => (
          <div key={i} className="bench-column__item">
            <PlayerPositionCard
              jerseyNumber={p.jersey_number}
              playerName={p.player_name ?? "–"}
              imageUrl={p.image_url}
              playerId={p.player_id}
              teamName={teamName}
              onPlayerClick={onPlayerClick}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function BenchSection({ homeSubs, awaySubs, homeTeamName, awayTeamName, onPlayerClick }: BenchSectionProps) {
  const hasAny = homeSubs.length > 0 || awaySubs.length > 0;
  if (!hasAny) return null;

  return (
    <section className="bench-section" aria-label="Substitutes">
      <h3 className="bench-section__heading">Substitutes</h3>
      <div className="bench-section__columns">
        <BenchColumn players={homeSubs} teamName={homeTeamName} onPlayerClick={onPlayerClick} />
        <BenchColumn players={awaySubs} teamName={awayTeamName} onPlayerClick={onPlayerClick} />
      </div>
    </section>
  );
}
