import type { AreaId } from "@terros-inc/sdk";
import type { SkippedOverlap } from "./types";

// Logs a one-line totals summary plus a warning for each area skipped due to overlap.
export function printSummary(
  submitted: AreaId[],
  skippedOverlaps: SkippedOverlap[],
  failures: { areaId: AreaId; message: string }[],
  dryRun: boolean,
): void {
  console.log(
    `\nSummary${dryRun ? " (dry run)" : ""}: ${submitted.length} submitted, ${skippedOverlaps.length} overlap skips, ${failures.length} API failures.`,
  );
  skippedOverlaps.forEach((skipped) =>
    console.warn(
      `Skipped ${skipped.areaId}: overlaps ${skipped.overlappingAreaId} for ${skipped.fieldId}.`,
    ),
  );
}
