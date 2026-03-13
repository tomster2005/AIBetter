import { useState, useEffect } from "react";
import type { Fixture } from "../types/fixture.js";
import type { FixtureLineup } from "../api/fixture-details-types.js";
import type { RawLineupEntry } from "../api/fixture-details-types.js";
import {
  LineupModalHeader,
  TeamFormationHeader,
  ManagerCard,
  PitchLineupView,
  BenchSection,
} from "./lineup/index.js";
import type { PitchPlayer } from "./lineup/index.js";
import type { BenchPlayer } from "./lineup/index.js";
import { PlayerProfileModal } from "./player-profile/index.js";
import "./LineupModal.css";

interface LineupModalProps {
  open: boolean;
  onClose: () => void;
  fixture: Fixture | null;
  loading: boolean;
  error: string | null;
  lineup: FixtureLineup | null;
  formations?: { home?: string; away?: string };
  /** Optional coach/manager info when available from fixture details */
  coaches?: {
    home?: { name?: string | null; image?: string | null };
    away?: { name?: string | null; image?: string | null };
  };
}

function formatKickoff(startingAt: string): string {
  const part = startingAt.trim().split(/\s+/)[1];
  if (!part) return "";
  const [h, m] = part.split(":");
  return `${h}:${m ?? "00"}`;
}

/** type_id 11 = starting XI in Sportmonks */
const TYPE_ID_STARTER = 11;

function getPlayerImage(entry: RawLineupEntry): string | null {
  const player = entry.player as { image_path?: string } | undefined;
  if (player?.image_path && typeof player.image_path === "string") return player.image_path;
  const path = entry.image_path ?? entry.image;
  if (path != null && typeof path === "string") return path;
  return null;
}

function splitStartersAndSubs(
  entries: RawLineupEntry[],
  homeTeamId: number,
  awayTeamId: number
): {
  homeStarters: PitchPlayer[];
  awayStarters: PitchPlayer[];
  homeSubs: BenchPlayer[];
  awaySubs: BenchPlayer[];
} {
  const homeStarters: PitchPlayer[] = [];
  const awayStarters: PitchPlayer[] = [];
  const homeSubs: BenchPlayer[] = [];
  const awaySubs: BenchPlayer[] = [];

  for (const e of entries) {
    const tid = e.team_id ?? 0;
    const isStarter = e.type_id === TYPE_ID_STARTER || e.type_id == null;
    const base = {
      player_name: e.player_name,
      jersey_number: e.jersey_number,
      image_url: getPlayerImage(e),
      player_id: e.player_id,
    };
    const pitchPlayer: PitchPlayer = {
      ...base,
      team_id: tid,
      formation_field: e.formation_field,
      formation_position: e.formation_position,
      position_id: e.position_id,
    };
    const benchPlayer: BenchPlayer = { ...base, team_id: tid };

    if (tid === homeTeamId) {
      if (isStarter) homeStarters.push(pitchPlayer);
      else homeSubs.push(benchPlayer);
    } else if (tid === awayTeamId) {
      if (isStarter) awayStarters.push(pitchPlayer);
      else awaySubs.push(benchPlayer);
    }
  }

  homeStarters.sort((a, b) => (a.formation_position ?? 99) - (b.formation_position ?? 99));
  awayStarters.sort((a, b) => (a.formation_position ?? 99) - (b.formation_position ?? 99));

  return { homeStarters, awayStarters, homeSubs, awaySubs };
}

function hasPositionalData(entries: RawLineupEntry[]): boolean {
  return entries.some((e) => {
    const f = e.formation_field;
    return f != null && String(f).trim() !== "";
  });
}

function LineupContent({
  fixture,
  loading,
  error,
  lineup,
  formations,
  coaches,
  onPlayerClick,
}: {
  fixture: Fixture | null;
  loading: boolean;
  error: string | null;
  lineup: FixtureLineup | null;
  formations?: { home?: string; away?: string };
  coaches?: LineupModalProps["coaches"];
  onPlayerClick?: (playerId: number, teamName?: string) => void;
}) {
  if (loading) return <p className="lineup-modal__message">Loading…</p>;
  if (error) return <p className="lineup-modal__message lineup-modal__message--error">{error}</p>;
  // Only show "not released" when there is no lineup data at all (no entries to render).
  const entries = lineup ? (lineup.data as RawLineupEntry[]) : [];
  if (!lineup || entries.length === 0) {
    return <p className="lineup-modal__message">Official lineups not released yet.</p>;
  }
  const homeId = fixture?.homeTeam.id ?? 0;
  const awayId = fixture?.awayTeam.id ?? 0;
  const { homeStarters, awayStarters, homeSubs, awaySubs } = splitStartersAndSubs(
    entries,
    homeId,
    awayId
  );
  const usePitch = hasPositionalData(entries) && (homeStarters.length > 0 || awayStarters.length > 0);

  return (
    <div className="lineup-content lineup-content--spaced">
      <TeamFormationHeader
        fixture={fixture}
        homeFormation={formations?.home}
        awayFormation={formations?.away}
      />
      <div className="lineup-content__managers">
        <ManagerCard
          name={coaches?.home?.name ?? "Manager unavailable"}
          imageUrl={coaches?.home?.image}
          side="home"
        />
        <ManagerCard
          name={coaches?.away?.name ?? "Manager unavailable"}
          imageUrl={coaches?.away?.image}
          side="away"
        />
      </div>
      {usePitch ? (
        <PitchLineupView
          homePlayers={homeStarters}
          awayPlayers={awayStarters}
          homeTeamName={fixture?.homeTeam.name ?? "Home"}
          awayTeamName={fixture?.awayTeam.name ?? "Away"}
          onPlayerClick={onPlayerClick}
        />
      ) : (
        <div className="lineup-content__teams-fallback">
          <div className="lineup-content__team-block">
            <div className="lineup-content__team-header">
              {fixture?.homeTeam.logo && (
                <img src={fixture.homeTeam.logo} alt="" className="lineup-content__team-logo" />
              )}
              <span className="lineup-content__team-name">{fixture?.homeTeam.name ?? "Home"}</span>
            </div>
            <div className="lineup-content__player-list">
              {homeStarters.map((p, i) => (
                <div key={i} className="lineup-content__player-row">
                  <span className="lineup-content__jersey">{p.jersey_number ?? "–"}</span>
                  <span className="lineup-content__name">{p.player_name ?? "–"}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="lineup-content__team-block">
            <div className="lineup-content__team-header">
              {fixture?.awayTeam.logo && (
                <img src={fixture.awayTeam.logo} alt="" className="lineup-content__team-logo" />
              )}
              <span className="lineup-content__team-name">{fixture?.awayTeam.name ?? "Away"}</span>
            </div>
            <div className="lineup-content__player-list">
              {awayStarters.map((p, i) => (
                <div key={i} className="lineup-content__player-row">
                  <span className="lineup-content__jersey">{p.jersey_number ?? "–"}</span>
                  <span className="lineup-content__name">{p.player_name ?? "–"}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <BenchSection
        homeSubs={homeSubs}
        awaySubs={awaySubs}
        homeTeamName={fixture?.homeTeam.name ?? "Home"}
        awayTeamName={fixture?.awayTeam.name ?? "Away"}
        onPlayerClick={onPlayerClick}
      />
    </div>
  );
}

export function LineupModal({
  open,
  onClose,
  fixture,
  loading,
  error,
  lineup,
  formations,
  coaches,
}: LineupModalProps) {
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);
  const [selectedTeamName, setSelectedTeamName] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedPlayerId(null);
      setSelectedTeamName(null);
    }
  }, [open]);

  const handlePlayerClick = (playerId: number, teamName?: string) => {
    setSelectedPlayerId(playerId);
    setSelectedTeamName(teamName ?? null);
  };

  if (!open) return null;

  const kickoff = fixture ? formatKickoff(fixture.startingAt) : "";
  /**
   * Badge: "Released" only when metadata lineup_confirmed is true.
   * Otherwise when lineup array exists show "Lineups available" or "Unconfirmed lineup data".
   */
  const lineupStatusBadge =
    lineup == null
      ? null
      : lineup.lineupConfirmed === true
        ? "Released"
        : lineup.lineupConfirmed === false
          ? "Unconfirmed lineup data"
          : "Lineups available";

  if (import.meta.env.DEV && fixture) {
    const lineupExists = lineup != null && Array.isArray(lineup.data) && lineup.data.length > 0;
    console.log("[lineup] modal status", {
      fixtureId: fixture.id,
      lineupExists,
      lineupCount: lineup?.data?.length ?? 0,
      lineupConfirmed: lineup?.lineupConfirmed,
      finalBadgeShown: lineupStatusBadge,
      pitchRendered: lineupExists && !loading && !error,
    });
  }

  return (
    <>
      <div
        className="lineup-modal__overlay"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lineup-modal-title"
      >
        <div className="lineup-modal" onClick={(e) => e.stopPropagation()}>
          <LineupModalHeader
            fixture={fixture}
            kickoff={kickoff}
            lineupStatusBadge={lineupStatusBadge}
            onClose={onClose}
          />
          <div className="lineup-modal__body">
            <LineupContent
              fixture={fixture}
              loading={loading}
              error={error}
              lineup={lineup}
              formations={formations}
              coaches={coaches}
              onPlayerClick={handlePlayerClick}
            />
          </div>
        </div>
      </div>
      <PlayerProfileModal
        open={selectedPlayerId != null}
        playerId={selectedPlayerId}
        onClose={() => {
          setSelectedPlayerId(null);
          setSelectedTeamName(null);
        }}
        leagueName={fixture?.league.name}
        teamName={selectedTeamName}
      />
    </>
  );
}
