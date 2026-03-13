import { PlayerPositionCard } from "./PlayerPositionCard.js";

export type PitchPlayer = {
  player_id?: number;
  team_id?: number;
  player_name?: string;
  jersey_number?: number | null;
  formation_field?: string | null;
  formation_position?: number | null;
  image_url?: string | null;
  position_id?: number | null;
};

function parseFormationField(field: string | null | undefined): { row: number; col: number } | null {
  if (field == null || typeof field !== "string") return null;
  const parts = field.trim().split(":");
  if (parts.length !== 2) return null;
  const row = parseInt(parts[0], 10);
  const col = parseInt(parts[1], 10);
  if (Number.isNaN(row) || Number.isNaN(col)) return null;
  return { row, col };
}

/** Group players by formation row; each row sorted by col. */
function groupByFormationRows(players: PitchPlayer[]): Map<number, PitchPlayer[]> {
  const byRow = new Map<number, PitchPlayer[]>();
  for (const p of players) {
    const pos = parseFormationField(p.formation_field);
    if (!pos) continue;
    let row = byRow.get(pos.row);
    if (!row) {
      row = [];
      byRow.set(pos.row, row);
    }
    row.push(p);
  }
  for (const row of byRow.values()) {
    row.sort((a, b) => {
      const ac = parseFormationField(a.formation_field)?.col ?? 0;
      const bc = parseFormationField(b.formation_field)?.col ?? 0;
      return ac - bc;
    });
  }
  return byRow;
}

/** Home: GK at top (row 1), forwards near center (highest row at bottom). Order rows 1, 2, 3, ... */
function getOrderedRowsHome(byRow: Map<number, PitchPlayer[]>): number[] {
  return Array.from(byRow.keys()).sort((a, b) => a - b);
}

/** Away: forwards near center (top of their half), GK at bottom. Order rows descending: n, n-1, ..., 1. */
function getOrderedRowsAway(byRow: Map<number, PitchPlayer[]>): number[] {
  return Array.from(byRow.keys()).sort((a, b) => b - a);
}

function FormationRows({
  players,
  isHome,
  teamName,
  onPlayerClick,
}: {
  players: PitchPlayer[];
  isHome: boolean;
  teamName?: string;
  onPlayerClick?: (playerId: number, teamName?: string) => void;
}) {
  const byRow = groupByFormationRows(players);
  if (byRow.size === 0) {
    return (
      <div className="pitch-half__list">
        {players.map((p, i) => (
          <div key={i} className="pitch-half__list-item">
            <PlayerPositionCard
              jerseyNumber={p.jersey_number}
              playerName={p.player_name ?? "–"}
              imageUrl={p.image_url}
              role={p.position_id === 1 ? "goalkeeper" : undefined}
              playerId={p.player_id}
              teamName={teamName}
              onPlayerClick={onPlayerClick}
            />
          </div>
        ))}
      </div>
    );
  }

  const orderedRows = isHome ? getOrderedRowsHome(byRow) : getOrderedRowsAway(byRow);

  return (
    <>
      {orderedRows.map((rowNum) => {
        const rowPlayers = byRow.get(rowNum) ?? [];
        return (
          <div key={rowNum} className="pitch-half__formation-row">
            {rowPlayers.map((p, i) => {
              const isGK = p.position_id === 1;
              return (
                <div key={i} className="pitch-half__player-cell">
                  <PlayerPositionCard
                    jerseyNumber={p.jersey_number}
                    playerName={p.player_name ?? "–"}
                    imageUrl={p.image_url}
                    role={isGK ? "goalkeeper" : undefined}
                    playerId={p.player_id}
                    teamName={teamName}
                    onPlayerClick={onPlayerClick}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

interface PitchLineupViewProps {
  homePlayers: PitchPlayer[];
  awayPlayers: PitchPlayer[];
  homeTeamName?: string;
  awayTeamName?: string;
  onPlayerClick?: (playerId: number, teamName?: string) => void;
}

export function PitchLineupView({ homePlayers, awayPlayers, homeTeamName, awayTeamName, onPlayerClick }: PitchLineupViewProps) {
  return (
    <div className="pitch-view">
      <div className="pitch pitch-view__surface">
        <div className="pitch-half pitch-half--home home-team">
          <FormationRows players={homePlayers} isHome teamName={homeTeamName} onPlayerClick={onPlayerClick} />
        </div>
        <div className="pitch-view__divider" aria-hidden="true" />
        <div className="pitch-half pitch-half--away away-team">
          <FormationRows players={awayPlayers} isHome={false} teamName={awayTeamName} onPlayerClick={onPlayerClick} />
        </div>
      </div>
    </div>
  );
}
