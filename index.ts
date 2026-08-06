import { parseArgs } from "node:util";
import { TerrosClient, type AreaData, type AreaId, type AreaSortCursor } from "@terros-inc/sdk";
import * as turf from "@turf/turf";

type FieldValue = string | number | boolean;

type AreaUpdate = {
  area: AreaData;
  fieldId: `CF.${string}`;
  value: FieldValue;
  depth: number;
};

type SkippedOverlap = { areaId: AreaId; overlappingAreaId: AreaId; fieldId: `CF.${string}` };

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

function parseCliOptions() {
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

// The ID of the subzone custom field (areas within another area) and the market custom
// field (areas that contain another area). Set marketFieldId to undefined to skip that
// pass entirely. See parseCliOptions for the corresponding --flags and their defaults.
const { subzoneFieldId, marketFieldId, dryRun, maxUpdatesPerPass, onlyAreaIds, verbose } =
  parseCliOptions();

async function main(): Promise<void> {
  if (dryRun) console.log("DRY RUN: no accounts will be updated.\n");

  const client = new TerrosClient(); // add ApiKey or use terros auth login from the CL
  const allAreas = await listAreas(client);
  // Containment is computed over every area so that a targeted area's containers/containees
  // are correctly identified even if they're not in onlyAreaIds themselves; only the final
  // update lists are filtered down to onlyAreaIds.
  const polygons = buildPolygons(allAreas);
  // containers: areaId -> ids of areas it geographically contains
  // containedBy: areaId -> ids of areas that contain it
  const { containers, containedBy } = buildContainment(polygons);

  const areas = onlyAreaIds
    ? allAreas.filter((area) => onlyAreaIds.includes(area.areaId))
    : allAreas;
  if (onlyAreaIds) console.log(`Restricting to ${areas.length} of ${allAreas.length} areas.\n`);

  // These two passes write to different custom fields, so they can run in the same
  // execution without racing each other.
  const subzoneResult = await updateSubAreas(client, areas, containers, containedBy);
  const marketResult = await updateMarkets(client, areas, containers, containedBy);

  const submitted = [...subzoneResult.submitted, ...marketResult.submitted];
  const failures = [...subzoneResult.failures, ...marketResult.failures];
  const skippedOverlaps = [...subzoneResult.skippedOverlaps, ...marketResult.skippedOverlaps];

  printSummary(submitted, skippedOverlaps, failures);
  if (failures.length > 0) throw new Error(`${failures.length} Area update(s) failed.`);
}

type SubmitResult = {
  submitted: AreaId[];
  failures: { areaId: AreaId; message: string }[];
  skippedOverlaps: SkippedOverlap[];
};

// Labels every area that has no sub-areas of its own (i.e. isn't a container) as a subzone,
// tagged with its containment depth so deeper (more nested) updates can be submitted first.
async function updateSubAreas(
  client: TerrosClient,
  areas: AreaData[],
  containers: ContainmentIndex,
  containedBy: ContainmentIndex,
): Promise<SubmitResult & { skippedOverlaps: SkippedOverlap[] }> {
  const areaUpdates = deriveAreaUpdates(areas, containers, containedBy);
  const skippedOverlaps: SkippedOverlap[] = [];
  const skippedAreaIds = new Set(skippedOverlaps.map(({ areaId }) => areaId));

  const orderedAreaUpdates = areaUpdates
    .filter(({ area }) => !skippedAreaIds.has(area.areaId))
    .sort((first, second) => second.depth - first.depth);

  const result = await submitAreaUpdates(client, orderedAreaUpdates);
  return { ...result, skippedOverlaps };
}

// Labels only true top-level areas (areas that contain sub-areas but aren't themselves
// contained by anything else) as markets. A middle area in a 3-level stack is excluded
// because it still has a container of its own.
async function updateMarkets(
  client: TerrosClient,
  areas: AreaData[],
  containers: ContainmentIndex,
  containedBy: ContainmentIndex,
): Promise<SubmitResult> {
  let marketUpdates: AreaUpdate[] = [];
  if (marketFieldId) {
    marketUpdates = areas
      .filter((area) => isRootContainer(area, containers, containedBy))
      .map((area) => ({
        area,
        fieldId: marketFieldId,
        value: area.name!.trim(),
        depth: 0,
      }));
  }

  return submitAreaUpdates(client, marketUpdates);
}

// A "root container" is a valid, named polygon that contains at least one other area
// (containers.has) and has no container of its own (containedBy is empty).
function isRootContainer(
  area: AreaData,
  containers: ContainmentIndex,
  containedBy: ContainmentIndex,
): boolean {
  return (
    (area.name?.trim() ?? "") !== "" &&
    area.coordinates.length >= 3 &&
    containers.has(area.areaId) &&
    (containedBy.get(area.areaId)?.length ?? 0) === 0
  );
}

// Submits one client.account.bulk call per area/field update: the SDK's bulk filter only
// accepts a single polygon and a single action per call, so updates can't be batched further.
// The filter also excludes accounts where the field is already set, making each call idempotent.
async function submitAreaUpdates(
  client: TerrosClient,
  areaUpdates: AreaUpdate[],
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

// Recursively pages through every area on the account (1,000 per page) via the cursor.
async function listAreas(client: TerrosClient, cursor?: AreaSortCursor): Promise<AreaData[]> {
  const response = await client.area.list({ cursor, size: 1_000 });
  if (response.cursor === undefined) return response.areas;
  return [...response.areas, ...(await listAreas(client, response.cursor))];
}

type AreaPolygon = ReturnType<typeof turf.polygon>;

// areaId -> ids of related areas (containers: areas it contains; containedBy: areas that contain it)
type ContainmentIndex = Map<AreaId, AreaId[]>;

// Converts each area's coordinate list into a closed turf polygon, keyed by areaId.
// Areas with fewer than 3 points can't form a polygon and are skipped.
function buildPolygons(areas: AreaData[]): Map<AreaId, AreaPolygon> {
  const polygons = new Map<AreaId, AreaPolygon>();
  areas.map((area) => {
    if (area.coordinates.length < 3) return;
    const ring: [number, number][] = area.coordinates.map((point) => [
      point.longitude,
      point.latitude,
    ]);
    ring.push(ring[0]!);
    const polygon = turf.cleanCoords(turf.polygon([ring], { areaId: area.areaId }));
    polygons.set(area.areaId, polygon);
  });
  return polygons;
}

// Compares every pair of polygons and records geographic containment (turf.booleanContains)
// in both directions, so callers can look up an area's containers or containees in O(1).
function buildContainment(polygons: Map<AreaId, AreaPolygon>): {
  containers: ContainmentIndex;
  containedBy: ContainmentIndex;
} {
  const containers: ContainmentIndex = new Map();
  const containedBy: ContainmentIndex = new Map();

  [...polygons].forEach(([outerAreaId, outer]) => {
    [...polygons]
      .filter(
        ([innerAreaId, inner]) => innerAreaId !== outerAreaId && turf.booleanContains(outer, inner),
      )
      .forEach(([innerAreaId]) => {
        containers.set(outerAreaId, [...(containers.get(outerAreaId) ?? []), innerAreaId]);
        containedBy.set(innerAreaId, [...(containedBy.get(innerAreaId) ?? []), outerAreaId]);
      });
  });
  return { containers, containedBy };
}

function deriveAreaUpdates(
  areas: AreaData[],
  containers: ContainmentIndex,
  containedBy: ContainmentIndex,
): AreaUpdate[] {
  if (!subzoneFieldId && !marketFieldId) return [];

  return areas
    .map((area) => resolveAreaUpdate(area, containers, containedBy))
    .filter((update): update is AreaUpdate => update !== undefined);
}

function resolveAreaUpdate(
  area: AreaData,
  containers: ContainmentIndex,
  containedBy: ContainmentIndex,
): AreaUpdate | undefined {
  const name = area.name?.trim();
  if (!name || area.coordinates.length < 3) return undefined;

  if (containers.has(area.areaId)) return undefined;
  if (!subzoneFieldId) return undefined;

  const depth = containedBy.get(area.areaId)?.length ?? 0;
  return { area, fieldId: subzoneFieldId, value: name, depth };
}

function printSummary(
  submitted: AreaId[],
  skippedOverlaps: SkippedOverlap[],
  failures: { areaId: AreaId; message: string }[],
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

void main();
