/**
 * Calibration layer for value-bet model.
 * Uses historically observed hit rates per probability bucket to adjust raw model output.
 */

export interface CalibrationBucket {
  bucketKey: string;
  minProb: number;
  maxProb: number;
  count: number;
  hitRate: number;
  avgRawModelProbability?: number;
}

let calibrationTable: CalibrationBucket[] | null = null;

/** Minimum sample size in a bucket to use its hit rate as calibrated probability. */
export const CALIBRATION_MIN_BUCKET_SAMPLE = 30;

/**
 * Set the calibration table (e.g. from backtest output or loaded JSON).
 */
export function setCalibrationTable(table: CalibrationBucket[] | null): void {
  calibrationTable = table;
}

/**
 * Get the current calibration table, if any.
 */
export function getCalibrationTable(): CalibrationBucket[] | null {
  return calibrationTable;
}

/**
 * Find which bucket a raw probability falls into.
 */
function getBucketKey(raw: number): string {
  const buckets: Array<{ key: string; min: number; max: number }> = [
    { key: "0-5", min: 0, max: 0.05 },
    { key: "5-10", min: 0.05, max: 0.1 },
    { key: "10-15", min: 0.1, max: 0.15 },
    { key: "15-20", min: 0.15, max: 0.2 },
    { key: "20-30", min: 0.2, max: 0.3 },
    { key: "30-40", min: 0.3, max: 0.4 },
    { key: "40-50", min: 0.4, max: 0.5 },
    { key: "50-60", min: 0.5, max: 0.6 },
    { key: "60-70", min: 0.6, max: 0.7 },
    { key: "70+", min: 0.7, max: 1.01 },
  ];
  for (const b of buckets) {
    if (raw >= b.min && raw < b.max) return b.key;
  }
  return "70+";
}

/**
 * Returns calibrated probability from the calibration table when available and bucket has enough sample.
 * Otherwise returns raw (no adjustment).
 */
export function calibrateProbability(
  rawModelProbability: number,
  _context?: { marketId?: number; positionId?: number; dataConfidence?: string }
): number {
  const table = calibrationTable;
  if (!table || table.length === 0) return rawModelProbability;

  const bucketKey = getBucketKey(rawModelProbability);
  const bucket = table.find((b) => b.bucketKey === bucketKey);
  if (!bucket || bucket.count < CALIBRATION_MIN_BUCKET_SAMPLE) return rawModelProbability;

  return bucket.hitRate;
}

/**
 * Whether the current calibration table has enough data for the given raw probability bucket.
 */
export function isBucketCalibrated(rawModelProbability: number): boolean {
  const table = calibrationTable;
  if (!table || table.length === 0) return false;
  const bucketKey = getBucketKey(rawModelProbability);
  const bucket = table.find((b) => b.bucketKey === bucketKey);
  return !!(bucket && bucket.count >= CALIBRATION_MIN_BUCKET_SAMPLE);
}
