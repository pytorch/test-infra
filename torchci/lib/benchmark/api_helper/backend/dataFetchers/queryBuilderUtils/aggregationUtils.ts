/**
 * Utility functions for benchmark data aggregation.
 * Provides reusable methods for computing geometric means,
 * speedup calculations, and grouping.
 */

/**
 * Compute the geometric mean of an array of positive numbers.
 * Uses log transformation to avoid overflow.
 */
export function geometricMean(values: number[]): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];

  // Filter out non-positive values
  const positiveValues = values.filter((v) => v > 0);
  if (positiveValues.length === 0) return 0;

  // Use log transformation to avoid overflow
  const logSum = positiveValues.reduce((sum, v) => sum + Math.log(v), 0);
  return Math.round(Math.exp(logSum / positiveValues.length) * 100) / 100;
}

/**
 * Compute speedup ratio between two values.
 * @param compiled - Value with compile enabled
 * @param nonCompiled - Value without compile
 * @param higherIsBetter - If true, speedup = compiled/nonCompiled, else nonCompiled/compiled
 */
export function computeSpeedup(
  compiled: number,
  nonCompiled: number,
  higherIsBetter: boolean
): number {
  if (compiled <= 0 || nonCompiled <= 0) return 0;

  const speedup = higherIsBetter
    ? compiled / nonCompiled
    : nonCompiled / compiled;

  return Math.round(speedup * 100) / 100;
}

/**
 * Create a group key from data record based on specified fields.
 * Supports nested fields like "extra_key.use_compile".
 */
export function createGroupKey(data: any, fields: string[]): string {
  return fields
    .map((field) => {
      if (field.includes(".")) {
        const parts = field.split(".");
        let value = data;
        for (const part of parts) {
          value = value?.[part];
        }
        return String(value ?? "");
      }
      return String(data[field] ?? "");
    })
    .join("|");
}

/**
 * Build a base record from template based on groupByFields.
 * This extracts all fields specified in groupByFields from the template,
 * plus 'commit' if available.
 */
export function buildBaseRecordFromTemplate(
  template: any,
  groupByFields: string[]
): Record<string, any> {
  const baseRecord: Record<string, any> = {};

  // Always include commit if available
  if (template.commit !== undefined) {
    baseRecord.commit = template.commit;
  }

  // Extract fields from groupByFields
  for (const field of groupByFields) {
    if (field.includes(".")) {
      // Handle nested fields like "extra_key.use_compile"
      const parts = field.split(".");
      let value = template;
      for (const part of parts) {
        value = value?.[part];
      }
      // Use the last part as the key
      baseRecord[parts[parts.length - 1]] = value;
    } else {
      // Direct field
      if (template[field] !== undefined) {
        baseRecord[field] = template[field];
      }
    }
  }

  return baseRecord;
}
