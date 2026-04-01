import { useEffect, useMemo, useState } from "react";
import "./StakeCalculatorPage.css";

type StakeRiskLevel = "conservative" | "standard" | "aggressive";

function parsePositiveNumber(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function StakeCalculatorPage({ defaultBankroll }: { defaultBankroll: number | null }) {
  const [bankroll, setBankroll] = useState("");
  const [edge, setEdge] = useState("");
  const [risk, setRisk] = useState<StakeRiskLevel>("standard");
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (bankroll.trim() !== "") return;
    if (defaultBankroll == null || !Number.isFinite(defaultBankroll)) return;
    setBankroll(defaultBankroll.toFixed(2));
  }, [defaultBankroll, bankroll]);

  useEffect(() => {
    const onValueBetSelected = (ev: Event) => {
      const detail = (ev as CustomEvent<{ edgePercent?: number }>).detail;
      const edgePercent = Number(detail?.edgePercent);
      if (!Number.isFinite(edgePercent)) return;
      setEdge(Math.max(0, edgePercent).toFixed(1));
      setFlash(true);
      window.setTimeout(() => setFlash(false), 900);
    };
    window.addEventListener("app:value-bet-selected", onValueBetSelected as EventListener);
    return () => window.removeEventListener("app:value-bet-selected", onValueBetSelected as EventListener);
  }, []);

  const { recommendedStake, units } = useMemo(() => {
    const riskMultiplier = risk === "conservative" ? 0.5 : risk === "aggressive" ? 1.5 : 1;
    const bankrollValue = parsePositiveNumber(bankroll);
    const edgeValue = parsePositiveNumber(edge);
    const unitsRaw = edgeValue * riskMultiplier;
    const unitsValue = Math.min(3, Math.max(0.5, unitsRaw || 0));
    const stakeValue = bankrollValue > 0 ? bankrollValue * 0.01 * unitsValue : 0;
    return { recommendedStake: stakeValue, units: stakeValue > 0 ? unitsValue : 0 };
  }, [bankroll, edge, risk]);

  return (
    <div className="stake-calculator-page">
      <h1 className="stake-calculator-page__title">Stake Calculator</h1>
      <p className="stake-calculator-page__intro">
        Calculate a recommended stake based on bankroll, risk level, and edge.
      </p>
      <section className={`stake-calculator-page__card${flash ? " stake-calculator-page__card--flash" : ""}`}>
        <div className="stake-calculator-page__inputs">
          <label>
            <span>Bankroll (£)</span>
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
              <option value="conservative">Conservative (0.5x)</option>
              <option value="standard">Standard (1x)</option>
              <option value="aggressive">Aggressive (1.5x)</option>
            </select>
          </label>
          <label>
            <span>Edge (%)</span>
            <input
              type="text"
              inputMode="decimal"
              value={edge}
              onChange={(e) => setEdge(e.target.value)}
              placeholder="e.g. 8.5"
            />
          </label>
        </div>
        <div className="stake-calculator-page__result" aria-live="polite">
          <p className="stake-calculator-page__result-label">Recommended Stake</p>
          <p className="stake-calculator-page__result-value">£{recommendedStake.toFixed(2)}</p>
          <p className="stake-calculator-page__result-units">Units: {units.toFixed(1)}</p>
          <p className="stake-calculator-page__result-note">
            Based on 1% base unit and selected risk level.
          </p>
        </div>
      </section>
    </div>
  );
}
