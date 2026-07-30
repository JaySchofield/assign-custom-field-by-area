import {
  TerrosClient,
  type AreaData,
  type AreaId,
  type AreaSortCursor,
  type LatLng,
} from "@terros-inc/sdk";

type FieldValue = string | number | boolean;

type AreaUpdate = {
  area: AreaData;
  fieldId: `CF.${string}`;
  value: FieldValue;
};

type SkippedOverlap = { areaId: AreaId; overlappingAreaId: AreaId; fieldId: `CF.${string}` };

const subzoneFieldId: `CF.${string}` | undefined = undefined;
const marketFieldId: `CF.${string}` | undefined = undefined;

async function main(): Promise<void> {
  const client = new TerrosClient({});
  const areaUpdates = deriveAreaUpdates(await listAreas(client));
  const skippedOverlaps = findSameFieldOverlaps(areaUpdates);
  const skippedAreaIds = new Set(skippedOverlaps.map(({ areaId }) => areaId));
  const submitted: AreaId[] = [];
  const failures: { areaId: AreaId; message: string }[] = [];

  for (const { area, fieldId, value } of areaUpdates) {
    if (skippedAreaIds.has(area.areaId)) continue;
    try {
      await client.account.bulk({
        filter: {
          ...area.filters,
          coordinates: area.coordinates,
          advancedCustomFields: {
            ...area.filters?.advancedCustomFields,
            [fieldId]: { type: "exists", exists: false },
          },
        },
        actions: [{ actionType: "updateCustomField", fieldId, value }],
      });
      submitted.push(area.areaId);
      console.log(`Submitted ${area.areaId}: ${fieldId} = ${String(value)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ areaId: area.areaId, message });
      console.error(`Failed ${area.areaId}: ${message}`);
    }
  }

  printSummary(submitted, skippedOverlaps, failures);
  if (failures.length > 0)
    throw new Error(`${failures.length} Area update${failures.length === 1 ? "" : "s"} failed.`);
}

async function listAreas(client: TerrosClient): Promise<AreaData[]> {
  const areas: AreaData[] = [];
  let cursor: AreaSortCursor | undefined;
  do {
    const response = await client.area.list({ cursor, size: 1_000 });
    areas.push(...response.areas);
    cursor = response.cursor;
  } while (cursor !== undefined);
  return areas;
}

function deriveAreaUpdates(areas: AreaData[]): AreaUpdate[] {
  const areaUpdates: AreaUpdate[] = [];
  if (!subzoneFieldId) return areaUpdates;

  for (const area of areas) {
    const name = area.name?.trim();
    if (!name || area.coordinates.length < 3) continue;

    const containingAreas = areas.filter(
      (candidate) =>
        candidate.areaId !== area.areaId &&
        polygonContains(candidate.coordinates, area.coordinates),
    );
    const containsAnotherArea = areas.some(
      (candidate) =>
        candidate.areaId !== area.areaId &&
        polygonContains(area.coordinates, candidate.coordinates),
    );

    if (containingAreas.length > 0 && !containsAnotherArea) {
      areaUpdates.push({ area, fieldId: subzoneFieldId, value: name });
      continue;
    }

    if (marketFieldId && containingAreas.length === 0 && containsAnotherArea) {
      areaUpdates.push({ area, fieldId: marketFieldId, value: name });
    }
  }

  return areaUpdates;
}

function findSameFieldOverlaps(areaUpdates: AreaUpdate[]): SkippedOverlap[] {
  const skippedOverlaps: SkippedOverlap[] = [];
  for (let index = 0; index < areaUpdates.length; index += 1) {
    const current = areaUpdates[index];
    if (!current) continue;
    for (const candidate of areaUpdates.slice(index + 1)) {
      if (current.fieldId !== candidate.fieldId) continue;
      if (!polygonsOverlap(current.area.coordinates, candidate.area.coordinates)) continue;
      skippedOverlaps.push(
        {
          areaId: current.area.areaId,
          overlappingAreaId: candidate.area.areaId,
          fieldId: current.fieldId,
        },
        {
          areaId: candidate.area.areaId,
          overlappingAreaId: current.area.areaId,
          fieldId: candidate.fieldId,
        },
      );
    }
  }
  return skippedOverlaps;
}

function polygonContains(container: LatLng[], polygon: LatLng[]): boolean {
  return (
    container.length >= 3 &&
    polygon.length >= 3 &&
    polygon.every((point) => pointInPolygon(point, container))
  );
}

function polygonsOverlap(first: LatLng[], second: LatLng[]): boolean {
  if (first.length < 3 || second.length < 3) return false;
  if (first.some((point) => pointInPolygon(point, second))) return true;
  if (second.some((point) => pointInPolygon(point, first))) return true;
  return first.some((point, index) => {
    const next = first[(index + 1) % first.length];
    if (!next) return false;
    return second.some((otherPoint, otherIndex) => {
      const otherNext = second[(otherIndex + 1) % second.length];
      return otherNext ? segmentsIntersect(point, next, otherPoint, otherNext) : false;
    });
  });
}

function pointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1
  ) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    if (!currentPoint || !previousPoint) continue;
    const crosses =
      currentPoint.latitude > point.latitude !== previousPoint.latitude > point.latitude &&
      point.longitude <
        ((previousPoint.longitude - currentPoint.longitude) *
          (point.latitude - currentPoint.latitude)) /
          (previousPoint.latitude - currentPoint.latitude) +
          currentPoint.longitude;
    if (crosses) inside = !inside;
  }
  return inside;
}

function segmentsIntersect(
  firstStart: LatLng,
  firstEnd: LatLng,
  secondStart: LatLng,
  secondEnd: LatLng,
): boolean {
  const first = orientation(firstStart, firstEnd, secondStart);
  const second = orientation(firstStart, firstEnd, secondEnd);
  const third = orientation(secondStart, secondEnd, firstStart);
  const fourth = orientation(secondStart, secondEnd, firstEnd);
  if (first === 0 && pointOnSegment(firstStart, secondStart, firstEnd)) return true;
  if (second === 0 && pointOnSegment(firstStart, secondEnd, firstEnd)) return true;
  if (third === 0 && pointOnSegment(secondStart, firstStart, secondEnd)) return true;
  if (fourth === 0 && pointOnSegment(secondStart, firstEnd, secondEnd)) return true;
  return first > 0 !== second > 0 && third > 0 !== fourth > 0;
}

function orientation(first: LatLng, second: LatLng, third: LatLng): number {
  return (
    (second.longitude - first.longitude) * (third.latitude - first.latitude) -
    (second.latitude - first.latitude) * (third.longitude - first.longitude)
  );
}

function pointOnSegment(start: LatLng, point: LatLng, end: LatLng): boolean {
  return (
    point.latitude >= Math.min(start.latitude, end.latitude) &&
    point.latitude <= Math.max(start.latitude, end.latitude) &&
    point.longitude >= Math.min(start.longitude, end.longitude) &&
    point.longitude <= Math.max(start.longitude, end.longitude)
  );
}

function printSummary(
  submitted: AreaId[],
  skippedOverlaps: SkippedOverlap[],
  failures: { areaId: AreaId; message: string }[],
): void {
  console.log(
    `\nSummary: ${submitted.length} submitted, ${skippedOverlaps.length} overlap skips, ${failures.length} API failures.`,
  );
  for (const skipped of skippedOverlaps)
    console.warn(
      `Skipped ${skipped.areaId}: overlaps ${skipped.overlappingAreaId} for ${skipped.fieldId}.`,
    );
}

void main();
