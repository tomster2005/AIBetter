import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addManualMultiBetShared,
  explainManualMultiBetFailure,
  restoreTrackedBetsFromBackup,
  settlePendingTrackedBets,
  getTrackedBetsDebugState,
  getScoreBandAnalysis,
  getTrackedBetStats,
  getTrackedBets,
  getUnitSize,
  deleteTrackedBetShared,
  findDuplicateTrackedBet,
  updateTrackedBetStatusShared,
  updateTrackedBetCashOutShared,
  type AddManualMultiBetInput,
  type DuplicateMatch,
  type ManualTrackedSelectionInput,
  type ScoreBandAnalysisRow,
  type TrackedBetRecord,
  type TrackedBetStatus,
  type TrackedBetLeg,
} from "../services/betTrackerService.js";
import { formatBetLegDisplayLabel } from "../lib/betLegDisplayLabel.js";
import { BankrollChart } from "../components/BankrollChart.js";
import { evaluateValueBet, type ValueEvalMarket, type ValueEvalResult } from "../services/valueEvaluatorService.js";
import "./BetTrackerPage.css";

function fmtUnits(v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(2)}u` : "0.00u";
}

function fmtPounds(v: number): string {
  return Number.isFinite(v) ? `£${v.toFixed(2)}` : "£0.00";
}

function fmtSignedUnits(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0.00u";
  return `${v > 0 ? "+" : "-"}${Math.abs(v).toFixed(2)}u`;
}

function fmtDate(v: string): string {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return v;
  return new Date(t).toLocaleString();
}

function fmtRelativeDate(v: string): string {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return fmtDate(v);
  const d = new Date(t);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const hhmm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (t >= startOfToday) return `Today ${hhmm}`;
  if (t >= startOfYesterday) return `Yesterday ${hhmm}`;
  return d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" }) + ` ${hhmm}`;
}

function toRangeStartMs(value: string): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function toRangeEndMs(value: string): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function formatRangeLabel(start: string, end: string): string {
  if (!start && !end) return "All time";
  if (start && end) return `${start} to ${end}`;
  if (start) return `From ${start}`;
  return `To ${end}`;
}

function getBetStakeUnits(bet: TrackedBetRecord): number {
  if (Number.isFinite(bet.stakeUnits as number)) return bet.stakeUnits as number;
  return bet.stake;
}

function getBetReturnUnits(bet: TrackedBetRecord): number {
  if (Number.isFinite(bet.returnUnits as number)) return bet.returnUnits as number;
  return bet.returnAmount;
}

function getBetProfit(bet: TrackedBetRecord): number {
  if (Number.isFinite(bet.profitUnits as number)) return bet.profitUnits as number;
  const stakeUnits = getBetStakeUnits(bet);
  if (bet.status === "win" || bet.status === "cashed_out") return getBetReturnUnits(bet) - stakeUnits;
  if (bet.status === "loss") return -stakeUnits;
  return 0;
}

function getStatusLabel(status: TrackedBetStatus): string {
  return status === "cashed_out" ? "cashed out" : status;
}

function getSettledOutcome(bet: TrackedBetRecord): "win" | "loss" | null {
  if (bet.status === "win") return "win";
  if (bet.status === "loss") return "loss";
  if (bet.status === "cashed_out") return bet.returnAmount >= bet.stake ? "win" : "loss";
  return null;
}

function sanitizeCashOutInput(value: string): string {
  const cleaned = value.replace(/[^0-9.]/g, "");
  if (cleaned === "") return "";
  const [intPart, ...rest] = cleaned.split(".");
  const decimals = rest.join("");
  const nextDecimals = decimals.length > 0 ? decimals.slice(0, 2) : "";
  return nextDecimals.length > 0 ? `${intPart}.${nextDecimals}` : intPart;
}

function toUnitsString(value: number): string {
  return `${value.toFixed(2)}u`;
}

function buildExportSvg(params: {
  points: { date: string; balance: number }[];
  title: string;
  rangeLabel: string;
  profitUnits: number;
}): string {
  const width = 920;
  const height = 520;
  const chartWidth = 820;
  const chartHeight = 240;
  const chartX = 50;
  const chartY = 190;
  const padX = 34;
  const padY = 20;
  const points = params.points;
  const balances = points.length > 0 ? points.map((p) => p.balance) : [0];
  const minY = Math.min(...balances);
  const maxY = Math.max(...balances);
  const yRange = Math.max(1, maxY - minY);

  const toX = (idx: number) => {
    if (points.length <= 1) return chartX + chartWidth / 2;
    return chartX + padX + (idx / (points.length - 1)) * (chartWidth - padX * 2);
  };
  const toY = (value: number) => {
    return chartY + chartHeight - padY - ((value - minY) / yRange) * (chartHeight - padY * 2);
  };
  const polyline = points.map((p, i) => `${toX(i)},${toY(p.balance)}`).join(" ");
  const profitLabel = `${params.profitUnits >= 0 ? "+" : "-"}${Math.abs(params.profitUnits).toFixed(2)} units`;
  const trendUp = points.length > 1 ? points[points.length - 1]!.balance >= points[0]!.balance : true;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff" />
  <text x="50" y="50" font-size="24" font-family="Arial, sans-serif" fill="#111827">${params.title}</text>
  <text x="50" y="82" font-size="14" font-family="Arial, sans-serif" fill="#6b7280">${params.rangeLabel}</text>
  <text x="50" y="118" font-size="18" font-family="Arial, sans-serif" fill="#111827">P/L: ${profitLabel}</text>
  <rect x="${chartX}" y="${chartY}" width="${chartWidth}" height="${chartHeight}" rx="12" fill="#f9fafb" stroke="#e5e7eb" />
  <line x1="${chartX + padX}" y1="${chartY + chartHeight - padY}" x2="${chartX + chartWidth - padX}" y2="${chartY + chartHeight - padY}" stroke="#d1d5db" stroke-width="1" />
  <line x1="${chartX + padX}" y1="${chartY + padY}" x2="${chartX + padX}" y2="${chartY + chartHeight - padY}" stroke="#d1d5db" stroke-width="1" />
  <polyline points="${polyline}" fill="none" stroke="${trendUp ? "#16a34a" : "#dc2626"}" stroke-width="2.2" />
  ${points
    .map((p, i) => `<circle cx="${toX(i)}" cy="${toY(p.balance)}" r="3" fill="#111827" />`)
    .join("\n  ")}
</svg>`;
}

function buildRangeTimeline(params: {
  bets: TrackedBetRecord[];
  startMs: number | null;
  endMs: number | null;
}): { date: string; balance: number }[] {
  const startingBalance = 0;

  type Event = { date: number; delta: number; label: string };
  const events: Event[] = [];
  for (const bet of params.bets) {
    if (bet.status === "pending") continue;
    const d = Date.parse(bet.updatedAt || bet.createdAt);
    if (!Number.isFinite(d)) continue;
    events.push({ date: d, delta: getBetProfit(bet), label: bet.updatedAt || bet.createdAt });
  }
  events.sort((a, b) => a.date - b.date);

  const startMs = params.startMs;
  const endMs = params.endMs;
  const rangeStartMs = startMs ?? (events.length > 0 ? events[0]!.date : Date.now());
  const rangeEndMs = endMs ?? (events.length > 0 ? events[events.length - 1]!.date : Date.now());
  let balance = startingBalance;
  for (const e of events) {
    if (e.date < rangeStartMs) balance += e.delta;
  }

  const points: { date: string; balance: number }[] = [];
  points.push({ date: new Date(rangeStartMs).toISOString(), balance });
  for (const e of events) {
    if (e.date < rangeStartMs) continue;
    if (e.date > rangeEndMs) break;
    balance += e.delta;
    points.push({ date: e.label, balance });
  }
  return points;
}

function normalizeDuplicateText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeDuplicateLine(value?: number): string | null {
  return Number.isFinite(value as number) ? Number(value).toFixed(2) : null;
}

function buildDuplicateSignature(bet: TrackedBetRecord, leg: TrackedBetLeg): string {
  const fixtureKey = Number.isFinite(bet.fixtureId as number) ? `fid:${bet.fixtureId}` : `match:${normalizeDuplicateText(bet.matchLabel)}`;
  const playerKey = normalizeDuplicateText(leg.playerName);
  const marketKey = normalizeDuplicateText(leg.marketName || leg.marketFamily);
  const lineKey = normalizeDuplicateLine(leg.line) ?? "";
  const outcomeKey = leg.outcome ?? "";
  return [fixtureKey, playerKey, marketKey, lineKey, outcomeKey].join("|");
}

export type QuickAddSelectionDraft = {
  id: string;
  preset:
    | ""
    | "playerShotsOver"
    | "playerShotsOnTargetOver"
    | "playerFoulsCommittedOver"
    | "playerFoulsWonOver"
    | "playerTacklesOver"
    | "overGoals"
    | "teamCornersOver"
    | "teamCardsOver"
    | "btts"
    | "matchResult"
    | "custom";
  matchLabel: string;
  teamName: string;
  line: string;
  outcome: "" | "Over" | "Under" | "Yes" | "No" | "Home" | "Away" | "Draw";
  marketName: string;
  selectionLabel: string;
  playerName: string;
  leagueName: string;
  kickoffTime: string;
  odds: string;
  rowNotes: string;
  showMoreDetails: boolean;
};

type QuickAddErrors = {
  stake?: string;
  oddsTaken?: string;
  selections?: string;
  selectionRows?: Record<string, { preset?: string; matchLabel?: string; playerName?: string; teamName?: string; line?: string; outcome?: string; marketName?: string; selectionLabel?: string }>;
};

const QUICK_ADD_OUTCOMES: Array<{ value: QuickAddSelectionDraft["outcome"]; label: string }> = [
  { value: "", label: "None" },
  { value: "Over", label: "Over" },
  { value: "Under", label: "Under" },
  { value: "Yes", label: "Yes" },
  { value: "No", label: "No" },
  { value: "Home", label: "Home" },
  { value: "Away", label: "Away" },
  { value: "Draw", label: "Draw" },
];

const QUICK_ADD_PRESETS: Array<{ value: Exclude<QuickAddSelectionDraft["preset"], "">; label: string }> = [
  { value: "playerShotsOver", label: "Player Shots Over" },
  { value: "playerShotsOnTargetOver", label: "Player Shots on Target Over" },
  { value: "playerFoulsCommittedOver", label: "Player Fouls Committed Over" },
  { value: "playerFoulsWonOver", label: "Player Fouls Won Over" },
  { value: "playerTacklesOver", label: "Player Tackles Over" },
  { value: "overGoals", label: "Under/Over Goals" },
  { value: "teamCornersOver", label: "Team Corners Over" },
  { value: "teamCardsOver", label: "Team Cards Over" },
  { value: "btts", label: "BTTS" },
  { value: "matchResult", label: "Match Result" },
  { value: "custom", label: "Custom" },
];

function createSelectionDraft(): QuickAddSelectionDraft {
  return {
    id: `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    matchLabel: "",
    preset: "",
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
  };
}

function defaultOutcomeForPreset(preset: QuickAddSelectionDraft["preset"]): QuickAddSelectionDraft["outcome"] {
  if (preset === "") return "";
  if (preset === "btts") return "Yes";
  if (preset === "matchResult") return "Home";
  return "";
}

/**
 * When the user changes preset, clear every input that belongs to the previous structure.
 * Preserved: match, "More details" (league, kickoff, leg odds), row notes, expand toggle, row id.
 */
function selectionRowAfterPresetChange(
  row: QuickAddSelectionDraft,
  preset: QuickAddSelectionDraft["preset"]
): QuickAddSelectionDraft {
  return {
    ...row,
    preset,
    teamName: "",
    playerName: "",
    line: "",
    marketName: "",
    selectionLabel: "",
    outcome: defaultOutcomeForPreset(preset),
  };
}

function getPresetMarketName(preset: QuickAddSelectionDraft["preset"]): string {
  switch (preset) {
    case "":
      return "";
    case "playerShotsOver":
      return "Player Shots";
    case "playerShotsOnTargetOver":
      return "Player Shots on Target";
    case "playerFoulsCommittedOver":
      return "Player Fouls Committed";
    case "playerFoulsWonOver":
      return "Player Fouls Won";
    case "playerTacklesOver":
      return "Player Tackles";
    case "overGoals":
      return "Total Goals";
    case "teamCornersOver":
      return "Team Corners";
    case "teamCardsOver":
      return "Team Cards";
    case "btts":
      return "Both Teams to Score";
    case "matchResult":
      return "Match Result";
    case "custom":
      return "";
    default:
      return "";
  }
}

export function buildSelectionFromPreset(
  row: QuickAddSelectionDraft,
  rowError: { preset?: string; matchLabel?: string; playerName?: string; teamName?: string; line?: string; outcome?: string; marketName?: string; selectionLabel?: string }
): ManualTrackedSelectionInput | null {
  if (row.preset === "") {
    rowError.preset = "Choose a preset.";
  }
  const matchLabel = row.matchLabel.trim();
  if (!matchLabel) rowError.matchLabel = "Match is required.";
  if (row.preset === "") return null;
  const lineVal = row.line.trim() === "" ? NaN : Number(row.line);
  const oddsVal = row.odds.trim() === "" ? undefined : Number(row.odds);
  const legNotes = row.rowNotes.trim() || undefined;
  const team = row.teamName.trim();
  const player = row.playerName.trim();
  const outcome = row.outcome || undefined;

  if (row.preset === "custom") {
    const marketName = row.marketName.trim();
    const selectionLabel = row.selectionLabel.trim();
    if (!marketName) rowError.marketName = "Market is required.";
    if (!selectionLabel) rowError.selectionLabel = "Selection is required.";
    if (rowError.matchLabel || rowError.marketName || rowError.selectionLabel) return null;
    return {
      matchLabel,
      leagueName: row.leagueName.trim() || undefined,
      kickoffTime: row.kickoffTime.trim() || undefined,
      marketName,
      selectionLabel,
      playerName: player || team || undefined,
      line: Number.isFinite(lineVal) ? lineVal : undefined,
      outcome,
      odds: Number.isFinite(oddsVal as number) ? (oddsVal as number) : undefined,
      legNotes,
    };
  }

  const presetMarketName = getPresetMarketName(row.preset);
  let selectionLabel = "";
  let selectionOutcome: ManualTrackedSelectionInput["outcome"] = outcome;
  let playerName: string | undefined;
  let line: number | undefined;

  if (row.preset === "playerShotsOver" || row.preset === "playerShotsOnTargetOver" || row.preset === "playerFoulsCommittedOver" || row.preset === "playerFoulsWonOver" || row.preset === "playerTacklesOver") {
    if (!player) rowError.playerName = "Player is required.";
    if (!Number.isFinite(lineVal)) rowError.line = "Line is required.";
    if (rowError.matchLabel || rowError.playerName || rowError.line) return null;
    playerName = player;
    line = lineVal;
    const metric =
      row.preset === "playerShotsOver"
        ? "Shots"
        : row.preset === "playerShotsOnTargetOver"
          ? "Shots on Target"
          : row.preset === "playerFoulsCommittedOver"
            ? "Fouls Committed"
            : row.preset === "playerFoulsWonOver"
              ? "Fouls Won"
              : "Tackles";
    selectionLabel = `${player} ${metric} Over ${lineVal}`;
    selectionOutcome = "Over";
  } else if (row.preset === "overGoals") {
    if (!Number.isFinite(lineVal)) rowError.line = "Line is required.";
    if (row.outcome !== "Over" && row.outcome !== "Under") rowError.outcome = "Choose Over or Under.";
    if (rowError.matchLabel || rowError.line || rowError.outcome) return null;
    line = lineVal;
    selectionLabel = `${row.outcome} ${lineVal} Goals`;
    selectionOutcome = row.outcome;
  } else if (row.preset === "teamCornersOver" || row.preset === "teamCardsOver") {
    if (!team) rowError.teamName = "Team is required.";
    if (!Number.isFinite(lineVal)) rowError.line = "Line is required.";
    if (rowError.matchLabel || rowError.teamName || rowError.line) return null;
    playerName = team;
    line = lineVal;
    const metric = row.preset === "teamCornersOver" ? "Corners" : "Cards";
    selectionLabel = `${team} ${metric} Over ${lineVal}`;
    selectionOutcome = "Over";
  } else if (row.preset === "btts") {
    if (row.outcome !== "Yes" && row.outcome !== "No") rowError.outcome = "Choose Yes or No.";
    if (rowError.matchLabel || rowError.outcome) return null;
    selectionLabel = `BTTS ${row.outcome}`;
    selectionOutcome = row.outcome;
  } else if (row.preset === "matchResult") {
    if (row.outcome !== "Home" && row.outcome !== "Draw" && row.outcome !== "Away") rowError.outcome = "Choose Home, Draw, or Away.";
    if (rowError.matchLabel || rowError.outcome) return null;
    selectionLabel = `Match Result ${row.outcome}`;
    selectionOutcome = row.outcome;
  } else {
    return null;
  }

  return {
    matchLabel,
    leagueName: row.leagueName.trim() || undefined,
    kickoffTime: row.kickoffTime.trim() || undefined,
    marketName: presetMarketName,
    selectionLabel,
    playerName,
    line,
    outcome: selectionOutcome,
    odds: Number.isFinite(oddsVal as number) ? (oddsVal as number) : undefined,
    legNotes,
  };
}

export function BetTrackerPage() {
  const [exportStartDate, setExportStartDate] = useState<string>("");
  const [exportEndDate, setExportEndDate] = useState<string>("");
  const [bets, setBets] = useState<TrackedBetRecord[]>([]);
  const [selectedStatus, setSelectedStatus] = useState<"all" | TrackedBetStatus>("all");
  const [quickDateFilter, setQuickDateFilter] = useState<"all" | "today">("all");
  const [minScore, setMinScore] = useState<string>("");
  const [sortMode, setSortMode] = useState<"dateDesc" | "dateAsc" | "modelDesc" | "modelAsc" | "plDesc" | "plAsc">("dateDesc");
  const [message, setMessage] = useState<string | null>(null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickAddStake, setQuickAddStake] = useState("");
  const [quickAddOddsTaken, setQuickAddOddsTaken] = useState("");
  const [quickAddStatus, setQuickAddStatus] = useState<TrackedBetStatus>("pending");
  const [quickAddNotes, setQuickAddNotes] = useState("");
  const [quickAddSelections, setQuickAddSelections] = useState<QuickAddSelectionDraft[]>([createSelectionDraft()]);
  const [quickAddErrors, setQuickAddErrors] = useState<QuickAddErrors>({});
  const [expandedBetIds, setExpandedBetIds] = useState<Set<string>>(new Set());
  const [deletingBetIds, setDeletingBetIds] = useState<Set<string>>(new Set());
  const [statusPulseBetIds, setStatusPulseBetIds] = useState<Set<string>>(new Set());
  const [cashOutOpenIds, setCashOutOpenIds] = useState<Set<string>>(new Set());
  const [cashOutValues, setCashOutValues] = useState<Record<string, string>>({});
  const [cashOutErrors, setCashOutErrors] = useState<Record<string, string>>({});
  const [cashOutConfirmIds, setCashOutConfirmIds] = useState<Set<string>>(new Set());
  const [quickAddDuplicate, setQuickAddDuplicate] = useState<{ match: DuplicateMatch; payload: AddManualMultiBetInput } | null>(null);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [initialSyncLoading, setInitialSyncLoading] = useState(true);
  const [evalPlayerName, setEvalPlayerName] = useState("");
  const [evalMarket, setEvalMarket] = useState<ValueEvalMarket>("shotsOnTarget");
  const [evalLine, setEvalLine] = useState("0.5");
  const [evalOdds, setEvalOdds] = useState("1.98");
  const [evalLoading, setEvalLoading] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [evalResult, setEvalResult] = useState<ValueEvalResult | null>(null);
  const [debugStorageCount, setDebugStorageCount] = useState(0);
  const [debugBackupExists, setDebugBackupExists] = useState(false);
  const [debugBackupCount, setDebugBackupCount] = useState(0);
  const [debugServerCount, setDebugServerCount] = useState<number | null>(null);
  const [debugLastSync, setDebugLastSync] = useState<number | null>(null);
  const [debugSyncSource, setDebugSyncSource] = useState<string>("local-fallback");
  const quickAddTriggerRef = useRef<HTMLButtonElement | null>(null);
  const quickAddModalRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(() => {
    setBets(getTrackedBets());
    if (import.meta.env.DEV) {
      const dbg = getTrackedBetsDebugState();
      setDebugStorageCount(dbg.storageCount);
      setDebugBackupExists(dbg.backupExists);
      setDebugBackupCount(dbg.backupCount);
      setDebugServerCount(dbg.serverCount);
      setDebugLastSync(dbg.lastSyncTimestamp);
      setDebugSyncSource(dbg.syncSource);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const pending = bets.filter((b) => b.status === "pending");
    if (pending.length === 0) return;
    const b = pending[0];
    console.log("[bet-tracker UI] Status column binds to TrackedBetRecord.status (pending | win | loss)", {
      betId: b.id,
      fixtureId: b.fixtureId ?? null,
      status: b.status,
      displayedInSelect: b.status,
      legCount: b.legs.length,
    });
  }, [bets]);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      await settlePendingTrackedBets();
      if (!cancelled) {
        refresh();
        setInitialSyncLoading(false);
      }
    };
    void pull();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const quickAddStakeValue = Number(quickAddStake);
  const quickAddOddsValue = Number(quickAddOddsTaken);
  const quickAddReturnValue =
    Number.isFinite(quickAddStakeValue) && Number.isFinite(quickAddOddsValue) ? Math.max(0, quickAddStakeValue * quickAddOddsValue) : 0;

  const global = useMemo(() => getTrackedBetStats(), [bets]);
  const scoreBands = useMemo<ScoreBandAnalysisRow[]>(() => getScoreBandAnalysis(), [bets]);
  const settledBets = useMemo(() => bets.filter((b) => b.status !== "pending"), [bets]);
  const duplicateBetIds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const bet of bets) {
      for (const leg of bet.legs) {
        const sig = buildDuplicateSignature(bet, leg);
        counts.set(sig, (counts.get(sig) ?? 0) + 1);
      }
    }
    const duplicates = new Set<string>();
    for (const bet of bets) {
      for (const leg of bet.legs) {
        const sig = buildDuplicateSignature(bet, leg);
        if ((counts.get(sig) ?? 0) > 1) {
          duplicates.add(bet.id);
          break;
        }
      }
    }
    return duplicates;
  }, [bets]);
  const totals = useMemo(() => {
    const totalStaked = settledBets.reduce((sum, b) => sum + getBetStakeUnits(b), 0);
    const totalReturned = settledBets.reduce(
      (sum, b) => sum + (b.status === "win" || b.status === "cashed_out" ? getBetReturnUnits(b) : 0),
      0
    );
    const totalProfit = totalReturned - totalStaked;
    const roi = totalStaked > 0 ? totalProfit / totalStaked : 0;
    return { totalStaked, totalReturned, totalProfit, roi };
  }, [settledBets]);
  const exportRangeStartMs = useMemo(() => toRangeStartMs(exportStartDate), [exportStartDate]);
  const exportRangeEndMs = useMemo(() => toRangeEndMs(exportEndDate), [exportEndDate]);
  const exportRangeBets = useMemo(() => {
    const startMs = exportRangeStartMs;
    const endMs = exportRangeEndMs;
    return settledBets.filter((b) => {
      const ts = Date.parse(b.updatedAt || b.createdAt);
      if (!Number.isFinite(ts)) return false;
      if (startMs != null && ts < startMs) return false;
      if (endMs != null && ts > endMs) return false;
      return true;
    });
  }, [exportRangeEndMs, exportRangeStartMs, settledBets]);
  const exportRangeProfit = useMemo(() => exportRangeBets.reduce((sum, b) => sum + getBetProfit(b), 0), [exportRangeBets]);
  const exportRangeUnits = useMemo(() => exportRangeProfit, [exportRangeProfit]);
  const exportRangePoints = useMemo(
    () =>
      buildRangeTimeline({
        bets,
        startMs: exportRangeStartMs,
        endMs: exportRangeEndMs,
      }),
    [bets, exportRangeEndMs, exportRangeStartMs]
  );
  const exportRangeLabel = useMemo(
    () => formatRangeLabel(exportStartDate, exportEndDate),
    [exportStartDate, exportEndDate]
  );
  const exportRangeTitle = useMemo(() => "Bet Tracker Snapshot", []);
  const oddsRangePerformance = useMemo(() => {
    const ranges = [
      { label: "1.0-2.0", min: 1, max: 2 },
      { label: "2.0-3.0", min: 2, max: 3 },
      { label: "3.0-5.0", min: 3, max: 5 },
      { label: "5.0+", min: 5, max: Number.POSITIVE_INFINITY },
    ];
    return ranges.map((r) => {
      const inRange = settledBets.filter((b) => b.oddsTaken >= r.min && b.oddsTaken < r.max);
      const wins = inRange.filter((b) => getSettledOutcome(b) === "win").length;
      const profit = inRange.reduce((sum, b) => sum + getBetProfit(b), 0);
      return {
        label: r.label,
        bets: inRange.length,
        winRate: inRange.length > 0 ? wins / inRange.length : 0,
        profit,
      };
    });
  }, [settledBets]);
  const streakStats = useMemo(() => {
    const ordered = [...settledBets].sort(
      (a, b) => Date.parse(a.updatedAt || a.createdAt) - Date.parse(b.updatedAt || b.createdAt)
    );
    let current = 0;
    let currentType: "win" | "loss" | null = null;
    let longestWin = 0;
    let longestLoss = 0;
    let run = 0;
    let runType: "win" | "loss" | null = null;
    for (const b of ordered) {
      const t = getSettledOutcome(b);
      if (!t) continue;
      if (runType === t) run += 1;
      else {
        runType = t;
        run = 1;
      }
      if (t === "win") longestWin = Math.max(longestWin, run);
      else longestLoss = Math.max(longestLoss, run);
    }
    if (ordered.length > 0) {
      const last = getSettledOutcome(ordered[ordered.length - 1]!);
      if (!last) return { current, currentType, longestWin, longestLoss };
      currentType = last;
      current = 0;
      for (let i = ordered.length - 1; i >= 0; i--) {
        const t = getSettledOutcome(ordered[i]!);
        if (!t) break;
        if (t !== last) break;
        current += 1;
      }
    }
    return { current, currentType, longestWin, longestLoss };
  }, [settledBets]);
  const bestWorst = useMemo(() => {
    if (settledBets.length === 0) {
      return { best: null as TrackedBetRecord | null, worst: null as TrackedBetRecord | null, highestOddsWin: null as TrackedBetRecord | null };
    }
    const profitOf = (b: TrackedBetRecord) => getBetProfit(b);
    const best = [...settledBets].sort((a, b) => profitOf(b) - profitOf(a))[0] ?? null;
    const worst = [...settledBets].sort((a, b) => profitOf(a) - profitOf(b))[0] ?? null;
    const highestOddsWin =
      [...settledBets].filter((b) => getSettledOutcome(b) === "win").sort((a, b) => b.oddsTaken - a.oddsTaken)[0] ?? null;
    return { best, worst, highestOddsWin };
  }, [settledBets]);
  const recentPerformance = useMemo(() => {
    const ordered = [...settledBets].sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
    const calc = (n: number) => {
      const sample = ordered.slice(0, n);
      const wins = sample.filter((b) => getSettledOutcome(b) === "win").length;
      const profit = sample.reduce((sum, b) => sum + getBetProfit(b), 0);
      return {
        count: sample.length,
        winRate: sample.length > 0 ? wins / sample.length : 0,
        profit,
      };
    };
    return { last5: calc(5), last10: calc(10) };
  }, [settledBets]);
  const scoreBandExtremes = useMemo(() => {
    const nonEmpty = scoreBands.filter((row) => row.total > 0);
    if (nonEmpty.length === 0) return { best: null as string | null, worst: null as string | null };
    const best = [...nonEmpty].sort((a, b) => b.profit - a.profit)[0]!.label;
    const worst = [...nonEmpty].sort((a, b) => a.profit - b.profit)[0]!.label;
    return { best, worst };
  }, [scoreBands]);
  const filteredAndSortedBets = useMemo(() => {
    const parsedMinScore = minScore.trim() === "" ? null : Number(minScore);
    const hasMinScore = parsedMinScore != null && Number.isFinite(parsedMinScore);
    const todayStart = (() => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    })();

    const withDerived = bets
      .map((b) => {
        const modelScore = b.sourceMeta?.modelScore;
        const normalizedScore = b.sourceMeta?.normalizedScore;
        const pl = getBetProfit(b);
        return { b, modelScore, normalizedScore, pl };
      })
      .filter(({ b, normalizedScore }) => {
        if (selectedStatus !== "all" && b.status !== selectedStatus) return false;
        if (quickDateFilter === "today") {
          const ts = Date.parse(b.createdAt);
          if (!Number.isFinite(ts) || ts < todayStart) return false;
        }
        if (hasMinScore) {
          const isManualBet = b.sourceType === "manualMulti" || b.sourceMeta == null;
          if (!isManualBet) {
            if (typeof normalizedScore !== "number" || !Number.isFinite(normalizedScore)) return false;
            if (normalizedScore < (parsedMinScore as number)) return false;
          }
        }
        return true;
      });

    withDerived.sort((x, y) => {
      switch (sortMode) {
        case "dateAsc":
          return Date.parse(x.b.createdAt) - Date.parse(y.b.createdAt);
        case "dateDesc":
          return Date.parse(y.b.createdAt) - Date.parse(x.b.createdAt);
        case "modelAsc":
          return (x.modelScore ?? 0) - (y.modelScore ?? 0);
        case "modelDesc":
          return (y.modelScore ?? 0) - (x.modelScore ?? 0);
        case "plAsc":
          return x.pl - y.pl;
        case "plDesc":
          return y.pl - x.pl;
        default:
          return 0;
      }
    });

    return withDerived;
  }, [bets, minScore, selectedStatus, sortMode, quickDateFilter]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.log("[bet-tracker visibility]", {
      totalBets: bets.length,
      visibleBets: filteredAndSortedBets.length,
      hiddenByFilters: Math.max(0, bets.length - filteredAndSortedBets.length),
      filters: {
        status: selectedStatus,
        minScore: minScore.trim() === "" ? null : minScore,
        sortMode,
      },
    });
  }, [bets.length, filteredAndSortedBets.length, minScore, selectedStatus, sortMode]);

  const onStatusChange = useCallback(async (id: string, status: TrackedBetStatus) => {
    const updated = await updateTrackedBetStatusShared(id, status);
    if (!updated) {
      setMessage("Status update failed (server unavailable).");
      return;
    }
    setStatusPulseBetIds((prev) => new Set(prev).add(id));
    window.setTimeout(() => {
      setStatusPulseBetIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 420);
    setToast({ id: Date.now(), text: `Status updated to ${status}` });
    refresh();
  }, [refresh]);

  const onDeleteBet = useCallback(async (id: string) => {
    const ok = window.confirm("Delete this bet? This cannot be undone.");
    if (!ok) return;
    setDeletingBetIds((prev) => new Set(prev).add(id));
    const deleted = await deleteTrackedBetShared(id);
    if (deleted) {
      setToast({ id: Date.now(), text: "Bet deleted" });
      window.setTimeout(() => {
        refresh();
        setDeletingBetIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 180);
      return;
    }
    setDeletingBetIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setMessage("Bet could not be deleted (server unavailable).");
  }, [refresh]);

  const onRestoreFromBackup = useCallback(() => {
    const result = restoreTrackedBetsFromBackup();
    if (result.restored) {
      setMessage(`Restored ${result.count} bet(s) from backup.`);
      refresh();
    } else {
      setMessage("No valid backup available to restore.");
    }
  }, [refresh]);

  const toggleBetExpanded = useCallback((id: string) => {
    setExpandedBetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expandAllBets = useCallback(() => {
    setExpandedBetIds(new Set(filteredAndSortedBets.map(({ b }) => b.id)));
  }, [filteredAndSortedBets]);

  const collapseAllBets = useCallback(() => {
    setExpandedBetIds(new Set());
  }, []);

  function getNextStatus(status: TrackedBetStatus): TrackedBetStatus {
    if (status === "pending") return "win";
    if (status === "win") return "loss";
    return "pending";
  }

  const onOpenCashOut = useCallback((betId: string) => {
    setCashOutOpenIds((prev) => new Set(prev).add(betId));
    setCashOutValues((prev) => ({ ...prev, [betId]: prev[betId] ?? "" }));
    setCashOutErrors((prev) => {
      if (!prev[betId]) return prev;
      const next = { ...prev };
      delete next[betId];
      return next;
    });
  }, []);

  const onCloseCashOut = useCallback((betId: string) => {
    setCashOutOpenIds((prev) => {
      const next = new Set(prev);
      next.delete(betId);
      return next;
    });
    setCashOutConfirmIds((prev) => {
      const next = new Set(prev);
      next.delete(betId);
      return next;
    });
    setCashOutErrors((prev) => {
      if (!prev[betId]) return prev;
      const next = { ...prev };
      delete next[betId];
      return next;
    });
  }, []);

  const onConfirmCashOut = useCallback(async (bet: TrackedBetRecord) => {
    const raw = cashOutValues[bet.id] ?? "";
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) {
      setCashOutErrors((prev) => ({ ...prev, [bet.id]: "Enter a valid cash out amount." }));
      return;
    }
    if (amount > bet.returnAmount) {
      setCashOutErrors((prev) => ({ ...prev, [bet.id]: "Cash out cannot exceed the potential return." }));
      return;
    }
    const updated = await updateTrackedBetCashOutShared(bet.id, amount);
    if (!updated) {
      setMessage("Cash out failed (server unavailable). Please try again.");
      return;
    }
    onCloseCashOut(bet.id);
    setToast({ id: Date.now(), text: `Bet cashed out for ${toUnitsString(amount)}` });
    if (import.meta.env.DEV) {
      console.log("[cash-out-ui] confirmed", { betId: bet.id, amount });
    }
    refresh();
  }, [cashOutValues, onCloseCashOut, refresh]);

  const onRequestCashOutConfirm = useCallback((bet: TrackedBetRecord) => {
    const raw = cashOutValues[bet.id] ?? "";
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) {
      setCashOutErrors((prev) => ({ ...prev, [bet.id]: "Enter a valid cash out amount." }));
      return;
    }
    if (amount > bet.returnAmount) {
      setCashOutErrors((prev) => ({ ...prev, [bet.id]: `Cannot exceed potential return (${toUnitsString(bet.returnAmount)}).` }));
      return;
    }
    setCashOutConfirmIds((prev) => new Set(prev).add(bet.id));
  }, [cashOutValues]);

  const onCancelCashOutConfirm = useCallback((betId: string) => {
    setCashOutConfirmIds((prev) => {
      const next = new Set(prev);
      next.delete(betId);
      return next;
    });
  }, []);

  const resetQuickAdd = useCallback(() => {
    setQuickAddStake("");
    setQuickAddOddsTaken("");
    setQuickAddStatus("pending");
    setQuickAddNotes("");
    setQuickAddSelections([createSelectionDraft()]);
    setQuickAddErrors({});
    setQuickAddDuplicate(null);
  }, []);

  const onOpenQuickAdd = useCallback(() => {
    setShowQuickAdd(true);
    setMessage(null);
  }, []);

  const onCloseQuickAdd = useCallback(() => {
    setShowQuickAdd(false);
    resetQuickAdd();
    quickAddTriggerRef.current?.focus();
  }, [resetQuickAdd]);

  useEffect(() => {
    const onQuickAdd = () => onOpenQuickAdd();
    const onInsights = () => {
      const el = document.getElementById("bet-tracker-insights");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    const onTodayPl = () => {
      setSelectedStatus("all");
      setQuickDateFilter("today");
      setSortMode("dateDesc");
      const el = document.getElementById("bet-tracker-all-bets");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    const onTotalPl = () => {
      setSelectedStatus("all");
      setQuickDateFilter("all");
      const el = document.getElementById("bet-tracker-insights");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    const onOpenBets = () => {
      setSelectedStatus("pending");
      setQuickDateFilter("all");
      const el = document.getElementById("bet-tracker-all-bets");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    const onTotalBets = () => {
      setSelectedStatus("all");
      setQuickDateFilter("all");
      const el = document.getElementById("bet-tracker-all-bets");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener("app:quick-add-bet", onQuickAdd as EventListener);
    window.addEventListener("app:scroll-insights", onInsights as EventListener);
    window.addEventListener("app:sidebar-today-pl", onTodayPl as EventListener);
    window.addEventListener("app:sidebar-total-pl", onTotalPl as EventListener);
    window.addEventListener("app:sidebar-open-bets", onOpenBets as EventListener);
    window.addEventListener("app:sidebar-total-bets", onTotalBets as EventListener);
    return () => {
      window.removeEventListener("app:quick-add-bet", onQuickAdd as EventListener);
      window.removeEventListener("app:scroll-insights", onInsights as EventListener);
      window.removeEventListener("app:sidebar-today-pl", onTodayPl as EventListener);
      window.removeEventListener("app:sidebar-total-pl", onTotalPl as EventListener);
      window.removeEventListener("app:sidebar-open-bets", onOpenBets as EventListener);
      window.removeEventListener("app:sidebar-total-bets", onTotalBets as EventListener);
    };
  }, [onOpenQuickAdd]);

  useEffect(() => {
    if (!showQuickAdd) return;

    const modal = quickAddModalRef.current;
    if (!modal) return;

    const focusSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(", ");
    const getFocusable = () =>
      Array.from(modal.querySelectorAll<HTMLElement>(focusSelector)).filter((el) => !el.hasAttribute("disabled"));

    // Move initial focus into the modal for keyboard users.
    if (document.activeElement == null || !modal.contains(document.activeElement)) {
      const first = getFocusable()[0];
      first?.focus();
    }

    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (!showQuickAdd) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseQuickAdd();
        return;
      }
      if (event.key !== "Tab") return;
      if (!modal.contains(document.activeElement)) return;

      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, [showQuickAdd, onCloseQuickAdd]);

  const onAddSelectionRow = useCallback(() => {
    setQuickAddSelections((prev) => [...prev, createSelectionDraft()]);
  }, []);

  const onRemoveSelectionRow = useCallback((id: string) => {
    setQuickAddSelections((prev) => (prev.length <= 1 ? prev : prev.filter((row) => row.id !== id)));
    setQuickAddErrors((prev) => {
      if (!prev.selectionRows) return prev;
      const nextRows = { ...prev.selectionRows };
      delete nextRows[id];
      return { ...prev, selectionRows: nextRows };
    });
  }, []);

  const onChangeSelectionRow = useCallback((id: string, key: keyof QuickAddSelectionDraft, value: string) => {
    setQuickAddSelections((prev) => prev.map((row) => {
      if (row.id !== id) return row;
      if (key === "preset") {
        return selectionRowAfterPresetChange(row, value as QuickAddSelectionDraft["preset"]);
      }
      return { ...row, [key]: value };
    }));
    setQuickAddErrors((prev) => {
      if (key === "preset") {
        if (!prev.selectionRows?.[id]) return prev;
        const nextRows = { ...prev.selectionRows };
        delete nextRows[id];
        return Object.keys(nextRows).length > 0 ? { ...prev, selectionRows: nextRows } : { ...prev, selectionRows: undefined };
      }
      if (!prev.selectionRows?.[id]) return prev;
      const nextRows = { ...prev.selectionRows };
      const nextRow = { ...nextRows[id] };
      if (key === "matchLabel") delete nextRow.matchLabel;
      if (key === "playerName") delete nextRow.playerName;
      if (key === "teamName") delete nextRow.teamName;
      if (key === "line") delete nextRow.line;
      if (key === "outcome") delete nextRow.outcome;
      if (key === "marketName") delete nextRow.marketName;
      if (key === "selectionLabel") delete nextRow.selectionLabel;
      nextRows[id] = nextRow;
      return { ...prev, selectionRows: nextRows };
    });
  }, []);

  const performQuickAddSave = useCallback(async (savePayload: AddManualMultiBetInput) => {
    let created: Awaited<ReturnType<typeof addManualMultiBetShared>>;
    try {
      created = await addManualMultiBetShared(savePayload);
    } catch (err) {
      setQuickAddErrors({ selections: err instanceof Error ? err.message : "Save failed unexpectedly. Try again." });
      return;
    }
    if (!created) {
      const expl = explainManualMultiBetFailure(savePayload);
      const selectionRowsFromService: NonNullable<QuickAddErrors["selectionRows"]> = {};
      if (expl.selectionRowsByIndex) {
        for (const [idxStr, errs] of Object.entries(expl.selectionRowsByIndex)) {
          const idx = Number(idxStr);
          const row = quickAddSelections[idx];
          if (row) {
            selectionRowsFromService[row.id] = {
              ...selectionRowsFromService[row.id],
              matchLabel: errs.matchLabel,
              marketName: errs.marketName,
              selectionLabel: errs.selectionLabel,
              outcome: errs.outcome,
            };
          }
        }
      }
      setQuickAddErrors({
        stake: expl.stake,
        oddsTaken: expl.oddsTaken,
        selections: expl.selections,
        selectionRows: Object.keys(selectionRowsFromService).length > 0 ? selectionRowsFromService : undefined,
      });
      setQuickAddErrors((prev) => ({
        ...prev,
        selections: prev.selections || "Save failed (server unavailable).",
      }));
      return;
    }
    refresh();
    setMessage(`Quick add saved: ${created.legs.length} selections.`);
    setToast({ id: Date.now(), text: "Bet added" });
    setShowQuickAdd(false);
    resetQuickAdd();
  }, [quickAddSelections, refresh, resetQuickAdd]);

  const onSaveQuickAdd = useCallback(async () => {
    const nextErrors: QuickAddErrors = {};
    const stake = Number(quickAddStake);
    if (!Number.isFinite(stake) || stake <= 0) nextErrors.stake = "Stake must be greater than 0.";
    const oddsTaken = Number(quickAddOddsTaken);
    if (!Number.isFinite(oddsTaken) || oddsTaken <= 1) nextErrors.oddsTaken = "Odds must be greater than 1.";
    if (quickAddSelections.length === 0) nextErrors.selections = "Add at least one selection.";

    const rowErrors: NonNullable<QuickAddErrors["selectionRows"]> = {};
    const mappedSelections: ManualTrackedSelectionInput[] = quickAddSelections
      .map((row) => {
        const rowError: { preset?: string; matchLabel?: string; playerName?: string; teamName?: string; line?: string; outcome?: string; marketName?: string; selectionLabel?: string } = {};
        const mapped = buildSelectionFromPreset(row, rowError);
        if (
          rowError.preset ||
          rowError.matchLabel ||
          rowError.playerName ||
          rowError.teamName ||
          rowError.line ||
          rowError.outcome ||
          rowError.marketName ||
          rowError.selectionLabel
        ) {
          rowErrors[row.id] = rowError;
        }
        return mapped;
      })
      .filter((row): row is ManualTrackedSelectionInput => row != null);

    if (Object.keys(rowErrors).length > 0) nextErrors.selectionRows = rowErrors;
    if (Object.keys(nextErrors).length > 0) {
      setQuickAddErrors(nextErrors);
      return;
    }

    const unitSize = getUnitSize();
    const stakeUnits = unitSize > 0 ? stake / unitSize : stake;
    const savePayload = {
      stake: stakeUnits,
      oddsTaken,
      status: quickAddStatus,
      notes: quickAddNotes.trim() || undefined,
      selections: mappedSelections,
    };
    const matchLabels = new Set(mappedSelections.map((s) => normalizeDuplicateText(s.matchLabel)).filter(Boolean));
    const matchLabel = matchLabels.size === 1 ? mappedSelections[0]?.matchLabel : undefined;
    const duplicate = findDuplicateTrackedBet({
      matchLabel,
      legs: mappedSelections.map((s) => ({
        marketName: s.marketName,
        playerName: s.playerName,
        line: s.line,
        outcome: s.outcome,
      })),
    });
    if (duplicate) {
      setQuickAddDuplicate({ match: duplicate, payload: savePayload });
      if (import.meta.env.DEV) {
        console.log("[duplicate-check]", { incomingBet: savePayload, matchFound: duplicate });
      }
      return;
    }
    await performQuickAddSave(savePayload);
  }, [
    performQuickAddSave,
    quickAddStake,
    quickAddOddsTaken,
    quickAddSelections,
    quickAddStatus,
    quickAddNotes,
  ]);

  const onEvaluateValueBet = useCallback(async () => {
    setEvalError(null);
    setEvalResult(null);
    const line = Number(evalLine);
    const odds = Number(evalOdds);
    if (!evalPlayerName.trim()) {
      setEvalError("Enter player name.");
      return;
    }
    if (!Number.isFinite(line) || line < 0) {
      setEvalError("Enter a valid line.");
      return;
    }
    if (!Number.isFinite(odds) || odds <= 1) {
      setEvalError("Odds must be greater than 1.");
      return;
    }
    setEvalLoading(true);
    try {
      const result = await evaluateValueBet({
        playerName: evalPlayerName.trim(),
        market: evalMarket,
        line,
        odds,
      });
      setEvalResult(result);
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : "Could not evaluate bet.");
    } finally {
      setEvalLoading(false);
    }
  }, [evalLine, evalMarket, evalOdds, evalPlayerName]);

  const onExportSnapshot = useCallback(
    async (format: "png" | "svg") => {
      const svg = buildExportSvg({
        points: exportRangePoints,
        title: exportRangeTitle,
        rangeLabel: exportRangeLabel,
        profitUnits: exportRangeUnits,
      });
      const safeLabel = exportRangeLabel.replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "") || "all-time";
      const fileBase = `bet-tracker-${safeLabel}`.toLowerCase();
      if (format === "svg") {
        const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${fileBase}.svg`;
        link.click();
        URL.revokeObjectURL(url);
        return;
      }

      const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 920;
        canvas.height = 520;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((pngBlob) => {
          if (!pngBlob) return;
          const pngUrl = URL.createObjectURL(pngBlob);
          const link = document.createElement("a");
          link.href = pngUrl;
          link.download = `${fileBase}.png`;
          link.click();
          URL.revokeObjectURL(pngUrl);
        }, "image/png");
        URL.revokeObjectURL(url);
      };
      img.src = url;
    },
    [exportRangeLabel, exportRangePoints, exportRangeTitle, exportRangeUnits]
  );

  const onExportCsv = useCallback(() => {
    const rows: string[][] = [];
    rows.push(["Range", exportRangeLabel]);
    rows.push(["Profit (units)", exportRangeUnits.toFixed(2)]);
    rows.push([]);
    rows.push(["Date", "Match", "Status", "Stake (u)", "Return (u)", "Profit (u)", "Odds"]);
    for (const bet of exportRangeBets) {
      const profit = getBetProfit(bet);
      rows.push([
        bet.updatedAt || bet.createdAt,
        bet.matchLabel,
        getStatusLabel(bet.status),
        getBetStakeUnits(bet).toFixed(2),
        getBetReturnUnits(bet).toFixed(2),
        profit.toFixed(2),
        bet.oddsTaken.toFixed(2),
      ]);
    }
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const safeLabel = exportRangeLabel.replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "") || "all-time";
    const fileBase = `bet-tracker-${safeLabel}`.toLowerCase();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileBase}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [exportRangeBets, exportRangeLabel, exportRangeUnits]);

  return (
    <div className="bet-tracker-page">
      <div className="bet-tracker-page__header">
        <h1 className="bet-tracker-page__title">Bet Tracker</h1>
        <button ref={quickAddTriggerRef} type="button" className="bet-tracker-page__quick-add-btn" onClick={onOpenQuickAdd}>
          Quick Add Bet
        </button>
      </div>

      <section className="bet-tracker-page__section">
        <h2>Performance</h2>
        <div className="bet-tracker-page__performance-controls">
          <label>
            Export start
            <input
              type="date"
              value={exportStartDate}
              onChange={(e) => setExportStartDate(e.target.value)}
            />
          </label>
          <label>
            Export end
            <input
              type="date"
              value={exportEndDate}
              onChange={(e) => setExportEndDate(e.target.value)}
            />
          </label>
        </div>
        <div className="bet-tracker-page__export-card">
          <div className="bet-tracker-page__export-head">
            <div>
              <h3>Export Snapshot</h3>
              <p className="bet-tracker-page__export-subtitle">{exportRangeLabel}</p>
            </div>
            <div className="bet-tracker-page__export-actions">
              <button type="button" onClick={() => void onExportSnapshot("png")}>Download PNG</button>
              <button type="button" onClick={() => void onExportSnapshot("svg")}>Download SVG</button>
              <button type="button" onClick={onExportCsv}>Export CSV</button>
            </div>
          </div>
          <div className="bet-tracker-page__export-stats">
            <div>
              <span>P/L (units)</span>
              <strong className={exportRangeUnits >= 0 ? "bet-tracker-page__pl is-profit" : "bet-tracker-page__pl is-loss"}>
                {exportRangeUnits >= 0 ? "+" : "-"}{Math.abs(exportRangeUnits).toFixed(2)}
              </strong>
            </div>
            <div>
              <span>Settled bets</span>
              <strong>{exportRangeBets.length}</strong>
            </div>
          </div>
          <div className="bet-tracker-page__export-chart">
            <BankrollChart points={exportRangePoints} />
          </div>
        </div>
        <div className="bet-tracker-page__model-performance">
          <h3>Model Performance</h3>
          <div className="bet-tracker-page__bets-table-wrap">
            <table className="bet-tracker-page__bets-table">
              <thead>
                <tr>
                  <th>Score Band</th>
                  <th>Bets</th>
                  <th>Wins</th>
                  <th>Losses</th>
                  <th>Win %</th>
                  <th>Profit (u)</th>
                </tr>
              </thead>
              <tbody>
                {scoreBands.map((row) => (
                  <tr
                    key={row.label}
                    className={
                      row.total > 0 && row.label === scoreBandExtremes.best
                        ? "bet-tracker-page__band-row is-best"
                        : row.total > 0 && row.label === scoreBandExtremes.worst
                          ? "bet-tracker-page__band-row is-worst"
                          : "bet-tracker-page__band-row"
                    }
                  >
                    <td>
                      {row.label}
                      {row.total > 0 && row.label === scoreBandExtremes.best ? " ★" : ""}
                      {row.total > 0 && row.label === scoreBandExtremes.worst ? " ▼" : ""}
                    </td>
                    <td>{row.total}</td>
                    <td>{row.wins}</td>
                    <td>{row.losses}</td>
                    <td>{row.total > 0 ? `${(row.winRate * 100).toFixed(1)}%` : "—"}</td>
                    <td className={row.profit > 0 ? "bet-tracker-page__pl is-profit" : row.profit < 0 ? "bet-tracker-page__pl is-loss" : "bet-tracker-page__pl is-pending"}>
                      {fmtSignedUnits(row.profit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="bet-tracker-page__summary">
        <div className="bet-tracker-page__summary-card"><span>Total Bets</span><strong>{global.totalBets}</strong></div>
        <div className="bet-tracker-page__summary-card"><span>Settled</span><strong>{global.settledBets}</strong></div>
        <div className="bet-tracker-page__summary-card"><span>Pending</span><strong>{global.pendingBets}</strong></div>
        <div className="bet-tracker-page__summary-card"><span>Total Profit</span><strong>{fmtUnits(global.totalProfit)}</strong></div>
        <div className="bet-tracker-page__summary-card"><span>ROI</span><strong>{(global.roi * 100).toFixed(1)}%</strong></div>
        <div className="bet-tracker-page__summary-card"><span>Total Staked</span><strong>{fmtUnits(totals.totalStaked)}</strong></div>
        <div className="bet-tracker-page__summary-card"><span>Total Returned</span><strong>{fmtUnits(totals.totalReturned)}</strong></div>
        <div className="bet-tracker-page__summary-card"><span>Real ROI</span><strong>{(totals.roi * 100).toFixed(1)}%</strong></div>
      </section>

      <section className="bet-tracker-page__section" id="bet-tracker-insights">
        <h2>Insights</h2>
        <div className="bet-tracker-page__insights-grid">
          <article className="bet-tracker-page__insight-card">
            <h3>Performance by Odds Range</h3>
            <ul>
              {oddsRangePerformance.map((row) => (
                <li key={row.label}>
                  <span>{row.label} ({row.bets})</span>
                  <strong className={row.profit >= 0 ? "bet-tracker-page__pl is-profit" : "bet-tracker-page__pl is-loss"}>
                    {fmtSignedUnits(row.profit)} • {(row.winRate * 100).toFixed(1)}%
                  </strong>
                </li>
              ))}
            </ul>
          </article>
          <article className="bet-tracker-page__insight-card">
            <h3>Streaks</h3>
            <ul>
              <li><span>Current streak</span><strong>{streakStats.currentType ? `${streakStats.currentType} x${streakStats.current}` : "—"}</strong></li>
              <li><span>Longest win streak</span><strong>{streakStats.longestWin}</strong></li>
              <li><span>Longest losing streak</span><strong>{streakStats.longestLoss}</strong></li>
            </ul>
          </article>
          <article className="bet-tracker-page__insight-card">
            <h3>Best / Worst Bets</h3>
            <ul>
              <li><span>Highest profit</span><strong>{bestWorst.best ? `${bestWorst.best.matchLabel} (${fmtSignedUnits(getBetProfit(bestWorst.best))})` : "—"}</strong></li>
              <li><span>Biggest loss</span><strong>{bestWorst.worst ? `${bestWorst.worst.matchLabel} (${fmtSignedUnits(getBetProfit(bestWorst.worst))})` : "—"}</strong></li>
              <li><span>Highest odds win</span><strong>{bestWorst.highestOddsWin ? `${bestWorst.highestOddsWin.matchLabel} (${bestWorst.highestOddsWin.oddsTaken.toFixed(2)})` : "—"}</strong></li>
            </ul>
          </article>
          <article className="bet-tracker-page__insight-card">
            <h3>Recent Performance</h3>
            <ul>
              <li><span>Last 5</span><strong>{fmtSignedUnits(recentPerformance.last5.profit)} • {(recentPerformance.last5.winRate * 100).toFixed(1)}%</strong></li>
              <li><span>Last 10</span><strong>{fmtSignedUnits(recentPerformance.last10.profit)} • {(recentPerformance.last10.winRate * 100).toFixed(1)}%</strong></li>
            </ul>
          </article>
        </div>
      </section>

      <section className="bet-tracker-page__section">
        <h2>Value Bet Evaluator</h2>
        <div className="bet-tracker-page__evaluator">
          <label>
            Player name
            <input value={evalPlayerName} onChange={(e) => setEvalPlayerName(e.target.value)} placeholder="Cole Palmer" />
          </label>
          <label>
            Market
            <select value={evalMarket} onChange={(e) => setEvalMarket(e.target.value as ValueEvalMarket)}>
              <option value="shots">Shots</option>
              <option value="shotsOnTarget">Shots on Target</option>
              <option value="goals">Goals</option>
            </select>
          </label>
          <label>
            Line
            <input value={evalLine} onChange={(e) => setEvalLine(e.target.value)} placeholder="0.5" />
          </label>
          <label>
            Odds
            <input value={evalOdds} onChange={(e) => setEvalOdds(e.target.value)} placeholder="1.98" />
          </label>
          <button type="button" onClick={() => void onEvaluateValueBet()} disabled={evalLoading}>
            {evalLoading ? "Evaluating..." : "Evaluate Bet"}
          </button>
        </div>
        {evalError ? <p className="bet-tracker-page__error">{evalError}</p> : null}
        {evalResult ? (
          <div className="bet-tracker-page__eval-result">
            <h3>
              {evalResult.playerName} ({evalResult.market})
            </h3>
            <div className="bet-tracker-page__eval-grid">
              <div><span>Implied Probability</span><strong>{(evalResult.impliedProb * 100).toFixed(1)}%</strong></div>
              <div><span>Estimated Probability</span><strong>{(evalResult.estimatedProb * 100).toFixed(1)}%</strong></div>
              <div><span>Edge</span><strong className={evalResult.edge >= 0 ? "bet-tracker-page__pl is-profit" : "bet-tracker-page__pl is-loss"}>{(evalResult.edge * 100).toFixed(1)}%</strong></div>
              <div><span>Confidence</span><strong>{evalResult.confidence.toFixed(0)}%</strong></div>
              <div><span>Sample Size</span><strong>{evalResult.sampleSize} matches</strong></div>
              <div><span>Average Stat</span><strong>{evalResult.averageStat.toFixed(2)}</strong></div>
            </div>
            <p className={`bet-tracker-page__eval-verdict ${evalResult.verdict === "GOOD VALUE" ? "is-good" : evalResult.verdict === "BAD VALUE" ? "is-bad" : "is-neutral"}`}>
              {evalResult.verdict}
            </p>
            <p className="bet-tracker-page__eval-method">{evalResult.method}</p>
          </div>
        ) : null}
      </section>

      <section className="bet-tracker-page__section" id="bet-tracker-all-bets">
        <h2>All Bets</h2>
        <div className="bet-tracker-page__filters">
          <label>
            Status
            <select value={selectedStatus} onChange={(e) => setSelectedStatus(e.target.value as "all" | TrackedBetStatus)}>
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="win">Win</option>
              <option value="loss">Loss</option>
              <option value="cashed_out">Cashed out</option>
            </select>
          </label>
          <label>
            Min Score
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={minScore}
              onChange={(e) => setMinScore(e.target.value)}
              placeholder="0-100"
            />
          </label>
          <label>
            Sort
            <select value={sortMode} onChange={(e) => setSortMode(e.target.value as typeof sortMode)}>
              <option value="dateDesc">Newest</option>
              <option value="dateAsc">Oldest</option>
              <option value="modelDesc">Model Score (high-low)</option>
              <option value="modelAsc">Model Score (low-high)</option>
              <option value="plDesc">P/L (high-low)</option>
              <option value="plAsc">P/L (low-high)</option>
            </select>
          </label>
        </div>
        {message && <p className="bet-tracker-page__message">{message}</p>}
        {import.meta.env.DEV && (
          <div className="bet-tracker-page__debug-panel">
            <div className="bet-tracker-page__debug-stats">
              <span>Storage: <strong>{debugStorageCount}</strong></span>
              <span>Backup: <strong>{debugBackupExists ? `yes (${debugBackupCount})` : "no"}</strong></span>
              <span>Server count: <strong>{debugServerCount ?? "n/a"}</strong></span>
              <span>Last sync: <strong>{debugLastSync ? new Date(debugLastSync).toLocaleTimeString() : "n/a"}</strong></span>
              <span>Source: <strong>{debugSyncSource}</strong></span>
            </div>
            <button type="button" className="bet-tracker-page__restore-btn" onClick={onRestoreFromBackup}>
              Restore from Backup
            </button>
          </div>
        )}
        <div className="bet-tracker-page__list-actions">
          <button type="button" onClick={expandAllBets}>Expand All</button>
          <button type="button" onClick={collapseAllBets}>Collapse All</button>
        </div>
        {initialSyncLoading && bets.length === 0 ? (
          <div className="bet-tracker-page__loading-skeletons" aria-hidden="true">
            <div className="bet-tracker-page__loading-skeleton" />
            <div className="bet-tracker-page__loading-skeleton" />
            <div className="bet-tracker-page__loading-skeleton" />
          </div>
        ) : bets.length === 0 ? (
          <div className="bet-tracker-page__empty-state">
            <div className="bet-tracker-page__empty-icon">○</div>
            <p className="bet-tracker-page__empty">No bets yet — add your first bet to start tracking performance.</p>
          </div>
        ) : filteredAndSortedBets.length === 0 ? (
          <p className="bet-tracker-page__empty">No bets match current filters.</p>
        ) : (
          <div className="bet-tracker-page__bet-cards">
            {filteredAndSortedBets.map(({ b, modelScore, normalizedScore, pl }) => {
              const isExpanded = expandedBetIds.has(b.id);
              const modelBadge =
                typeof modelScore === "number" || typeof normalizedScore === "number";
              const scoreClass =
                typeof normalizedScore === "number"
                  ? normalizedScore >= 80
                    ? "bet-tracker-page__score score-high"
                    : normalizedScore >= 60
                      ? "bet-tracker-page__score score-mid"
                      : "bet-tracker-page__score score-low"
                  : "bet-tracker-page__score";
              const cardStatusClass =
                b.status === "win"
                  ? "bet-tracker-page__bet-card is-win"
                  : b.status === "loss"
                    ? "bet-tracker-page__bet-card is-loss"
                    : b.status === "cashed_out"
                      ? "bet-tracker-page__bet-card is-cashed-out"
                      : "bet-tracker-page__bet-card";
              const deleting = deletingBetIds.has(b.id);
              const cashOutOpen = cashOutOpenIds.has(b.id);
              const cashOutError = cashOutErrors[b.id];
              const cashOutConfirm = cashOutConfirmIds.has(b.id);
              const cashOutInput = cashOutValues[b.id] ?? "";
              const cashOutAmount = b.cashOutAmount ?? b.returnAmount;
              const cashOutInputValue = Number(cashOutInput);
              const hasCashOutInput = Number.isFinite(cashOutInputValue) && cashOutInputValue > 0;
              const cashOutProfit = hasCashOutInput ? cashOutInputValue - getBetStakeUnits(b) : 0;

                  return (
                    <article
                      key={b.id}
                      className={`${cardStatusClass}${deleting ? " is-deleting" : ""}`}
                      onClick={() => toggleBetExpanded(b.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleBetExpanded(b.id);
                        }
                      }}
                    >
                      <header className="bet-tracker-page__bet-card-top">
                        <div className="bet-tracker-page__bet-main">
                          <h3 className="bet-tracker-page__bet-match">
                            {b.matchLabel}
                            <span className="bet-tracker-page__bet-meta-inline">
                              {fmtRelativeDate(b.createdAt)}
                            </span>
                          </h3>
                          {isExpanded && b.sourceType === "manualMulti" && <span className="bet-tracker-page__source-tag">Custom Multi</span>}
                        </div>
                        <div className="bet-tracker-page__bet-inline-metrics">
                          <span className="bet-tracker-page__metric-stack" title="Decimal odds">
                            <span className="bet-tracker-page__metric-label">ODDS</span>
                            <span className="bet-tracker-page__inline-value">{b.oddsTaken.toFixed(2)}</span>
                          </span>
                          <span className="bet-tracker-page__metric-stack">
                            <span className="bet-tracker-page__metric-label">STAKE</span>
                            <span className="bet-tracker-page__inline-value">{fmtUnits(getBetStakeUnits(b))}</span>
                          </span>
                          <span className="bet-tracker-page__metric-stack" title="Profit / Loss">
                            <span className="bet-tracker-page__metric-label">P/L</span>
                            <span className={`bet-tracker-page__inline-value bet-tracker-page__inline-value--pl ${pl > 0 ? "bet-tracker-page__pl is-profit" : pl < 0 ? "bet-tracker-page__pl is-loss" : "bet-tracker-page__pl is-pending"}`}>
                              {fmtSignedUnits(pl)}
                            </span>
                          </span>
                          <button
                            type="button"
                            className={`bet-tracker-page__status-chip status-${b.status}${statusPulseBetIds.has(b.id) ? " is-pulse" : ""}`}
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (b.status === "cashed_out") return;
                              const next = getNextStatus(b.status);
                              await onStatusChange(b.id, next);
                            }}
                            title="Cycle status: pending → win → loss"
                            disabled={b.status === "cashed_out"}
                          >
                            {getStatusLabel(b.status)}
                          </button>
                        </div>
                        <div className={`bet-tracker-page__chevron${isExpanded ? " is-expanded" : ""}`} aria-hidden="true">
                          ▾
                        </div>
                      </header>

                      {isExpanded && (
                        <section className="bet-tracker-page__bet-selections is-expanded">
                          <ul className="bet-tracker-page__bet-selection-list">
                            {b.legs.map((l, i) => (
                              <li key={`${b.id}-leg-${i}`}>
                                <span className="bet-tracker-page__leg-main">
                                  {l.matchLabel ?? b.matchLabel} —{" "}
                                  {formatBetLegDisplayLabel({
                                    type: l.type,
                                    marketFamily: l.marketFamily,
                                    marketName: l.marketName,
                                    marketId: l.marketId,
                                    playerName: l.playerName,
                                    line: l.line,
                                    outcome: l.outcome,
                                    label: l.label,
                                  })}
                                </span>
                                <span className="bet-tracker-page__leg-sub">
                                  {[l.leagueName, l.kickoffTime, l.odds != null ? `Odds ${l.odds.toFixed(2)}` : null, l.legNotes ? `Note: ${l.legNotes}` : null]
                                    .filter(Boolean)
                                    .join(" | ") || "No extra details"}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}

                      {isExpanded && (
                      <footer className="bet-tracker-page__bet-card-bottom">
                        <div className="bet-tracker-page__bet-badges">{isExpanded && modelBadge && (
                          <span className="bet-tracker-page__bet-badge">
                            Model {typeof modelScore === "number" ? Math.round(modelScore) : "—"} | Score{" "}
                            <span className={scoreClass}>{typeof normalizedScore === "number" ? Math.round(normalizedScore) : "—"}</span>
                          </span>
                        )}{isExpanded && (
                          <span className="bet-tracker-page__bet-badge">
                            Return {fmtUnits(getBetReturnUnits(b))}
                          </span>
                        )}{b.status === "cashed_out" && (
                          <span className="bet-tracker-page__bet-badge bet-tracker-page__bet-badge--cashout">
                            Cashed Out
                          </span>
                        )}{b.status === "cashed_out" && (
                          <span className="bet-tracker-page__bet-badge bet-tracker-page__bet-badge--cashout">
                            Cashed Out: {fmtUnits(cashOutAmount)}
                          </span>
                        )}{b.status === "cashed_out" && (
                          <span className="bet-tracker-page__bet-badge bet-tracker-page__bet-badge--cashout">
                            Profit: {fmtSignedUnits(getBetProfit(b))}
                          </span>
                        )}{duplicateBetIds.has(b.id) && (
                          <span className="bet-tracker-page__bet-badge bet-tracker-page__bet-badge--duplicate">
                            Duplicate
                          </span>
                        )}</div>
                        <div className="bet-tracker-page__bet-controls">
                          <select
                            className={`bet-tracker-page__status-select status-${b.status}`}
                            value={b.status}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => onStatusChange(b.id, e.target.value as TrackedBetStatus)}
                            disabled={b.status === "cashed_out"}
                          >
                            <option value="pending">pending</option>
                            <option value="win">win</option>
                            <option value="loss">loss</option>
                            {b.status === "cashed_out" ? <option value="cashed_out">cashed out</option> : null}
                          </select>
                          {b.status === "pending" && (
                            <button
                              type="button"
                              className="bet-tracker-page__cashout-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenCashOut(b.id);
                              }}
                            >
                              Cash Out
                            </button>
                          )}
                          <button
                            type="button"
                            className="bet-tracker-page__delete-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              void onDeleteBet(b.id);
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </footer>
                      )}
                      {isExpanded && b.status === "pending" && cashOutOpen && (
                        <div
                          className="bet-tracker-page__cashout-panel"
                          onClick={(e) => e.stopPropagation()}
                          role="group"
                          aria-label="Cash out bet"
                        >
                          <label>
                            Cash out amount (units)
                            <input
                              type="number"
                              min={0.01}
                              step={0.01}
                              placeholder="Enter cash out amount"
                              value={cashOutInput}
                              onChange={(e) => {
                                const v = sanitizeCashOutInput(e.target.value);
                                setCashOutValues((prev) => ({ ...prev, [b.id]: v }));
                                setCashOutErrors((prev) => {
                                  if (!prev[b.id]) return prev;
                                  const next = { ...prev };
                                  delete next[b.id];
                                  return next;
                                });
                              }}
                              onBlur={(e) => {
                                const v = sanitizeCashOutInput(e.target.value);
                                const n = Number(v);
                                if (Number.isFinite(n)) {
                                  setCashOutValues((prev) => ({ ...prev, [b.id]: n.toFixed(2) }));
                                }
                              }}
                            />
                          </label>
                          {hasCashOutInput && (
                            <div className="bet-tracker-page__cashout-preview">
                              {cashOutProfit >= 0 ? "Profit" : "Loss"}: {fmtSignedUnits(cashOutProfit)}
                            </div>
                          )}
                          {cashOutError && <span className="bet-tracker-page__error-inline">{cashOutError}</span>}
                          {cashOutConfirm ? (
                            <div className="bet-tracker-page__cashout-confirm">
                              <p>
                                Are you sure you want to cash out this bet for{" "}
                                <strong>{hasCashOutInput ? toUnitsString(cashOutInputValue) : "0.00u"}</strong>?
                              </p>
                              <div className="bet-tracker-page__cashout-actions">
                                <button
                                  type="button"
                                  className="secondary"
                                  onClick={() => onCancelCashOutConfirm(b.id)}
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void onConfirmCashOut(b)}
                                >
                                  Confirm Cash Out
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="bet-tracker-page__cashout-actions">
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => onCloseCashOut(b.id)}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => onRequestCashOutConfirm(b)}
                              >
                                Confirm
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
          </div>
        )}
      </section>

      {showQuickAdd && (
        <div className="bet-tracker-page__quick-add-overlay" role="dialog" aria-modal="true" aria-label="Quick Add Multi Bet">
          <div ref={quickAddModalRef} className="bet-tracker-page__quick-add-modal">
            <div className="bet-tracker-page__quick-add-head">
              <h2>Quick Add Multi Bet</h2>
              <button type="button" onClick={onCloseQuickAdd}>Close</button>
            </div>
            <div className="bet-tracker-page__quick-add-grid">
              <label>
                Stake (£)
                <input
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={quickAddStake}
                  onChange={(e) => {
                    const nextStake = e.target.value;
                    setQuickAddStake(nextStake);
                  }}
                />
                {quickAddErrors.stake && <span className="bet-tracker-page__error-inline">{quickAddErrors.stake}</span>}
              </label>
              <label>
                Odds Taken
                <input
                  type="number"
                  min={1.01}
                  step={0.01}
                  value={quickAddOddsTaken}
                  onChange={(e) => {
                    const nextOdds = e.target.value;
                    setQuickAddOddsTaken(nextOdds);
                  }}
                />
                {quickAddErrors.oddsTaken && <span className="bet-tracker-page__error-inline">{quickAddErrors.oddsTaken}</span>}
              </label>
              <label>
                Status
                <select value={quickAddStatus} onChange={(e) => setQuickAddStatus(e.target.value as TrackedBetStatus)}>
                  <option value="pending">pending</option>
                  <option value="win">win</option>
                  <option value="loss">loss</option>
                </select>
              </label>
            </div>
            <div className="bet-tracker-page__quick-add-derived">
              <span>Return: <strong>{fmtPounds(quickAddReturnValue)}</strong></span>
              <span>Stake: <strong>{fmtPounds(quickAddStakeValue || 0)}</strong></span>
            </div>
            <label className="bet-tracker-page__quick-add-notes">
              Notes (optional)
              <textarea rows={2} value={quickAddNotes} onChange={(e) => setQuickAddNotes(e.target.value)} placeholder="Optional notes" />
            </label>

            <div className="bet-tracker-page__quick-add-selections-head">
              <h3>Selections</h3>
              <button type="button" onClick={onAddSelectionRow}>Add Selection</button>
            </div>
            {quickAddErrors.selections && <p className="bet-tracker-page__error-inline">{quickAddErrors.selections}</p>}

            <div className="bet-tracker-page__quick-add-selections">
              {quickAddSelections.map((row, index) => {
                const rowErr = quickAddErrors.selectionRows?.[row.id];
                return (
                  <div key={row.id} className="bet-tracker-page__quick-add-selection-row">
                    <div className="bet-tracker-page__quick-add-selection-row-head">
                      <strong>Selection {index + 1}</strong>
                      <div className="bet-tracker-page__quick-add-selection-row-actions">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() =>
                            setQuickAddSelections((prev) =>
                              prev.map((r) => (r.id === row.id ? { ...r, showMoreDetails: !r.showMoreDetails } : r))
                            )
                          }
                        >
                          {row.showMoreDetails ? "Hide details" : "More details"}
                        </button>
                        <button type="button" onClick={() => onRemoveSelectionRow(row.id)} disabled={quickAddSelections.length <= 1}>
                          Remove
                        </button>
                      </div>
                    </div>
                    <div className="bet-tracker-page__quick-add-selection-grid">
                      <label>
                        Preset
                        <select
                          value={row.preset}
                          onChange={(e) => onChangeSelectionRow(row.id, "preset", e.target.value)}
                        >
                          <option value="">Choose preset</option>
                          {QUICK_ADD_PRESETS.map((preset) => (
                            <option key={preset.value} value={preset.value}>{preset.label}</option>
                          ))}
                        </select>
                        {rowErr?.preset && <span className="bet-tracker-page__error-inline">{rowErr.preset}</span>}
                      </label>
                      <label>
                        Match
                        <input value={row.matchLabel} onChange={(e) => onChangeSelectionRow(row.id, "matchLabel", e.target.value)} placeholder="Arsenal v Liverpool" />
                        {rowErr?.matchLabel && <span className="bet-tracker-page__error-inline">{rowErr.matchLabel}</span>}
                      </label>
                      {(row.preset === "playerShotsOver" ||
                        row.preset === "playerShotsOnTargetOver" ||
                        row.preset === "playerFoulsCommittedOver" ||
                        row.preset === "playerFoulsWonOver" ||
                        row.preset === "playerTacklesOver") && (
                        <>
                          <label>
                            Player
                            <input value={row.playerName} onChange={(e) => onChangeSelectionRow(row.id, "playerName", e.target.value)} placeholder="Bukayo Saka" />
                            {rowErr?.playerName && <span className="bet-tracker-page__error-inline">{rowErr.playerName}</span>}
                          </label>
                          <label>
                            Line
                            <input type="number" step={0.01} value={row.line} onChange={(e) => onChangeSelectionRow(row.id, "line", e.target.value)} placeholder="1.5" />
                            {rowErr?.line && <span className="bet-tracker-page__error-inline">{rowErr.line}</span>}
                          </label>
                        </>
                      )}
                      {row.preset === "overGoals" && (
                        <>
                          <label>
                            Line
                            <input type="number" step={0.01} value={row.line} onChange={(e) => onChangeSelectionRow(row.id, "line", e.target.value)} placeholder="2.5" />
                            {rowErr?.line && <span className="bet-tracker-page__error-inline">{rowErr.line}</span>}
                          </label>
                          <label>
                            Side
                            <select value={row.outcome} onChange={(e) => onChangeSelectionRow(row.id, "outcome", e.target.value)}>
                              <option value="Over">Over</option>
                              <option value="Under">Under</option>
                            </select>
                            {rowErr?.outcome && <span className="bet-tracker-page__error-inline">{rowErr.outcome}</span>}
                          </label>
                        </>
                      )}
                      {(row.preset === "teamCornersOver" || row.preset === "teamCardsOver") && (
                        <>
                          <label>
                            Team
                            <input value={row.teamName} onChange={(e) => onChangeSelectionRow(row.id, "teamName", e.target.value)} placeholder="Arsenal" />
                            {rowErr?.teamName && <span className="bet-tracker-page__error-inline">{rowErr.teamName}</span>}
                          </label>
                          <label>
                            Line
                            <input type="number" step={0.01} value={row.line} onChange={(e) => onChangeSelectionRow(row.id, "line", e.target.value)} placeholder="4.5" />
                            {rowErr?.line && <span className="bet-tracker-page__error-inline">{rowErr.line}</span>}
                          </label>
                        </>
                      )}
                      {row.preset === "btts" && (
                        <label>
                          Side
                          <select value={row.outcome} onChange={(e) => onChangeSelectionRow(row.id, "outcome", e.target.value)}>
                            <option value="Yes">Yes</option>
                            <option value="No">No</option>
                          </select>
                          {rowErr?.outcome && <span className="bet-tracker-page__error-inline">{rowErr.outcome}</span>}
                        </label>
                      )}
                      {row.preset === "matchResult" && (
                        <label>
                          Result
                          <select value={row.outcome} onChange={(e) => onChangeSelectionRow(row.id, "outcome", e.target.value)}>
                            <option value="Home">Home</option>
                            <option value="Draw">Draw</option>
                            <option value="Away">Away</option>
                          </select>
                          {rowErr?.outcome && <span className="bet-tracker-page__error-inline">{rowErr.outcome}</span>}
                        </label>
                      )}
                      {row.preset === "custom" && (
                        <>
                          <label>
                            Market
                            <input value={row.marketName} onChange={(e) => onChangeSelectionRow(row.id, "marketName", e.target.value)} placeholder="Shots on target" />
                            {rowErr?.marketName && <span className="bet-tracker-page__error-inline">{rowErr.marketName}</span>}
                          </label>
                          <label>
                            Selection
                            <input value={row.selectionLabel} onChange={(e) => onChangeSelectionRow(row.id, "selectionLabel", e.target.value)} placeholder="Over 1.5" />
                            {rowErr?.selectionLabel && <span className="bet-tracker-page__error-inline">{rowErr.selectionLabel}</span>}
                          </label>
                          <label>
                            Player/Team
                            <input value={row.playerName} onChange={(e) => onChangeSelectionRow(row.id, "playerName", e.target.value)} placeholder="Optional" />
                          </label>
                          <label>
                            Line
                            <input type="number" step={0.01} value={row.line} onChange={(e) => onChangeSelectionRow(row.id, "line", e.target.value)} placeholder="Optional" />
                          </label>
                          <label>
                            Side
                            <select
                              value={row.outcome}
                              onChange={(e) => {
                                const nextOutcome = e.target.value === "None" ? "" : e.target.value;
                                onChangeSelectionRow(row.id, "outcome", nextOutcome);
                              }}
                            >
                              {QUICK_ADD_OUTCOMES.map((o) => (
                                <option key={o.label} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                            {rowErr?.outcome && <span className="bet-tracker-page__error-inline">{rowErr.outcome}</span>}
                          </label>
                        </>
                      )}
                    </div>
                    {row.showMoreDetails && (
                      <div className="bet-tracker-page__quick-add-selection-details">
                        <label>
                          League
                          <input value={row.leagueName} onChange={(e) => onChangeSelectionRow(row.id, "leagueName", e.target.value)} placeholder="Premier League" />
                        </label>
                        <label>
                          Kickoff
                          <input value={row.kickoffTime} onChange={(e) => onChangeSelectionRow(row.id, "kickoffTime", e.target.value)} placeholder="2026-03-19 20:00" />
                        </label>
                        <label>
                          Leg Odds
                          <input type="number" step={0.01} min={1.01} value={row.odds} onChange={(e) => onChangeSelectionRow(row.id, "odds", e.target.value)} placeholder="2.10" />
                        </label>
                        <label>
                          Row Notes
                          <input value={row.rowNotes} onChange={(e) => onChangeSelectionRow(row.id, "rowNotes", e.target.value)} placeholder="Optional extra detail" />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="bet-tracker-page__quick-add-actions">
              {quickAddDuplicate && (
                <div className="bet-tracker-page__duplicate-warning">
                  <p className="bet-tracker-page__duplicate-title">⚠️ You already have a similar bet tracked.</p>
                  <p className="bet-tracker-page__duplicate-sub">
                    Existing: {(() => {
                      const bet = quickAddDuplicate.match.existingBet;
                      const baseUnits = getBetStakeUnits(bet);
                      const unitSizeAtBet = Number.isFinite(bet.unitSizeAtBet as number) && (bet.unitSizeAtBet as number) > 0
                        ? (bet.unitSizeAtBet as number)
                        : getUnitSize();
                      return fmtPounds(baseUnits * unitSizeAtBet);
                    })()} @ {quickAddDuplicate.match.existingBet.oddsTaken.toFixed(2)}
                  </p>
                  <div className="bet-tracker-page__duplicate-actions">
                    <button type="button" className="secondary" onClick={() => setQuickAddDuplicate(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const payload = quickAddDuplicate.payload;
                        setQuickAddDuplicate(null);
                        void performQuickAddSave(payload);
                      }}
                    >
                      Add Anyway
                    </button>
                  </div>
                </div>
              )}
              <button type="button" className="secondary" onClick={onCloseQuickAdd}>Cancel</button>
              <button type="button" onClick={onSaveQuickAdd}>Save Bet</button>
            </div>
          </div>
        </div>
      )}
      {toast ? (
        <div key={toast.id} className="bet-tracker-page__toast" role="status" aria-live="polite">
          {toast.text}
        </div>
      ) : null}

    </div>
  );
}

