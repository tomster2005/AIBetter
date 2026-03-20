const SCORE_NORMALIZATION_FLAT_EPSILON = 1e-9;
const SCORE_NORMALIZATION_FULL_RANGE_AT = 20;
const SCORE_NORMALIZATION_MIN_SPREAD_FACTOR = 0.2;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export function getCompressedNormalizedScore(score: number, scoreMin: number, scoreMax: number): number {
  if (!Number.isFinite(score)) return 0;
  const range = scoreMax - scoreMin;
  if (!Number.isFinite(range) || range <= SCORE_NORMALIZATION_FLAT_EPSILON) return 50;
  const base = clamp01((score - scoreMin) / range);
  const spreadFactor = Math.max(
    SCORE_NORMALIZATION_MIN_SPREAD_FACTOR,
    Math.min(1, range / SCORE_NORMALIZATION_FULL_RANGE_AT)
  );
  const compressed = 50 + (base - 0.5) * 100 * spreadFactor;
  return Math.round(Math.max(0, Math.min(100, compressed)));
}
