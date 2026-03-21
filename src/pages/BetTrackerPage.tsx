import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addBookmaker,
  addManualMultiBet,
  explainManualMultiBetFailure,
  getAllBookmakerStats,
  getBankrollTimeline,
  getBookmakers,
  getBalanceAdjustments,
  getUnitSize,
  refreshTrackedBetsFromServer,
  settlePendingTrackedBets,
  getScoreBandAnalysis,
  setUnitSize,
  getTrackedBetStats,
  getTrackedBets,
  adjustBalance,
  deleteTrackedBet,
  updateTrackedBetStatus,
  type BookmakerStats,
  type ManualTrackedSelectionInput,
  type ScoreBandAnalysisRow,
  type BalanceAdjustment,
  type BalanceAdjustmentType,
  type TrackedBetRecord,
  type TrackedBetStatus,
} from "../services/betTrackerService.js";
import { BankrollChart } from "../components/BankrollChart.js";
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
      if (!cancelled) refresh();
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

  const onStatusChange = useCallback((id: string, status: TrackedBetStatus) => {
    updateTrackedBetStatus(id, status);
    refresh();
  }, [refresh]);

  const onDeleteBet = useCallback((id: string) => {
    const ok = window.confirm("Delete this bet? This cannot be undone.");
    if (!ok) return;
    const deleted = deleteTrackedBet(id);
    if (deleted) {
      setMessage("Bet deleted.");
      refresh();
      return;
    }
    setMessage("Bet could not be deleted.");
  }, [refresh]);

  const toggleBetExpanded = useCallback((id: string) => {
    setExpandedBetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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

  const onSaveQuickAdd = useCallback(() => {
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
    let created: ReturnType<typeof addManualMultiBet>;
    try {
      created = addManualMultiBet(savePayload);
    } catch (err) {
      setQuickAddErrors({
        selections: err instanceof Error ? err.message : "Save failed unexpectedly. Try again.",
      });
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
      return;
    }
    refresh();
    setMessage(`Quick add saved: ${created.legs.length} selections.`);
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
        <BankrollChart points={timelinePoints} />

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
                  <tr key={row.label}>
                    <td>{row.label}</td>
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
        {bets.length === 0 ? (
          <p className="bet-tracker-page__empty">No tracked bets yet. Add a bet from Build Value Bets using the + button, or use Quick Add to start tracking.</p>
        ) : filteredAndSortedBets.length === 0 ? (
          <p className="bet-tracker-page__empty">No bets match current filters.</p>
        ) : (
          <div className="bet-tracker-page__bet-cards">
            {filteredAndSortedBets.map(({ b, modelScore, normalizedScore, pl }) => {
              const isExpanded = expandedBetIds.has(b.id);
              const previewLeg = b.legs[0];
              const previewLabel = previewLeg
                ? `${previewLeg.marketName}: ${previewLeg.label}`
                : "No selection details";
              const remainingLegCount = Math.max(0, b.legs.length - 1);
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

                  const canonicalUnitSize =
                    Number.isFinite(b.unitSizeAtBet as number) && (b.unitSizeAtBet as number) > 0
                      ? (b.unitSizeAtBet as number)
                      : (b.stake > 0 && Number.isFinite(b.stakeUnits as number) && (b.stakeUnits as number) > 0)
                        ? b.stake / (b.stakeUnits as number)
                        : null;
                  const displayStakeUnits =
                    Number.isFinite(b.stakeUnits as number)
                      ? (b.stakeUnits as number)
                      : canonicalUnitSize && canonicalUnitSize > 0
                        ? b.stake / canonicalUnitSize
                        : null;
                  const displayReturnUnits =
                    Number.isFinite(b.returnUnits as number)
                      ? (b.returnUnits as number)
                      : canonicalUnitSize && canonicalUnitSize > 0
                        ? b.returnAmount / canonicalUnitSize
                        : null;
                  const displayProfitUnits =
                    Number.isFinite(b.profitUnits as number)
                      ? (b.profitUnits as number)
                      : b.status === "pending"
                        ? 0
                        : b.status === "loss"
                          ? displayStakeUnits != null
                            ? -displayStakeUnits
                            : null
                          : displayStakeUnits != null && displayReturnUnits != null
                            ? displayReturnUnits - displayStakeUnits
                            : null;
                  return (
                    <article key={b.id} className={cardStatusClass}>
                      <header className="bet-tracker-page__bet-card-top">
                        <div>
                          <h3 className="bet-tracker-page__bet-match">{b.matchLabel}</h3>
                          <p className="bet-tracker-page__bet-meta">
                            {b.bookmakerName} • {fmtDate(b.createdAt)}
                          </p>
                          {b.sourceType === "manualMulti" && <span className="bet-tracker-page__source-tag">Custom Multi</span>}
                        </div>
                        <div className="bet-tracker-page__bet-kickoff">
                          <div>{b.leagueName || "—"}</div>
                          <strong>{b.kickoffTime || "—"}</strong>
                        </div>
                      </header>

                      <section className="bet-tracker-page__bet-selections">
                        <p className="bet-tracker-page__bet-selection-preview">{previewLabel}</p>
                        {remainingLegCount > 0 && (
                          <button type="button" className="bet-tracker-page__expand-btn" onClick={() => toggleBetExpanded(b.id)}>
                            {isExpanded ? "Show less" : `+${remainingLegCount} more`}
                          </button>
                        )}
                        {isExpanded && (
                          <ul className="bet-tracker-page__bet-selection-list">
                            {b.legs.map((l, i) => (
                              <li key={`${b.id}-leg-${i}`}>
                                <span className="bet-tracker-page__leg-main">{l.matchLabel ?? b.matchLabel} - {l.marketName}: {l.label}</span>
                                <span className="bet-tracker-page__leg-sub">
                                  {[l.leagueName, l.kickoffTime, l.playerName, l.outcome, Number.isFinite(l.line) && l.line !== 0 ? `Line ${l.line}` : null, l.odds != null ? `Odds ${l.odds.toFixed(2)}` : null, l.legNotes ? `Note: ${l.legNotes}` : null]
                                    .filter(Boolean)
                                    .join(" | ") || "No extra details"}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>

                      <section className="bet-tracker-page__bet-metrics">
                        <div><span>Odds</span><strong>{b.oddsTaken.toFixed(2)}</strong></div>
                        <div><span>Stake</span><strong>£{fmtMoney(b.stake)}</strong><small>{displayStakeUnits != null ? `${displayStakeUnits.toFixed(2)}u` : "—"}</small></div>
                        <div><span>Return</span><strong>£{fmtMoney(b.returnAmount)}</strong><small>{displayReturnUnits != null ? `${displayReturnUnits.toFixed(2)}u` : "—"}</small></div>
                        <div>
                          <span>P/L</span>
                          <strong className={pl > 0 ? "bet-tracker-page__pl is-profit" : pl < 0 ? "bet-tracker-page__pl is-loss" : "bet-tracker-page__pl is-pending"}>
                            {fmtSignedMoney(pl)}
                          </strong>
                          <small className={(displayProfitUnits ?? 0) > 0 ? "bet-tracker-page__pl is-profit" : (displayProfitUnits ?? 0) < 0 ? "bet-tracker-page__pl is-loss" : "bet-tracker-page__pl is-pending"}>
                            {displayProfitUnits != null ? `${displayProfitUnits > 0 ? "+" : ""}${displayProfitUnits.toFixed(2)}u` : "—"}
                          </small>
                        </div>
                      </section>

                      <footer className="bet-tracker-page__bet-card-bottom">
                        <div className="bet-tracker-page__bet-badges">
                          {modelBadge && (
                            <span className="bet-tracker-page__bet-badge">
                              Model {typeof modelScore === "number" ? Math.round(modelScore) : "—"} | Score{" "}
                              <span className={scoreClass}>{typeof normalizedScore === "number" ? Math.round(normalizedScore) : "—"}</span>
                            </span>
                          )}
                        </div>
                        <div className="bet-tracker-page__bet-controls">
                          <select
                            className={`bet-tracker-page__status-select status-${b.status}`}
                            value={b.status}
                            onChange={(e) => onStatusChange(b.id, e.target.value as TrackedBetStatus)}
                          >
                            <option value="pending">pending</option>
                            <option value="win">win</option>
                            <option value="loss">loss</option>
                          </select>
                          <button
                            type="button"
                            className="bet-tracker-page__delete-btn"
                            onClick={() => onDeleteBet(b.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </footer>
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
