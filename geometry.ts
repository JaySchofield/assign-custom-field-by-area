import type { AreaData, AreaId } from "@terros-inc/sdk";
import * as turf from "@turf/turf";
import type { ContainmentIndex } from "./types";

type AreaPolygon = ReturnType<typeof turf.polygon>;

// Converts each area's coordinate list into a closed turf polygon, keyed by areaId.
// Areas with fewer than 3 points can't form a polygon and are skipped.
export function buildPolygons(areas: AreaData[]): Map<AreaId, AreaPolygon> {
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
export function buildContainment(polygons: Map<AreaId, AreaPolygon>): {
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
