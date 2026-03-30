/**
 * Sportmonks often nests included relations as `{ data: { id, name, ... } }`.
 * Lineup rows may omit flat `player_id` / `type_id` when `lineups.player` / `lineups.type` are included.
 */

import type { RawLineupEntry } from "../api/fixture-details-types.js";

function unwrapIncludedRecord(obj: unknown): Record<string, unknown> | null {
  if (obj == null || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const inner = o.data;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner as Record<string, unknown>;
  return o;
}

/** Player id and display name for a lineup row (top-level fields win when set). */
export function unwrapLineupPlayer(entry: RawLineupEntry): { id?: number; name?: string } {
  const nested = unwrapIncludedRecord(entry.player);
  const nid = nested && typeof nested.id === "number" && nested.id > 0 ? nested.id : undefined;
  const nname =
    nested && typeof nested.name === "string" && nested.name.trim()
      ? nested.name.trim()
      : nested && typeof nested.display_name === "string" && nested.display_name.trim()
        ? nested.display_name.trim()
        : nested && typeof nested.common_name === "string" && nested.common_name.trim()
          ? nested.common_name.trim()
          : undefined;

  const topId = entry.player_id;
  const id = typeof topId === "number" && topId > 0 ? topId : nid;

  const topName = entry.player_name;
  const name =
    typeof topName === "string" && topName.trim() ? topName.trim() : nname;

  return { id, name };
}

/** Resolve lineup row type id (starter / bench / predicted) from flat or nested `type`. */
export function getLineupEntryTypeId(e: RawLineupEntry): number | undefined {
  if (typeof e.type_id === "number" && Number.isFinite(e.type_id)) return e.type_id;
  const nested = unwrapIncludedRecord(e.type);
  if (nested && typeof nested.id === "number" && Number.isFinite(nested.id)) return nested.id;
  return undefined;
}
