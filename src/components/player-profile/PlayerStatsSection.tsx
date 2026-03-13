import type { PlayerProfile } from "../../types/player.js";

interface PlayerStatsSectionProps {
  player: PlayerProfile;
}

/** Safe display value: never render [object Object]. */
function statDisplayValue(value: string | number): string {
  if (value == null) return "–";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value;
  return "–";
}

export function PlayerStatsSection({ player }: PlayerStatsSectionProps) {
  const stats = player.statsSummary;
  const competitionLabel = player.statsCompetitionLabel;
  if (stats.length === 0) {
    return (
      <section className="player-stats-section">
        <h3 className="player-stats-section__title">Player statistics</h3>
        <p className="player-stats-section__empty">No statistics available.</p>
      </section>
    );
  }
  return (
    <section className="player-stats-section">
      <h3 className="player-stats-section__title">Player statistics</h3>
      {competitionLabel ? (
        <p className="player-stats-section__competition">{competitionLabel}</p>
      ) : (
        <p className="player-stats-section__competition">Available statistics</p>
      )}
      <div className="player-stats-section__grid">
        {stats.map((item, i) => (
          <div key={i} className="player-stats-section__stat">
            <span className="player-stats-section__stat-value">{statDisplayValue(item.value)}</span>
            <span className="player-stats-section__stat-label">{item.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
