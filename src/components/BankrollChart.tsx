import type { BankrollTimelinePoint } from "../services/betTrackerService.js";
import "./BankrollChart.css";

function fmtDate(value: string): string {
  if (value === "Start") return value;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return value;
  return new Date(ts).toLocaleDateString();
}

function fmtMoney(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

export function BankrollChart({ points }: { points: BankrollTimelinePoint[] }) {
  if (!points || points.length === 0) {
    return <p className="bankroll-chart__empty">No settled bets yet.</p>;
  }

  const width = 820;
  const height = 220;
  const padX = 34;
  const padY = 20;
  const balances = points.map((p) => p.balance);
  const minY = Math.min(...balances);
  const maxY = Math.max(...balances);
  const yRange = Math.max(1, maxY - minY);

  const toX = (idx: number) => {
    if (points.length <= 1) return width / 2;
    return padX + (idx / (points.length - 1)) * (width - padX * 2);
  };
  const toY = (value: number) => {
    return height - padY - ((value - minY) / yRange) * (height - padY * 2);
  };

  const polyline = points.map((p, i) => `${toX(i)},${toY(p.balance)}`).join(" ");
  const overallUp = points[points.length - 1]!.balance >= points[0]!.balance;

  return (
    <div className="bankroll-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className="bankroll-chart__svg" role="img" aria-label="Bankroll over time">
        <line x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} className="bankroll-chart__axis" />
        <line x1={padX} y1={padY} x2={padX} y2={height - padY} className="bankroll-chart__axis" />
        <polyline
          points={polyline}
          fill="none"
          className={`bankroll-chart__line ${overallUp ? "is-up" : "is-down"}`}
        />
        {points.map((p, i) => (
          <circle key={`${p.date}-${i}`} cx={toX(i)} cy={toY(p.balance)} r={3} className="bankroll-chart__dot">
            <title>{`${fmtDate(p.date)} - £${fmtMoney(p.balance)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="bankroll-chart__meta">
        <span>Start: £{fmtMoney(points[0]!.balance)}</span>
        <span>Now: £{fmtMoney(points[points.length - 1]!.balance)}</span>
      </div>
    </div>
  );
}
