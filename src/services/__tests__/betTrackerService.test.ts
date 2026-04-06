import { describe, expect, it } from "vitest";
import { buildSelectionFromPreset, type QuickAddSelectionDraft } from "../../pages/BetTrackerPage.js";
import { manualLegRejectReason, type ManualTrackedSelectionInput } from "../betTrackerService.js";

function makeDraft(overrides: Partial<QuickAddSelectionDraft>): QuickAddSelectionDraft {
  return {
    id: "row-1",
    preset: "",
    matchLabel: "",
    teamName: "",
    line: "",
    outcome: "",
    marketName: "",
    selectionLabel: "",
    playerName: "",
    leagueName: "",
    kickoffTime: "",
    odds: "",
    rowNotes: "",
    showMoreDetails: false,
    ...overrides,
  };
}

describe("Quick Add preset mapping", () => {
  it("maps player shots over preset with expected label and outcome", () => {
    const rowError: Record<string, string> = {};
    const mapped = buildSelectionFromPreset(
      makeDraft({
        preset: "playerShotsOver",
        matchLabel: "Arsenal v Liverpool",
        playerName: "Bukayo Saka",
        line: "1.5",
      }),
      rowError
    );

    expect(mapped).not.toBeNull();
    expect(mapped?.selectionLabel).toBe("Bukayo Saka Shots Over 1.5");
    expect(mapped?.outcome).toBe("Over");
  });

  it("maps player tackles over preset with expected label and outcome", () => {
    const rowError: Record<string, string> = {};
    const mapped = buildSelectionFromPreset(
      makeDraft({
        preset: "playerTacklesOver",
        matchLabel: "Arsenal v Liverpool",
        playerName: "Declan Rice",
        line: "2.5",
      }),
      rowError
    );

    expect(mapped).not.toBeNull();
    expect(mapped?.selectionLabel).toBe("Declan Rice Tackles Over 2.5");
    expect(mapped?.outcome).toBe("Over");
  });
});

describe("manualLegRejectReason", () => {
  it("returns outcome required for custom selection with missing outcome", () => {
    const input: ManualTrackedSelectionInput = {
      matchLabel: "Arsenal v Liverpool",
      marketName: "Player shots",
      selectionLabel: "Saka over 1.5",
      outcome: undefined,
    };

    expect(manualLegRejectReason(input)).toEqual({
      field: "outcome",
      message: "Outcome is required.",
    });
  });

  it("returns null when custom selection is valid", () => {
    const input: ManualTrackedSelectionInput = {
      matchLabel: "Arsenal v Liverpool",
      marketName: "Player shots",
      selectionLabel: "Saka over 1.5",
      outcome: "Over",
    };

    expect(manualLegRejectReason(input)).toBeNull();
  });

  it("returns correct field for missing required input", () => {
    const input: ManualTrackedSelectionInput = {
      matchLabel: "Arsenal v Liverpool",
      marketName: "",
      selectionLabel: "Saka over 1.5",
      outcome: "Over",
    };

    expect(manualLegRejectReason(input)).toEqual({
      field: "marketName",
      message: "Market is required.",
    });
  });
});
