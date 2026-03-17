/**
 * Probability and edge helpers for player props (Poisson model, implied prob, edge).
 * Lambda = rate for the game; use per90 * (expectedMinutes/90) — see valueBetModel.lambdaFromPer90AndMinutes.
 */

export function calculatePer90(stat: number, minutes: number): number {
  if (!minutes || minutes === 0) return 0;
  return (stat / minutes) * 90;
}

function factorial(n: number): number {
  if (n < 0 || !Number.isInteger(n)) return 0;
  if (n <= 1) return 1;
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

/** P(X = k) for Poisson with rate lambda. */
export function poissonProbability(lambda: number, k: number): number {
  if (lambda < 0 || k < 0 || !Number.isInteger(k)) return 0;
  if (lambda === 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

/** P(X >= line) for Over line (line is e.g. 1.5 → Over means X >= 2). Computed as 1 - P(X <= line-1) for numerical stability. */
export function probabilityOverLine(lambda: number, line: number): number {
  const under = probabilityUnderLine(lambda, line);
  const over = 1 - under;
  return Math.max(0, Math.min(1, over));
}

/** P(X <= line - 0.5) for Under line (e.g. Under 1.5 → X <= 1). */
export function probabilityUnderLine(lambda: number, line: number): number {
  const kMax = Math.max(0, Math.floor(line - 0.5));
  let sum = 0;
  for (let k = 0; k <= kMax; k++) {
    sum += poissonProbability(lambda, k);
  }
  return sum;
}

export function impliedProbability(odds: number): number {
  if (!odds || odds <= 0) return 0;
  return 1 / odds;
}

export function calculateEdge(modelProb: number, bookmakerProb: number): number {
  return modelProb - bookmakerProb;
}
