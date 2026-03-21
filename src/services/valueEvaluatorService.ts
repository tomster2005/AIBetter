export type ValueEvalMarket = "shots" | "shotsOnTarget" | "goals";

export interface ValueEvalInput {
  playerName: string;
  market: ValueEvalMarket;
  line: number;
  odds: number;
}

export interface ValueEvalResult {
  playerId: number;
  playerName: string;
  market: ValueEvalMarket;
  line: number;
  odds: number;
  impliedProb: number;
  estimatedProb: number;
  edge: number;
  verdict: "GOOD VALUE" | "NEUTRAL" | "BAD VALUE";
  confidence: number;
  sampleSize: number;
  averageStat: number;
  metricTotal: number;
  method: string;
}

function getApiOrigin(): string {
  const base = typeof import.meta.env !== "undefined" && import.meta.env?.VITE_API_ORIGIN;
  return typeof base === "string" && base !== "" ? base.replace(/\/$/, "") : "";
}

export async function evaluateValueBet(input: ValueEvalInput): Promise<ValueEvalResult> {
  const origin = getApiOrigin();
  const url = `${origin}/api/value-evaluator`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  const payload = (await res.json().catch(() => ({}))) as ValueEvalResult & { error?: string };
  if (!res.ok) throw new Error(payload.error || "Failed to evaluate bet.");
  return payload as ValueEvalResult;
}

