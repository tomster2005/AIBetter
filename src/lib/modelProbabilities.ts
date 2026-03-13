/**
 * Simple stats-based model probabilities for Match Results and BTTS (v1).
 * Pure helpers: no API calls, no UI, no React.
 */

export type TeamStrengthInput = {
  teamId?: number;
  teamName?: string;
  played: number;
  goalsFor: number;
  goalsAgainst: number;
  homePlayed?: number;
  homeGoalsFor?: number;
  homeGoalsAgainst?: number;
  awayPlayed?: number;
  awayGoalsFor?: number;
  awayGoalsAgainst?: number;
};

export type MatchModelInput = {
  homeTeam: TeamStrengthInput;
  awayTeam: TeamStrengthInput;
};

export function safePerGame(total: number, played: number): number {
  if (typeof total !== "number" || typeof played !== "number" || !Number.isFinite(total) || !Number.isFinite(played) || played <= 0) return 0;
  return total / played;
}

export function clampProbability(value: number, min = 0, max = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

const FALLBACK_THREE_WAY = { Home: 0.33, Draw: 0.34, Away: 0.33 };

export function normaliseThreeWayProbabilities(input: {
  Home: number;
  Draw: number;
  Away: number;
}): { Home: number; Draw: number; Away: number } {
  const total = (input.Home ?? 0) + (input.Draw ?? 0) + (input.Away ?? 0);
  if (total <= 0 || !Number.isFinite(total)) return FALLBACK_THREE_WAY;
  return {
    Home: input.Home / total,
    Draw: input.Draw / total,
    Away: input.Away / total,
  };
}

/** v1: home attack vs away defence, away attack vs home defence; home advantage +0.15; clamp 0.2–3.5 */
export function estimateExpectedGoals(input: MatchModelInput): {
  homeExpectedGoals: number;
  awayExpectedGoals: number;
} {
  const home = input.homeTeam;
  const away = input.awayTeam;

  const homeAttackRate =
    safePerGame(home.homeGoalsFor ?? home.goalsFor, home.homePlayed ?? home.played) ||
    safePerGame(home.goalsFor, home.played);
  const awayDefenceRate =
    safePerGame(away.awayGoalsAgainst ?? away.goalsAgainst, away.awayPlayed ?? away.played) ||
    safePerGame(away.goalsAgainst, away.played);
  const awayAttackRate =
    safePerGame(away.awayGoalsFor ?? away.goalsFor, away.awayPlayed ?? away.played) ||
    safePerGame(away.goalsFor, away.played);
  const homeDefenceRate =
    safePerGame(home.homeGoalsAgainst ?? home.goalsAgainst, home.homePlayed ?? home.played) ||
    safePerGame(home.goalsAgainst, home.played);

  let homeExpectedGoals = (homeAttackRate + awayDefenceRate) / 2;
  let awayExpectedGoals = (awayAttackRate + homeDefenceRate) / 2;

  homeExpectedGoals += 0.15;
  const lo = 0.2;
  const hi = 3.5;
  homeExpectedGoals = Math.max(lo, Math.min(hi, homeExpectedGoals));
  awayExpectedGoals = Math.max(lo, Math.min(hi, awayExpectedGoals));

  return { homeExpectedGoals, awayExpectedGoals };
}

/** P(score exactly k goals) under Poisson with rate lambda */
export function poissonProbability(lambda: number, goals: number): number {
  if (typeof lambda !== "number" || typeof goals !== "number" || !Number.isFinite(lambda) || !Number.isFinite(goals) || goals < 0 || goals !== Math.floor(goals)) return 0;
  if (lambda <= 0) return goals === 0 ? 1 : 0;
  let f = 1;
  for (let i = 2; i <= goals; i++) f *= i;
  return (Math.pow(lambda, goals) * Math.exp(-lambda)) / f;
}

/** 2D matrix P(home=i, away=j) for i,j in 0..maxGoals; matrix[i][j] = probability */
export function buildScoreMatrix(
  homeExpectedGoals: number,
  awayExpectedGoals: number,
  maxGoals = 5
): number[][] {
  const matrix: number[][] = [];
  for (let i = 0; i <= maxGoals; i++) {
    const row: number[] = [];
    for (let j = 0; j <= maxGoals; j++) {
      const p = poissonProbability(homeExpectedGoals, i) * poissonProbability(awayExpectedGoals, j);
      row.push(p);
    }
    matrix.push(row);
  }
  return matrix;
}

export function generateModelProbabilities(input: MatchModelInput): {
  matchResults: { Home: number; Draw: number; Away: number };
  btts: { Yes: number; No: number };
  expectedGoals: { homeExpectedGoals: number; awayExpectedGoals: number };
} {
  const { homeExpectedGoals, awayExpectedGoals } = estimateExpectedGoals(input);
  const matrix = buildScoreMatrix(homeExpectedGoals, awayExpectedGoals, 5);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let bttsYes = 0;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < (matrix[i]?.length ?? 0); j++) {
      const p = matrix[i][j] ?? 0;
      if (i > j) homeWin += p;
      else if (i === j) draw += p;
      else awayWin += p;
      if (i >= 1 && j >= 1) bttsYes += p;
    }
  }
  const bttsNo = Math.max(0, 1 - bttsYes);

  const matchResults = normaliseThreeWayProbabilities({ Home: homeWin, Draw: draw, Away: awayWin });
  const bttsYesClamped = clampProbability(bttsYes);
  const bttsNoClamped = clampProbability(bttsNo);
  const bttsSum = bttsYesClamped + bttsNoClamped;
  const btts = bttsSum > 0
    ? { Yes: bttsYesClamped / bttsSum, No: bttsNoClamped / bttsSum }
    : { Yes: 0.5, No: 0.5 };

  return {
    matchResults,
    btts,
    expectedGoals: { homeExpectedGoals, awayExpectedGoals },
  };
}

export function explainModel(input: MatchModelInput): {
  inputs: { homeTeam: TeamStrengthInput; awayTeam: TeamStrengthInput };
  expectedGoals: { homeExpectedGoals: number; awayExpectedGoals: number };
  probabilities: ReturnType<typeof generateModelProbabilities>;
} {
  const expectedGoals = estimateExpectedGoals(input);
  const probabilities = generateModelProbabilities(input);
  return {
    inputs: { homeTeam: input.homeTeam, awayTeam: input.awayTeam },
    expectedGoals,
    probabilities,
  };
}

/*
  Usage example:

  const input: MatchModelInput = {
    homeTeam: {
      played: 10,
      goalsFor: 18,
      goalsAgainst: 10,
      homePlayed: 5,
      homeGoalsFor: 10,
      homeGoalsAgainst: 4,
    },
    awayTeam: {
      played: 10,
      goalsFor: 14,
      goalsAgainst: 12,
      awayPlayed: 5,
      awayGoalsFor: 6,
      awayGoalsAgainst: 7,
    },
  };
  const probs = generateModelProbabilities(input);
  const explanation = explainModel(input);
  console.log(probs);
  console.log(explanation);
*/
