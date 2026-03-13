import { useCallback, useState } from "react";

function key(date: string, leagueId: number): string {
  return `${date}-${leagueId}`;
}

export function useExpandedLeagueState(): {
  isExpanded: (date: string, leagueId: number) => boolean;
  toggleExpanded: (date: string, leagueId: number) => void;
} {
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});

  const isExpanded = useCallback(
    (date: string, leagueId: number) => Boolean(expandedKeys[key(date, leagueId)]),
    [expandedKeys]
  );

  const toggleExpanded = useCallback((date: string, leagueId: number) => {
    const k = key(date, leagueId);
    setExpandedKeys((prev) => ({ ...prev, [k]: !prev[k] }));
  }, []);

  return { isExpanded, toggleExpanded };
}
