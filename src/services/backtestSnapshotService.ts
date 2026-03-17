/**
 * Sends pre-match value-bet snapshots to the server for backtest dataset storage.
 * Failures are silent so the UI is never broken.
 */

import { convertToBacktestRows, type ValueBetRowLike } from "../lib/backtestDataset.js";

function getApiOrigin(): string {
  const base =
    typeof import.meta.env !== "undefined" && import.meta.env?.VITE_API_ORIGIN;
  return typeof base === "string" && base !== "" ? base.replace(/\/$/, "") : "";
}

/**
 * Append value-bet rows to the backtest dataset on the server.
 * Call after value-bet generation; does nothing if rows are empty or request fails.
 */
export async function appendBacktestSnapshots(
  fixtureId: number,
  kickoffAt: string,
  rows: ValueBetRowLike[]
): Promise<void> {
  if (rows.length === 0) return;
  const origin = getApiOrigin();
  if (!origin) return;
  const stored = convertToBacktestRows(rows, { fixtureId, kickoffAt });
  if (import.meta.env.DEV) {
    console.log("[snapshot frontend] POST body prepared", {
      fixtureId,
      rowCount: stored.length,
      firstRowPreview: stored[0]
        ? { playerName: stored[0].playerName, marketName: stored[0].marketName, line: stored[0].line }
        : null,
    });
  }
  const res = await fetch(`${origin}/api/backtest-snapshots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows: stored }),
  });
  const body = await res.json().catch(() => ({}));
  if (import.meta.env.DEV) {
    console.log("[snapshot frontend] POST response", { status: res.status, body });
  }
  if (!res.ok) throw new Error(`Backtest snapshots: ${res.status}`);
}
