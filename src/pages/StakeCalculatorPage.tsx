import { useEffect, useMemo, useState } from "react";
import { getUnitSize, setUnitSize } from "../services/betTrackerService.js";
import "./StakeCalculatorPage.css";

export function StakeCalculatorPage() {
  const [unitInput, setUnitInput] = useState("");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    setUnitInput(getUnitSize().toFixed(2));
  }, []);

  const normalized = useMemo(() => {
    const n = Number(unitInput);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [unitInput]);

  return (
    <div className="stake-calculator-page">
      <h1 className="stake-calculator-page__title">Set Unit</h1>
      <p className="stake-calculator-page__intro">
        Store your base unit size. All stakes are entered directly in units.
      </p>
      <section className="stake-calculator-page__card">
        <div className="stake-calculator-page__inputs">
          <label>
            <span>Unit size</span>
            <input
              type="text"
              inputMode="decimal"
              value={unitInput}
              onChange={(e) => setUnitInput(e.target.value)}
              placeholder="1.00"
            />
          </label>
          <button
            type="button"
            className="stake-calculator-page__save-btn"
            onClick={() => {
              if (normalized == null) {
                setSaveMessage("Enter a valid unit size.");
                return;
              }
              setUnitSize(normalized);
              setSaveMessage("Unit size saved.");
            }}
          >
            Save Unit
          </button>
        </div>
        {saveMessage && (
          <div className="stake-calculator-page__result" aria-live="polite">
            <p className="stake-calculator-page__result-note">{saveMessage}</p>
          </div>
        )}
      </section>
    </div>
  );
}
