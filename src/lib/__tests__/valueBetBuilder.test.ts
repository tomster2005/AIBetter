import { describe, expect, it } from "vitest";
import { buildValueBetCombos, isValidBuilderCandidate, type OddsBookmakerInput } from "../valueBetBuilder.js";
import type { HeadToHeadFixtureContext } from "../../types/headToHeadContext.js";

describe("isValidBuilderCandidate", () => {
  it("rejects odds below hard floor", () => {
    expect(isValidBuilderCandidate(1.1, 0.5)).toBe(false);
  });

  it("accepts short odds when edge is strong enough", () => {
    expect(isValidBuilderCandidate(1.2, 0.06)).toBe(true);
  });

  it("rejects short odds when edge is weak", () => {
    expect(isValidBuilderCandidate(1.2, 0.03)).toBe(false);
  });

  it("requires a higher odds floor when edge is missing", () => {
    expect(isValidBuilderCandidate(1.2, null)).toBe(false);
    expect(isValidBuilderCandidate(1.25, null)).toBe(true);
  });
});

describe("buildValueBetCombos", () => {
  it("can build team-only combos when no player rows exist", () => {
    const fixtureOddsBookmakers: OddsBookmakerInput[] = [
      {
        bookmakerId: 1,
        bookmakerName: "TestBook",
        markets: [
          {
            marketId: 1,
            marketName: "Match Result",
            selections: [
              { label: "Home", value: "Home", odds: 2.1 },
              { label: "Draw", value: "Draw", odds: 3.2 },
              { label: "Away", value: "Away", odds: 3.5 },
            ],
          },
          {
            marketId: 14,
            marketName: "Both Teams To Score",
            selections: [
              { label: "Yes", value: "Yes", odds: 1.9 },
              { label: "No", value: "No", odds: 2.0 },
            ],
          },
        ],
      },
    ];
    const headToHeadContext: HeadToHeadFixtureContext = {
      sampleSize: 4,
      averageTotalGoals: 2.6,
      averageTotalCorners: 9.8,
      bttsRate: 0.55,
      team1WinRate: 0.4,
      team2WinRate: 0.3,
      drawRate: 0.3,
    };

    const { combos } = buildValueBetCombos([], fixtureOddsBookmakers, 3.0, {
      headToHeadContext,
    });

    expect(combos.length).toBeGreaterThan(0);
    expect(combos.every((combo) => combo.legs.every((leg) => leg.type === "team"))).toBe(true);
  });
});
