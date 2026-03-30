type DebugFlag =
  | "settlement"
  | "playerStats"
  | "fixtureStatus"
  | "marketId"
  | "betHistoryRefresh"
  | "playerProps"
  | "lineupAvailability";

type DebugFlags = Record<DebugFlag, boolean>;

function isNonProdBrowser(): boolean {
  return (
    typeof import.meta !== "undefined" &&
    !!(import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV
  );
}

function isNonProdNode(): boolean {
  return typeof process !== "undefined" && process.env?.NODE_ENV !== "production";
}

const DEFAULT_DEBUG_FLAGS: DebugFlags = {
  settlement: false,
  playerStats: true,
  fixtureStatus: false,
  marketId: false,
  betHistoryRefresh: false,
  playerProps: false,
  lineupAvailability: false,
};

function getRuntimeFlags(): DebugFlags {
  const g = globalThis as typeof globalThis & { __DEBUG_FLAGS__?: Partial<DebugFlags> };
  if (g.__DEBUG_FLAGS__ == null) {
    g.__DEBUG_FLAGS__ = { ...DEFAULT_DEBUG_FLAGS };
  }
  return { ...DEFAULT_DEBUG_FLAGS, ...g.__DEBUG_FLAGS__ };
}

export function debugEnabled(flag: DebugFlag): boolean {
  return getRuntimeFlags()[flag] === true;
}

export function debugLog(flag: DebugFlag, label: string, payload?: unknown): void {
  /** Always on in non-production (client DEV or Node non-prod); not gated by `playerProps` flag. */
  if (flag === "playerProps" && label === "[player-props-final-rows]") {
    if (isNonProdBrowser() || isNonProdNode()) {
      if (payload === undefined) console.log(label);
      else console.log(label, payload);
    }
    return;
  }
  if (!debugEnabled(flag)) return;
  if (payload === undefined) console.log(label);
  else console.log(label, payload);
}

export function debugWarn(flag: DebugFlag, label: string, payload?: unknown): void {
  if (!debugEnabled(flag)) return;
  if (payload === undefined) console.warn(label);
  else console.warn(label, payload);
}

