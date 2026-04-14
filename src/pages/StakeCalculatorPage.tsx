import { useMemo, useState } from "react";
import "./StakeCalculatorPage.css";

type StakeRiskLevel = "conservative" | "standard" | "aggressive";

function parsePositiveNumber(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function baseUnitsFromOdds(odds: number): number {
  if (!Number.isFinite(odds) || odds <= 1) return 0;
  if (odds < 1.5) return 2.5;
  if (odds < 1.8) return 2;
  if (odds < 2.2) return 1.5;
  if (odds < 3) return 1;
  if (odds < 5) return 0.5;
  return 0.25;
}

function adjustUnitsForRisk(baseUnits: number, risk: StakeRiskLevel): number {
  if (baseUnits <= 0) return 0;
  const riskOffset = risk === "conservative" ? -0.5 : risk === "aggressive" ? 0.5 : 0;
  return Math.min(3, Math.max(0.25, baseUnits + riskOffset));
}

export function StakeCalculatorPage() {
  const [bankroll, setBankroll] = useState("");
  const [odds, setOdds] = useState("");
  const [risk, setRisk] = useState<StakeRiskLevel>("standard");

  const { recommendedStake, unitsLabel, helperText } = useMemo(() => {
    const bankrollValue = parsePositiveNumber(bankroll);
    const oddsValue = Number(odds);
    const oddsValid = Number.isFinite(oddsValue) && oddsValue > 1;
    if (!oddsValid || bankrollValue <= 0) {
      return {
        recommendedStake: 0,
        unitsLabel: "—",
        helperText: "Enter decimal odds to calculate a stake.",
      };
    }
    const baseUnits = baseUnitsFromOdds(oddsValue);
    const unitsValue = adjustUnitsForRisk(baseUnits, risk);
    const stakeValue = bankrollValue * 0.01 * unitsValue;
    return {
      recommendedStake: stakeValue,
      unitsLabel: `${unitsValue.toFixed(2).replace(/\.00$/, "")} units`,
      helperText: "Based on bankroll, odds, and selected risk level.",
    };
  }, [bankroll, odds, risk]);

  return (
    <div className="stake-calculator-page">
      <h1 className="stake-calculator-page__title">Stake Calculator</h1>
      <p className="stake-calculator-page__intro">
        Calculate a recommended stake based on bankroll, risk level, and edge.
      </p>
      <section className="stake-calculator-page__card">
        <div className="stake-calculator-page__inputs">
          <label>
            <span>Bankroll (units)</span>
            <input
              type="text"
              inputMode="decimal"
              value={bankroll}
              onChange={(e) => setBankroll(e.target.value)}
              placeholder="0.00"
            />
          </label>
          <label>
            <span>Risk level</span>
            <select value={risk} onChange={(e) => setRisk(e.target.value as StakeRiskLevel)}>
              <option value="conservative">Conservative</option>
              <option value="standard">Standard</option>
              <option value="aggressive">Aggressive</option>
            </select>
          </label>
          <label>
            <span>Odds</span>
            <input
              type="text"
              inputMode="decimal"
              value={odds}
              onChange={(e) => setOdds(e.target.value)}
              placeholder="e.g. 1.80"
            />
          </label>
        </div>
        <div className="stake-calculator-page__result" aria-live="polite">
          <p className="stake-calculator-page__result-label">Recommended Stake</p>
          <p className="stake-calculator-page__result-value">{recommendedStake.toFixed(2)}u</p>
          <p className="stake-calculator-page__result-label">Suggested Size</p>
          <p className="stake-calculator-page__result-units">{unitsLabel}</p>
          <p className="stake-calculator-page__result-note">
            {helperText}
          </p>
        </div>
      </section>
    </div>
  );
}
