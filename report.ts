import type { AreaId } from "@terros-inc/sdk";
import type { SkippedOverlap, SubmitResult } from "./types";

// Logs a one-line totals summary plus a warning for each area skipped due to overlap.
export function printSummary(
  subzoneResult: SubmitResult & { skippedOverlaps: SkippedOverlap[] },
  marketResult: SubmitResult & { skippedOverlaps: SkippedOverlap[] },
  dryRun: boolean,
): void {
  const submitted = [...subzoneResult.submitted, ...marketResult.submitted];
  const failures = [...subzoneResult.failures, ...marketResult.failures];
  const skippedOverlaps = [...subzoneResult.skippedOverlaps, ...marketResult.skippedOverlaps];
  console.log(
    `\nSummary${dryRun ? " (dry run)" : ""}: ${submitted.length} submitted, ${skippedOverlaps.length} overlap skips, ${failures.length} API failures.`,
  );
  skippedOverlaps.forEach((skipped) =>
    console.warn(
      `Skipped ${skipped.areaId}: overlaps ${skipped.overlappingAreaId} for ${skipped.fieldId}.`,
    ),
  );
  if (failures.length > 0) throw new Error(`${failures.length} Area update(s) failed.`);
}
