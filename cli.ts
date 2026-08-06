import { parseArgs } from "node:util";
import type { AreaId } from "@terros-inc/sdk";

// Pass "" for a field id flag to disable that pass entirely.
function parseCustomFieldId(
  value: string | undefined,
  flagName: string,
): `CF.${string}` | undefined {
  if (value === undefined || value === "") return undefined;
  if (!value.startsWith("CF."))
    throw new Error(`--${flagName} must look like "CF.xxxx", got "${value}"`);
  return value as `CF.${string}`;
}

// subzoneFieldId/marketFieldId are the custom fields to write for areas within another
// area vs. areas that contain another area, respectively; either can be undefined to skip
// that pass. The rest control testing/output behavior (see parseCliOptions below).
export type CliOptions = {
  subzoneFieldId: `CF.${string}` | undefined;
  marketFieldId: `CF.${string}` | undefined;
  dryRun: boolean;
  maxUpdatesPerPass: number | undefined;
  onlyAreaIds: AreaId[] | undefined;
  verbose: boolean;
};

// Parses and validates the script's --flags (see the `options` below for the full list
// and their defaults) into a CliOptions object.
export function parseCliOptions(): CliOptions {
  const { values } = parseArgs({
    options: {
      "subzone-field-id": { type: "string", default: "CF.kveysCFY" },
      "market-field-id": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "max-updates-per-pass": { type: "string" },
      "only-area-ids": { type: "string" },
      verbose: { type: "boolean", default: false },
    },
  });

  const maxUpdatesPerPass =
    values["max-updates-per-pass"] !== undefined
      ? Number(values["max-updates-per-pass"])
      : undefined;
  if (
    maxUpdatesPerPass !== undefined &&
    (!Number.isInteger(maxUpdatesPerPass) || maxUpdatesPerPass < 0)
  ) {
    throw new Error(
      `--max-updates-per-pass must be a non-negative integer, got "${values["max-updates-per-pass"]}"`,
    );
  }

  return {
    subzoneFieldId: parseCustomFieldId(values["subzone-field-id"], "subzone-field-id"),
    marketFieldId: parseCustomFieldId(values["market-field-id"], "market-field-id"),
    dryRun: values["dry-run"] ?? false,
    maxUpdatesPerPass,
    onlyAreaIds: values["only-area-ids"]?.split(",").map((id) => id.trim() as AreaId),
    verbose: values.verbose ?? false,
  };
}
