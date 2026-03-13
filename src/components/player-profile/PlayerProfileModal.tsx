import { useEffect, useState } from "react";
import type { PlayerProfile } from "../../types/player.js";
import { fetchPlayerProfile } from "../../api/playerProfile.js";
import { PlayerProfileHeader } from "./PlayerProfileHeader.js";
import { PlayerPositionMap } from "./PlayerPositionMap.js";
import { PlayerInfoCard } from "./PlayerInfoCard.js";
import { PlayerCareerCard } from "./PlayerCareerCard.js";
import { PlayerStatsSection } from "./PlayerStatsSection.js";
import "./PlayerProfileModal.css";

interface PlayerProfileModalProps {
  open: boolean;
  playerId: number | null;
  onClose: () => void;
  /** League name from fixture (e.g. Premier League) for season-filtered stats. */
  leagueName?: string | null;
  /** Team name from lineup context for debug. */
  teamName?: string | null;
}

export function PlayerProfileModal({ open, playerId, onClose, leagueName, teamName }: PlayerProfileModalProps) {
  const [player, setPlayer] = useState<PlayerProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || playerId == null || playerId <= 0) {
      setPlayer(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setPlayer(null);
    fetchPlayerProfile(playerId, {
      leagueName: leagueName ?? undefined,
      teamName: teamName ?? undefined,
    })
      .then(setPlayer)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load player"))
      .finally(() => setLoading(false));
  }, [open, playerId, leagueName, teamName]);

  if (!open) return null;

  return (
    <div
      className="player-profile-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="player-profile-title"
    >
      <div className="player-profile-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="player-profile-modal__close" onClick={onClose} aria-label="Close">
          ×
        </button>
        {loading && <p className="player-profile-modal__message">Loading…</p>}
        {error && <p className="player-profile-modal__message player-profile-modal__message--error">{error}</p>}
        {player && !loading && !error && (
          <>
            <h2 id="player-profile-title" className="player-profile-modal__sr-only">Player profile</h2>
            <PlayerProfileHeader player={player} />
            <div className="player-profile-modal__grid">
              <PlayerPositionMap player={player} />
              <PlayerInfoCard player={player} />
              <PlayerCareerCard player={player} />
            </div>
            <PlayerStatsSection player={player} />
          </>
        )}
      </div>
    </div>
  );
}
