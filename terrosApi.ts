import type { AreaData, AreaId, AreaSortCursor, TerrosClient } from "@terros-inc/sdk";
import type { AreaUpdate, SubmitResult } from "./types";

// Recursively pages through every area on the account (1,000 per page) via the cursor.
export async function listAreas(
  client: TerrosClient,
  cursor?: AreaSortCursor,
): Promise<AreaData[]> {
  const response = await client.area.list({ cursor, size: 1_000 });
  if (response.cursor === undefined) return response.areas;
  return [...response.areas, ...(await listAreas(client, response.cursor))];
}

export type SubmitAreaUpdatesOptions = {
  dryRun: boolean;
  verbose: boolean;
  maxUpdatesPerPass: number | undefined;
};

// Submits one client.account.bulk call per area/field update: the SDK's bulk filter only
// accepts a single polygon and a single action per call, so updates can't be batched further.
// The filter also excludes accounts where the field is already set, making each call idempotent.
export async function submitAreaUpdates(
  client: TerrosClient,
  areaUpdates: AreaUpdate[],
  { dryRun, verbose, maxUpdatesPerPass }: SubmitAreaUpdatesOptions,
): Promise<SubmitResult> {
  type SubmitOutcome =
    | { areaId: AreaId; ok: true }
    | { areaId: AreaId; ok: false; message: string };

  // Apply the testing cap, if configured, before submitting anything.
  const limitedAreaUpdates =
    maxUpdatesPerPass !== undefined ? areaUpdates.slice(0, maxUpdatesPerPass) : areaUpdates;
  if (limitedAreaUpdates.length < areaUpdates.length) {
    console.log(
      `Limiting to ${limitedAreaUpdates.length} of ${areaUpdates.length} updates (maxUpdatesPerPass).`,
    );
  }

  const results = await limitedAreaUpdates.reduce<Promise<SubmitOutcome[]>>(
    async (accPromise, { area, fieldId, value }) => {
      const acc = await accPromise;
      const bulkInput = {
        filter: {
          ...area.filters,
          coordinates: area.coordinates,
          advancedCustomFields: {
            ...area.filters?.advancedCustomFields,
            [fieldId]: { type: "exists" as const, exists: false },
          },
        },
        actions: [{ actionType: "updateCustomField" as const, fieldId, value }],
      };

      if (verbose) console.log(JSON.stringify(bulkInput, null, 2));

      if (dryRun) {
        console.log(`[dry run] Would submit ${area.areaId}: ${fieldId} = ${String(value)}`);
        return [...acc, { areaId: area.areaId, ok: true }];
      }

      try {
        await client.account.bulk(bulkInput);
        console.log(`Submitted ${area.areaId}: ${fieldId} = ${String(value)}`);
        return [...acc, { areaId: area.areaId, ok: true }];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed ${area.areaId}: ${message}`);
        return [...acc, { areaId: area.areaId, ok: false, message }];
      }
    },
    Promise.resolve([]),
  );

  const submitted = results.filter((result) => result.ok).map((result) => result.areaId);
  const failures = results
    .filter((result): result is { areaId: AreaId; ok: false; message: string } => !result.ok)
    .map(({ areaId, message }) => ({ areaId, message }));

  return { submitted, failures, skippedOverlaps: [] };
}
