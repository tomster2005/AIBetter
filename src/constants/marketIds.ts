export const MARKET_ID_MATCH_RESULTS = 1;
export const MARKET_ID_BTTS = 14;
export const MARKET_ID_MATCH_GOALS = 80;
export const MARKET_ID_ALTERNATIVE_TOTAL_GOALS = 81;

/** Sportmonks: Player Shots (player props). */
export const MARKET_ID_PLAYER_SHOTS = 334;
/** Sportmonks: Player Shots On Target (player props). */
export const MARKET_ID_PLAYER_SHOTS_ON_TARGET = 336;

export const MARKET_ID_TEAM_SHOTS = 285;
export const MARKET_ID_TEAM_SHOTS_ON_TARGET = 284;

export const MARKET_ID_MATCH_SHOTS = 192;
export const MARKET_ID_MATCH_SHOTS_ON_TARGET = 291;

export const MARKET_ID_FOULS_COMMITTED = 388;
export const MARKET_ID_FOULS_WON = 339;

/** Alternative Corners: Over/Under X.X (used in odds workspace). */
export const MARKET_ID_ALTERNATIVE_CORNERS = 69;
/** Total Corners range market (e.g. 0-3, 4-6 corners) — not used for O/U display. */
export const MARKET_ID_TOTAL_CORNERS = 68;
export const MARKET_ID_TEAM_CORNERS = 74;

export const MARKET_ID_PLAYER_TACKLES = 340;
export const MARKET_ID_TEAM_TOTAL_GOALS = 86;

/** Core match markets: Match Results, BTTS, main Over/Under Goals (80), Alternative Total Goals (81). */
export const CORE_MARKET_IDS = [
  MARKET_ID_MATCH_RESULTS,
  MARKET_ID_BTTS,
  MARKET_ID_MATCH_GOALS,
  MARKET_ID_ALTERNATIVE_TOTAL_GOALS,
];

/** Team prop markets supported in odds UI (first wave: alternative corners, team total goals). */
export const TEAM_PROP_MARKET_IDS = [
  MARKET_ID_ALTERNATIVE_CORNERS,
  MARKET_ID_TEAM_TOTAL_GOALS,
  MARKET_ID_TEAM_SHOTS,
  MARKET_ID_TEAM_SHOTS_ON_TARGET,
  MARKET_ID_MATCH_SHOTS,
  MARKET_ID_MATCH_SHOTS_ON_TARGET,
  MARKET_ID_TEAM_CORNERS,
];

/** Market IDs currently fetched and returned by the odds API. */
export const ACTIVE_ODDS_MARKET_IDS: readonly number[] = [
  ...CORE_MARKET_IDS,
  MARKET_ID_ALTERNATIVE_CORNERS,
  MARKET_ID_TEAM_TOTAL_GOALS,
];

export const PLAYER_PROP_MARKET_IDS = [
  MARKET_ID_PLAYER_SHOTS_ON_TARGET,
  MARKET_ID_PLAYER_SHOTS,
];
