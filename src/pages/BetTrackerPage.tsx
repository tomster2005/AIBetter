import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addBookmaker,
  addManualMultiBetShared,
  explainManualMultiBetFailure,
  getAllBookmakerStats,
  getBankrollTimeline,
  getBookmakers,
  getBalanceAdjustments,
  getUnitSize,
  refreshTrackedBetsFromServer,
  restoreTrackedBetsFromBackup,
  settlePendingTrackedBets,
  getTrackedBetsDebugState,
  getScoreBandAnalysis,
  setUnitSize,
  getTrackedBetStats,
  getTrackedBets,
  adjustBalance,
  deleteTrackedBetShared,
  updateTrackedBetStatusShared,
  type BookmakerStats,
  type ManualTrackedSelectionInput,
  type ScoreBandAnalysisRow,
  type BalanceAdjustment,
  type BalanceAdjustmentType,
  type TrackedBetRecord,
  type TrackedBetStatus,
} from "../services/betTrackerService.js";
import { formatBetLegDisplayLabel } from "../lib/betLegDisplayLabel.js";
import { BankrollChart } from "../components/BankrollChart.js";
import { evaluateValueBet, type ValueEvalMarket, type ValueEvalResult } from "../services/valueEvaluatorService.js";
import "./BetTrackerPage.css";

function fmtMoney(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : "0.00";
}

function fmtSignedMoney(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "£0.00";
  return `${v > 0 ? "+" : "-"}£${Math.abs(v).toFixed(2)}`;
}

function fmtAdjustmentLine(a: BalanceAdjustment): string {
  const label = a.type === "deposit" ? "Deposit" : a.type === "withdrawal" ? "Withdrawal" : "Correction";
  const sign = a.amount >= 0 ? "+" : "-";
  return `${sign}£${Math.abs(a.amount).toFixed(2)} ${label}`;
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

export type QuickAddSelectionDraft = {
  id: string;
  preset:
    | ""
    | "playerShotsOver"
    | "playerShotsOnTargetOver"
    | "playerFoulsCommittedOver"
    | "playerFoulsWonOver"
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
  bookmakerId?: string;
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
  { value: "overGoals", label: "Over Goals" },
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

  if (row.preset === "playerShotsOver" || row.preset === "playerShotsOnTargetOver" || row.preset === "playerFoulsCommittedOver" || row.preset === "playerFoulsWonOver") {
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
            : "Fouls Won";
    selectionLabel = `${player} ${metric} Over ${lineVal}`;
    selectionOutcome = "Over";
  } else if (row.preset === "overGoals") {
    if (!Number.isFinite(lineVal)) rowError.line = "Line is required.";
    if (rowError.matchLabel || rowError.line) return null;
    line = lineVal;
    selectionLabel = `Over ${lineVal} Goals`;
    selectionOutcome = "Over";
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
  const [name, setName] = useState("");
  const [startingBalance, setStartingBalance] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [bookmakers, setBookmakers] = useState<BookmakerStats[]>([]);
  const [balanceAdjustments, setBalanceAdjustments] = useState<BalanceAdjustment[]>([]);
  const [bets, setBets] = useState<TrackedBetRecord[]>([]);
  const [selectedStatus, setSelectedStatus] = useState<"all" | TrackedBetStatus>("all");
  const [selectedBookmakerId, setSelectedBookmakerId] = useState<string>("all");
  const [minScore, setMinScore] = useState<string>("");
  const [sortMode, setSortMode] = useState<"dateDesc" | "dateAsc" | "modelDesc" | "modelAsc" | "plDesc" | "plAsc">("dateDesc");
  const [timelineBookmakerId, setTimelineBookmakerId] = useState<string>("all");
  const [unitSizeInput, setUnitSizeInput] = useState<string>("2");
  const [message, setMessage] = useState<string | null>(null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickAddBookmakerId, setQuickAddBookmakerId] = useState("");
  const [quickAddStake, setQuickAddStake] = useState("");
  const [quickAddOddsTaken, setQuickAddOddsTaken] = useState("");
  const [quickAddStatus, setQuickAddStatus] = useState<TrackedBetStatus>("pending");
  const [quickAddNotes, setQuickAddNotes] = useState("");
  const [quickAddSelections, setQuickAddSelections] = useState<QuickAddSelectionDraft[]>([createSelectionDraft()]);
  const [quickAddErrors, setQuickAddErrors] = useState<QuickAddErrors>({});
  const [expandedBetIds, setExpandedBetIds] = useState<Set<string>>(new Set());
  const [deletingBetIds, setDeletingBetIds] = useState<Set<string>>(new Set());
  const [statusPulseBetIds, setStatusPulseBetIds] = useState<Set<string>>(new Set());
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
  const quickAddBookmakerRef = useRef<HTMLSelectElement | null>(null);

  const [adjustModalOpen, setAdjustModalOpen] = useState(false);
  const [adjustBookmakerId, setAdjustBookmakerId] = useState<string | null>(null);
  const [adjustType, setAdjustType] = useState<BalanceAdjustmentType>("deposit");
  const [adjustAmount, setAdjustAmount] = useState<string>("");
  const [adjustNote, setAdjustNote] = useState<string>("");
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const adjustAmountRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(() => {
    setBookmakers(getAllBookmakerStats());
    setBalanceAdjustments(getBalanceAdjustments());
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
      await refreshTrackedBetsFromServer();
      if (cancelled) return;
      await settlePendingTrackedBets();
      if (!cancelled) {
        refresh();
        setInitialSyncLoading(false);
      }
    };
    void pull();
    const t = window.setInterval(() => {
      void pull();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!adjustModalOpen) return;
    adjustAmountRef.current?.focus();
  }, [adjustModalOpen]);
  useEffect(() => {
    setUnitSizeInput(getUnitSize().toString());
  }, []);

  const global = useMemo(() => getTrackedBetStats(), [bookmakers, bets]);
  const timelinePoints = useMemo(
    () => getBankrollTimeline(timelineBookmakerId === "all" ? undefined : timelineBookmakerId),
    [bets, bookmakers, timelineBookmakerId]
  );
  const scoreBands = useMemo<ScoreBandAnalysisRow[]>(() => getScoreBandAnalysis(), [bets]);
  const settledBets = useMemo(() => bets.filter((b) => b.status !== "pending"), [bets]);
  const totals = useMemo(() => {
    const totalStaked = settledBets.reduce((sum, b) => sum + b.stake, 0);
    const totalReturned = settledBets.reduce((sum, b) => sum + (b.status === "win" ? b.returnAmount : 0), 0);
    const totalProfit = totalReturned - totalStaked;
    const roi = totalStaked > 0 ? totalProfit / totalStaked : 0;
    return { totalStaked, totalReturned, totalProfit, roi };
  }, [settledBets]);
  const bookmakerPerformance = useMemo(() => {
    return bookmakers
      .map((b) => ({
        name: b.bookmakerName,
        bets: b.settledCount,
        profit: b.realizedProfit,
        roi: b.roi,
      }))
      .sort((a, b) => b.profit - a.profit);
  }, [bookmakers]);
  const oddsRangePerformance = useMemo(() => {
    const ranges = [
      { label: "1.0-2.0", min: 1, max: 2 },
      { label: "2.0-3.0", min: 2, max: 3 },
      { label: "3.0-5.0", min: 3, max: 5 },
      { label: "5.0+", min: 5, max: Number.POSITIVE_INFINITY },
    ];
    return ranges.map((r) => {
      const inRange = settledBets.filter((b) => b.oddsTaken >= r.min && b.oddsTaken < r.max);
      const wins = inRange.filter((b) => b.status === "win").length;
      const profit = inRange.reduce((sum, b) => sum + (b.status === "win" ? b.returnAmount - b.stake : -b.stake), 0);
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
      const t = b.status === "win" ? "win" : "loss";
      if (runType === t) run += 1;
      else {
        runType = t;
        run = 1;
      }
      if (t === "win") longestWin = Math.max(longestWin, run);
      else longestLoss = Math.max(longestLoss, run);
    }
    if (ordered.length > 0) {
      const last = ordered[ordered.length - 1]!.status === "win" ? "win" : "loss";
      currentType = last;
      current = 0;
      for (let i = ordered.length - 1; i >= 0; i--) {
        const t = ordered[i]!.status === "win" ? "win" : "loss";
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
    const profitOf = (b: TrackedBetRecord) => (b.status === "win" ? b.returnAmount - b.stake : -b.stake);
    const best = [...settledBets].sort((a, b) => profitOf(b) - profitOf(a))[0] ?? null;
    const worst = [...settledBets].sort((a, b) => profitOf(a) - profitOf(b))[0] ?? null;
    const highestOddsWin =
      [...settledBets].filter((b) => b.status === "win").sort((a, b) => b.oddsTaken - a.oddsTaken)[0] ?? null;
    return { best, worst, highestOddsWin };
  }, [settledBets]);
  const recentPerformance = useMemo(() => {
    const ordered = [...settledBets].sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
    const calc = (n: number) => {
      const sample = ordered.slice(0, n);
      const wins = sample.filter((b) => b.status === "win").length;
      const profit = sample.reduce((sum, b) => sum + (b.status === "win" ? b.returnAmount - b.stake : -b.stake), 0);
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
  const availableBookmakers = useMemo(() => getBookmakers(), [bookmakers]);
  const adjustmentsByBookmakerId = useMemo(() => {
    const m = new Map<string, BalanceAdjustment[]>();
    for (const adj of balanceAdjustments) {
      const arr = m.get(adj.bookmakerId);
      if (arr) arr.push(adj);
      else m.set(adj.bookmakerId, [adj]);
    }
    return m;
  }, [balanceAdjustments]);

  const getAdjustmentsForBookmaker = useCallback(
    (bookmakerId: string) => adjustmentsByBookmakerId.get(bookmakerId) ?? [],
    [adjustmentsByBookmakerId]
  );
  const currentUnitSize = useMemo(() => {
    const n = Number(unitSizeInput);
    return Number.isFinite(n) && n > 0 ? n : getUnitSize();
  }, [unitSizeInput]);
  const quickAddStakeValue = Number(quickAddStake);
  const quickAddOddsValue = Number(quickAddOddsTaken);
  const quickAddReturnValue =
    Number.isFinite(quickAddStakeValue) && Number.isFinite(quickAddOddsValue) ? Math.max(0, quickAddStakeValue * quickAddOddsValue) : 0;
  const quickAddStakeUnits =
    Number.isFinite(quickAddStakeValue) && currentUnitSize > 0 ? Math.max(0, quickAddStakeValue / currentUnitSize) : 0;
  const quickAddReturnUnits =
    Number.isFinite(quickAddReturnValue) && currentUnitSize > 0 ? Math.max(0, quickAddReturnValue / currentUnitSize) : 0;

  const filteredAndSortedBets = useMemo(() => {
    const parsedMinScore = minScore.trim() === "" ? null : Number(minScore);
    const hasMinScore = parsedMinScore != null && Number.isFinite(parsedMinScore);

    const withDerived = bets
      .map((b) => {
        const modelScore = b.sourceMeta?.modelScore;
        const normalizedScore = b.sourceMeta?.normalizedScore;
        const pl = b.status === "win" ? b.returnAmount - b.stake : b.status === "loss" ? -b.stake : 0;
        return { b, modelScore, normalizedScore, pl };
      })
      .filter(({ b, normalizedScore }) => {
        if (selectedStatus !== "all" && b.status !== selectedStatus) return false;
        if (selectedBookmakerId !== "all" && b.bookmakerId !== selectedBookmakerId) return false;
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
  }, [bets, minScore, selectedBookmakerId, selectedStatus, sortMode]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.log("[bet-tracker visibility]", {
      totalBets: bets.length,
      visibleBets: filteredAndSortedBets.length,
      hiddenByFilters: Math.max(0, bets.length - filteredAndSortedBets.length),
      filters: {
        status: selectedStatus,
        bookmakerId: selectedBookmakerId,
        minScore: minScore.trim() === "" ? null : minScore,
        sortMode,
      },
    });
  }, [bets.length, filteredAndSortedBets.length, minScore, selectedBookmakerId, selectedStatus, sortMode]);

  const onAddBookmaker = useCallback(() => {
    const n = name.trim();
    const balance = Number(startingBalance);
    if (!n) {
      setError("Enter bookmaker name.");
      return;
    }
    if (!Number.isFinite(balance) || balance < 0) {
      setError("Enter a valid starting balance.");
      return;
    }
    const created = addBookmaker(n, balance);
    if (!created) {
      setError("Bookmaker could not be added (name may already exist).");
      return;
    }
    setName("");
    setStartingBalance("");
    setError(null);
    refresh();
  }, [name, startingBalance, refresh]);

  const openAdjustBalance = useCallback((bookmakerId: string) => {
    setAdjustBookmakerId(bookmakerId);
    setAdjustType("deposit");
    setAdjustAmount("");
    setAdjustNote("");
    setAdjustError(null);
    setAdjustModalOpen(true);
  }, []);

  const closeAdjustBalance = useCallback(() => {
    setAdjustModalOpen(false);
    setAdjustBookmakerId(null);
    setAdjustAmount("");
    setAdjustNote("");
    setAdjustError(null);
  }, []);

  const onConfirmAdjustBalance = useCallback(() => {
    if (!adjustBookmakerId) return;
    const n = Number(adjustAmount);
    if (!Number.isFinite(n)) {
      setAdjustError("Enter a valid adjustment amount.");
      return;
    }
    const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
    if (rounded === 0) {
      setAdjustError("Amount must not be 0.");
      return;
    }
    const created = adjustBalance(adjustBookmakerId, {
      amount: n,
      type: adjustType,
      note: adjustNote.trim() || undefined,
    });
    if (!created) {
      setAdjustError("Adjustment could not be saved. Check the input and try again.");
      return;
    }
    closeAdjustBalance();
    refresh();
    setMessage(`Balance adjusted: ${fmtAdjustmentLine(created)}`);
  }, [adjustBookmakerId, adjustAmount, adjustType, adjustNote, closeAdjustBalance, refresh]);

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

  const resetQuickAdd = useCallback(() => {
    setQuickAddBookmakerId("");
    setQuickAddStake("");
    setQuickAddOddsTaken("");
    setQuickAddStatus("pending");
    setQuickAddNotes("");
    setQuickAddSelections([createSelectionDraft()]);
    setQuickAddErrors({});
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
    window.addEventListener("app:quick-add-bet", onQuickAdd as EventListener);
    window.addEventListener("app:scroll-insights", onInsights as EventListener);
    return () => {
      window.removeEventListener("app:quick-add-bet", onQuickAdd as EventListener);
      window.removeEventListener("app:scroll-insights", onInsights as EventListener);
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
    quickAddBookmakerRef.current?.focus();
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

  const onSaveQuickAdd = useCallback(async () => {
    const nextErrors: QuickAddErrors = {};
    if (!quickAddBookmakerId) nextErrors.bookmakerId = "Select a bookmaker.";
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

    const savePayload = {
      bookmakerId: quickAddBookmakerId,
      stake,
      oddsTaken,
      status: quickAddStatus,
      notes: quickAddNotes.trim() || undefined,
      selections: mappedSelections,
    };
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
        bookmakerId: expl.bookmakerId,
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
  }, [
    quickAddBookmakerId,
    quickAddStake,
    quickAddOddsTaken,
    quickAddSelections,
    quickAddStatus,
    quickAddNotes,
    refresh,
    resetQuickAdd,
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
            Bankroll View
            <select value={timelineBookmakerId} onChange={(e) => setTimelineBookmakerId(e.target.value)}>
              <option value="all">All bookmakers</option>
              {bookmakers.map((bk) => (
                <option key={bk.bookmakerId} value={bk.bookmakerId}>
                  {bk.bookmakerName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="bet-tracker-page__bankroll-card">
          <div className="bet-tracker-page__bankroll-card-head">
            <h3 className="bet-tracker-page__bankroll-title">Bankroll</h3>
            <p className="bet-tracker-page__bankroll-subtitle">Running balance after settled activity</p>
          </div>
          <div className="bet-tracker-page__bankroll-card-body">
            <BankrollChart points={timelinePoints} />
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
                  <th>Profit</th>
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
                      {fmtSignedMoney(row.profit)}
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
        <div className="bet-tracker-page__summary-card"><span>Total Profit</span><strong>{fmtMoney(global.totalProfit)}</strong></div>
        <div className="bet-tracker-page__summary-card"><span>ROI</span><strong>{(global.roi * 100).toFixed(1)}%</strong></div>
        <div className="bet-tracker-page__summary-card"><span>Total Staked</span><strong>£{fmtMoney(totals.totalStaked)}</strong></div>
        <div className="bet-tracker-page__summary-card"><span>Total Returned</span><strong>£{fmtMoney(totals.totalReturned)}</strong></div>
        <div className="bet-tracker-page__summary-card"><span>Real ROI</span><strong>{(totals.roi * 100).toFixed(1)}%</strong></div>
      </section>

      <section className="bet-tracker-page__section" id="bet-tracker-insights">
        <h2>Insights</h2>
        <div className="bet-tracker-page__insights-grid">
          <article className="bet-tracker-page__insight-card">
            <h3>Performance by Bookmaker</h3>
            <ul>
              {bookmakerPerformance.map((row) => (
                <li key={row.name}>
                  <span>{row.name} ({row.bets})</span>
                  <strong className={row.profit >= 0 ? "bet-tracker-page__pl is-profit" : "bet-tracker-page__pl is-loss"}>
                    {fmtSignedMoney(row.profit)} ({(row.roi * 100).toFixed(1)}%)
                  </strong>
                </li>
              ))}
            </ul>
          </article>
          <article className="bet-tracker-page__insight-card">
            <h3>Performance by Odds Range</h3>
            <ul>
              {oddsRangePerformance.map((row) => (
                <li key={row.label}>
                  <span>{row.label} ({row.bets})</span>
                  <strong className={row.profit >= 0 ? "bet-tracker-page__pl is-profit" : "bet-tracker-page__pl is-loss"}>
                    {fmtSignedMoney(row.profit)} • {(row.winRate * 100).toFixed(1)}%
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
              <li><span>Highest profit</span><strong>{bestWorst.best ? `${bestWorst.best.matchLabel} (${fmtSignedMoney(bestWorst.best.returnAmount - bestWorst.best.stake)})` : "—"}</strong></li>
              <li><span>Biggest loss</span><strong>{bestWorst.worst ? `${bestWorst.worst.matchLabel} (${fmtSignedMoney(-bestWorst.worst.stake)})` : "—"}</strong></li>
              <li><span>Highest odds win</span><strong>{bestWorst.highestOddsWin ? `${bestWorst.highestOddsWin.matchLabel} (${bestWorst.highestOddsWin.oddsTaken.toFixed(2)})` : "—"}</strong></li>
            </ul>
          </article>
          <article className="bet-tracker-page__insight-card">
            <h3>Recent Performance</h3>
            <ul>
              <li><span>Last 5</span><strong>{fmtSignedMoney(recentPerformance.last5.profit)} • {(recentPerformance.last5.winRate * 100).toFixed(1)}%</strong></li>
              <li><span>Last 10</span><strong>{fmtSignedMoney(recentPerformance.last10.profit)} • {(recentPerformance.last10.winRate * 100).toFixed(1)}%</strong></li>
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

      <section className="bet-tracker-page__section">
        <h2>Bookmakers</h2>
        <div className="bet-tracker-page__bookmaker-form">
          <input
            type="text"
            placeholder="Bookmaker name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            type="number"
            min={0}
            step={0.01}
            placeholder="Starting balance"
            value={startingBalance}
            onChange={(e) => setStartingBalance(e.target.value)}
          />
          <button type="button" onClick={onAddBookmaker}>Add bookmaker</button>
        </div>
        {error && <p className="bet-tracker-page__error">{error}</p>}

        {bookmakers.length === 0 ? (
          <p className="bet-tracker-page__empty">No bookmakers yet. Add one to start tracking placed bets.</p>
        ) : (
          <div className="bet-tracker-page__bookmaker-cards">
            {bookmakers.map((b) => (
              <article key={b.bookmakerId} className="bet-tracker-page__bookmaker-card">
                <h3>{b.bookmakerName}</h3>
                <p className="bet-tracker-page__bookmaker-balance-flow">
                  Available: <strong className="bet-tracker-page__bookmaker-current-balance">£{fmtMoney(b.availableBalance)}</strong>
                </p>
                <p className="bet-tracker-page__bookmaker-current">Current Balance: £{fmtMoney(b.currentBalance)}</p>
                <p className="bet-tracker-page__bookmaker-pending">Pending: -£{fmtMoney(b.pendingStake)}</p>
                <p className={`bet-tracker-page__bookmaker-pl ${b.realizedProfit > 0 ? "is-profit" : b.realizedProfit < 0 ? "is-loss" : "is-neutral"}`}>
                  {fmtSignedMoney(b.realizedProfit)}
                </p>
                <p className="bet-tracker-page__bookmaker-roi">Units: {b.totalUnitsProfit > 0 ? "+" : ""}{b.totalUnitsProfit.toFixed(2)}u</p>
                <p className="bet-tracker-page__bookmaker-roi">ROI: {(b.roi * 100).toFixed(1)}%</p>
                <p className="bet-tracker-page__bookmaker-potential">
                  Potential Profit:{" "}
                  <span className={b.potentialProfit > 0 ? "profit-positive" : b.potentialProfit < 0 ? "profit-negative" : "profit-neutral"}>
                    {fmtSignedMoney(b.potentialProfit)}
                  </span>
                </p>
                <p className="bet-tracker-page__bookmaker-potential-balance">
                  Potential Balance: £{fmtMoney(b.potentialBalance)}
                </p>
                <p>Bets: {b.betCount} (settled {b.settledCount}, pending {b.pendingCount})</p>
                <button
                  type="button"
                  className="bet-tracker-page__adjust-balance-btn"
                  onClick={() => openAdjustBalance(b.bookmakerId)}
                >
                  Adjust Balance
                </button>
                <details className="bet-tracker-page__adjustments-details">
                  <summary>Balance adjustments ({getAdjustmentsForBookmaker(b.bookmakerId).length})</summary>
                  {getAdjustmentsForBookmaker(b.bookmakerId).length === 0 ? (
                    <p className="bet-tracker-page__adjustments-empty">No adjustments yet.</p>
                  ) : (
                    <div className="bet-tracker-page__adjustments-list">
                      {getAdjustmentsForBookmaker(b.bookmakerId).map((a) => (
                        <div key={a.id} className="bet-tracker-page__adjustment-row">
                          <span className="bet-tracker-page__adjustment-line">{fmtAdjustmentLine(a)}</span>
                          {a.note ? <span className="bet-tracker-page__adjustment-note"> — {a.note}</span> : null}
                        </div>
                      ))}
                    </div>
                  )}
                </details>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="bet-tracker-page__section">
        <h2>All Bets</h2>
        <div className="bet-tracker-page__filters">
          <label>
            Status
            <select value={selectedStatus} onChange={(e) => setSelectedStatus(e.target.value as "all" | TrackedBetStatus)}>
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="win">Win</option>
              <option value="loss">Loss</option>
            </select>
          </label>
          <label>
            Bookmaker
            <select value={selectedBookmakerId} onChange={(e) => setSelectedBookmakerId(e.target.value)}>
              <option value="all">All</option>
              {bookmakers.map((bk) => (
                <option key={bk.bookmakerId} value={bk.bookmakerId}>
                  {bk.bookmakerName}
                </option>
              ))}
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
          <label>
            Unit Size (£)
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={unitSizeInput}
              onChange={(e) => {
                setUnitSizeInput(e.target.value);
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) setUnitSize(v);
              }}
            />
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
                    : "bet-tracker-page__bet-card";
              const deleting = deletingBetIds.has(b.id);

                  const canonicalUnitSize =
                    Number.isFinite(b.unitSizeAtBet as number) && (b.unitSizeAtBet as number) > 0
                      ? (b.unitSizeAtBet as number)
                      : (b.stake > 0 && Number.isFinite(b.stakeUnits as number) && (b.stakeUnits as number) > 0)
                        ? b.stake / (b.stakeUnits as number)
                        : null;
                  const displayReturnUnits =
                    Number.isFinite(b.returnUnits as number)
                      ? (b.returnUnits as number)
                      : canonicalUnitSize && canonicalUnitSize > 0
                        ? b.returnAmount / canonicalUnitSize
                        : null;
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
                              {b.bookmakerName} · {fmtRelativeDate(b.createdAt)}
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
                            <span className="bet-tracker-page__inline-value">£{fmtMoney(b.stake)}</span>
                          </span>
                          <span className="bet-tracker-page__metric-stack" title="Profit / Loss">
                            <span className="bet-tracker-page__metric-label">P/L</span>
                            <span className={`bet-tracker-page__inline-value bet-tracker-page__inline-value--pl ${pl > 0 ? "bet-tracker-page__pl is-profit" : pl < 0 ? "bet-tracker-page__pl is-loss" : "bet-tracker-page__pl is-pending"}`}>
                              {fmtSignedMoney(pl)}
                            </span>
                          </span>
                          <button
                            type="button"
                            className={`bet-tracker-page__status-chip status-${b.status}${statusPulseBetIds.has(b.id) ? " is-pulse" : ""}`}
                            onClick={async (e) => {
                              e.stopPropagation();
                              const next = getNextStatus(b.status);
                              await onStatusChange(b.id, next);
                            }}
                            title="Cycle status: pending → win → loss"
                          >
                            {b.status}
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
                            Return £{fmtMoney(b.returnAmount)}{displayReturnUnits != null ? ` (${displayReturnUnits.toFixed(2)}u)` : ""}
                          </span>
                        )}</div>
                        <div className="bet-tracker-page__bet-controls">
                          <select
                            className={`bet-tracker-page__status-select status-${b.status}`}
                            value={b.status}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => onStatusChange(b.id, e.target.value as TrackedBetStatus)}
                          >
                            <option value="pending">pending</option>
                            <option value="win">win</option>
                            <option value="loss">loss</option>
                          </select>
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
                Bookmaker
                <select ref={quickAddBookmakerRef} value={quickAddBookmakerId} onChange={(e) => setQuickAddBookmakerId(e.target.value)}>
                  <option value="">Select bookmaker</option>
                  {availableBookmakers.map((bk) => (
                    <option key={bk.id} value={bk.id}>
                      {bk.name}
                    </option>
                  ))}
                </select>
                {quickAddErrors.bookmakerId && <span className="bet-tracker-page__error-inline">{quickAddErrors.bookmakerId}</span>}
              </label>
              <label>
                Stake (GBP)
                <input type="number" min={0.01} step={0.01} value={quickAddStake} onChange={(e) => setQuickAddStake(e.target.value)} />
                {quickAddErrors.stake && <span className="bet-tracker-page__error-inline">{quickAddErrors.stake}</span>}
              </label>
              <label>
                Odds Taken
                <input type="number" min={1.01} step={0.01} value={quickAddOddsTaken} onChange={(e) => setQuickAddOddsTaken(e.target.value)} />
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
              <span>Return: <strong>£{fmtMoney(quickAddReturnValue)}</strong></span>
              <span>Stake Units: <strong>{quickAddStakeUnits.toFixed(2)}u</strong></span>
              <span>Return Units: <strong>{quickAddReturnUnits.toFixed(2)}u</strong></span>
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
                        row.preset === "playerFoulsWonOver") && (
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
                        <label>
                          Line
                          <input type="number" step={0.01} value={row.line} onChange={(e) => onChangeSelectionRow(row.id, "line", e.target.value)} placeholder="2.5" />
                          {rowErr?.line && <span className="bet-tracker-page__error-inline">{rowErr.line}</span>}
                        </label>
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

      {adjustModalOpen && (
        <div className="bet-tracker-page__adjust-balance-overlay" role="dialog" aria-modal="true" aria-label="Adjust Balance">
          <div className="bet-tracker-page__adjust-balance-modal">
            <div className="bet-tracker-page__quick-add-head">
              <h2>Adjust Balance</h2>
              <button type="button" onClick={closeAdjustBalance}>Close</button>
            </div>

            <div className="bet-tracker-page__quick-add-grid">
              <label>
                Amount (GBP)
                <input
                  ref={adjustAmountRef}
                  type="number"
                  step={0.01}
                  value={adjustAmount}
                  onChange={(e) => setAdjustAmount(e.target.value)}
                />
              </label>
              <label>
                Adjustment Type
                <select value={adjustType} onChange={(e) => setAdjustType(e.target.value as BalanceAdjustmentType)}>
                  <option value="deposit">Deposit</option>
                  <option value="withdrawal">Withdrawal</option>
                  <option value="correction">Correction</option>
                </select>
              </label>
              <label className="bet-tracker-page__quick-add-notes">
                Note (optional)
                <textarea rows={2} value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} placeholder="Optional note" />
              </label>
            </div>

            {adjustError && <p className="bet-tracker-page__error-inline">{adjustError}</p>}

            <div className="bet-tracker-page__quick-add-actions">
              <button type="button" className="secondary" onClick={closeAdjustBalance}>Cancel</button>
              <button type="button" onClick={onConfirmAdjustBalance}>Confirm Adjustment</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Whether the bet tracker has at least one saved bookmaker.
 * Data source: `getBookmakers()` from `../services/betTrackerService.js` (same named export used above in this file).
 */
export function hasAnyBookmakers(): boolean {
  try {
    const bookmakers = getBookmakers();
    if (!Array.isArray(bookmakers)) return false;
    return bookmakers.some((b) => b != null && typeof b === "object" && typeof b.id === "string" && b.id.trim() !== "");
  } catch {
    return false;
  }
}
