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

export type CliOptions = {
  subzoneFieldId: `CF.${string}` | undefined;
  marketFieldId: `CF.${string}` | undefined;
  dryRun: boolean;
  maxUpdatesPerPass: number | undefined;
  onlyAreaIds: AreaId[] | undefined;
  verbose: boolean;
};

// The ID of the subzone custom field (areas within another area) and the market custom
// field (areas that contain another area). Set marketFieldId to undefined to skip that
// pass entirely. See below for the corresponding --flags and their defaults.
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
