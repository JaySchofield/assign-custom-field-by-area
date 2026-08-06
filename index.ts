import { TerrosClient, type AreaData } from "@terros-inc/sdk";
import { parseCliOptions } from "./cli";
import { buildContainment, buildPolygons } from "./geometry";
import { printSummary } from "./report";
import { listAreas, submitAreaUpdates } from "./terrosApi";
import type { AreaUpdate, ContainmentIndex, SkippedOverlap, SubmitResult } from "./types";

const { subzoneFieldId, marketFieldId, dryRun, maxUpdatesPerPass, onlyAreaIds, verbose } =
  parseCliOptions();
const submitOptions = { dryRun, verbose, maxUpdatesPerPass };

// Infers a market/subzone hierarchy from Terros area polygons and bulk-updates matching
// accounts' custom fields accordingly. Geometry, API calls, and reporting live in their
// own modules; this file holds the market/subzone classification rules, which is the
// part most likely to need customer-specific tweaks.
async function main(): Promise<void> {
  if (dryRun) console.log("DRY RUN: no accounts will be updated.\n");

  const client = new TerrosClient(); // add ApiKey or use terros auth login from the CLI

  // Fetch every area, then derive geographic containment between all of them.
  const allAreas = await listAreas(client);
  const polygons = buildPolygons(allAreas);
  // containers: areaId -> ids of areas it geographically contains
  // containedBy: areaId -> ids of areas that contain it
  const { containers, containedBy } = buildContainment(polygons);

  // Containment is computed over every area so that a targeted area's containers/containees
  // are correctly identified even if they're not in onlyAreaIds themselves; only the final
  // update lists are filtered down to onlyAreaIds.
  const areas = onlyAreaIds
    ? allAreas.filter((area) => onlyAreaIds.includes(area.areaId))
    : allAreas;
  if (onlyAreaIds) console.log(`Restricting to ${areas.length} of ${allAreas.length} areas.\n`);

  // Classify each area as a subzone or market, then call account/bulk for each area
  const [subzoneResult, marketResult] = await Promise.all([
    updateSubAreas(client, areas, containers, containedBy),
    updateMarkets(client, areas, containers, containedBy),
  ]);

  const submitted = [...subzoneResult.submitted, ...marketResult.submitted];
  const failures = [...subzoneResult.failures, ...marketResult.failures];
  const skippedOverlaps = [...subzoneResult.skippedOverlaps, ...marketResult.skippedOverlaps];

  printSummary(submitted, skippedOverlaps, failures, dryRun);
  if (failures.length > 0) throw new Error(`${failures.length} Area update(s) failed.`);
}

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

  const result = await submitAreaUpdates(client, orderedAreaUpdates, submitOptions);
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

  return submitAreaUpdates(client, marketUpdates, submitOptions);
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

void main();
