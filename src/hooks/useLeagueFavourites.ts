import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "favouriteLeagueIds";

function loadFavouriteIds(): Set<number> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is number => typeof x === "number"));
  } catch {
    return new Set();
  }
}

function saveFavouriteIds(ids: Set<number>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore
  }
}

export function useLeagueFavourites(): {
  favouriteIds: Set<number>;
  toggleFavourite: (leagueId: number) => void;
  isFavourite: (leagueId: number) => boolean;
} {
  const [favouriteIds, setFavouriteIds] = useState<Set<number>>(loadFavouriteIds);

  useEffect(() => {
    setFavouriteIds(loadFavouriteIds());
  }, []);

  const toggleFavourite = useCallback((leagueId: number) => {
    setFavouriteIds((prev) => {
      const next = new Set(prev);
      if (next.has(leagueId)) next.delete(leagueId);
      else next.add(leagueId);
      saveFavouriteIds(next);
      return next;
    });
  }, []);

  const isFavourite = useCallback(
    (leagueId: number) => favouriteIds.has(leagueId),
    [favouriteIds]
  );

  return { favouriteIds, toggleFavourite, isFavourite };
}
