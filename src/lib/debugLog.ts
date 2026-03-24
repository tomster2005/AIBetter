type DebugFlag =
  | "settlement"
  | "playerStats"
  | "fixtureStatus"
  | "marketId"
  | "betHistoryRefresh";

type DebugFlags = Record<DebugFlag, boolean>;

const DEFAULT_DEBUG_FLAGS: DebugFlags = {
  settlement: false,
  playerStats: true,
  fixtureStatus: false,
  marketId: false,
  betHistoryRefresh: false,
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
  if (!debugEnabled(flag)) return;
  if (payload === undefined) console.log(label);
  else console.log(label, payload);
}

export function debugWarn(flag: DebugFlag, label: string, payload?: unknown): void {
  if (!debugEnabled(flag)) return;
  if (payload === undefined) console.warn(label);
  else console.warn(label, payload);
}

