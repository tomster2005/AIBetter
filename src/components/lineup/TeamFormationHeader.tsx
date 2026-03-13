import type { Fixture } from "../../types/fixture.js";

interface TeamFormationHeaderProps {
  fixture: Fixture | null;
  homeFormation?: string;
  awayFormation?: string;
}

export function TeamFormationHeader({ fixture, homeFormation, awayFormation }: TeamFormationHeaderProps) {
  return (
    <div className="formation-header">
      <div className="formation-header__side">
        {fixture?.homeTeam.logo && (
          <img src={fixture.homeTeam.logo} alt="" className="formation-header__logo" />
        )}
        <span className="formation-header__name">{fixture?.homeTeam.name ?? "Home"}</span>
        {homeFormation && <span className="formation-header__formation">{homeFormation}</span>}
      </div>
      <div className="formation-header__vs">vs</div>
      <div className="formation-header__side formation-header__side--away">
        {awayFormation && <span className="formation-header__formation">{awayFormation}</span>}
        <span className="formation-header__name">{fixture?.awayTeam.name ?? "Away"}</span>
        {fixture?.awayTeam.logo && (
          <img src={fixture.awayTeam.logo} alt="" className="formation-header__logo" />
        )}
      </div>
    </div>
  );
}
