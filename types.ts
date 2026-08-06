import type { AreaData, AreaId } from "@terros-inc/sdk";

export type FieldValue = string | number | boolean;

// A single area's classification result: which custom field to set on matching accounts,
// what to set it to, and how deeply nested the area is (used to order submissions).
export type AreaUpdate = {
  area: AreaData;
  fieldId: `CF.${string}`;
  value: FieldValue;
  depth: number;
};

// An area that was skipped because it overlaps another area targeting the same field.
export type SkippedOverlap = { areaId: AreaId; overlappingAreaId: AreaId; fieldId: `CF.${string}` };

// Outcome of submitting a batch of AreaUpdates: which areas succeeded, which failed (with
// an error message), and which were skipped up front due to a same-field overlap.
export type SubmitResult = {
  submitted: AreaId[];
  failures: { areaId: AreaId; message: string }[];
  skippedOverlaps: SkippedOverlap[];
};

// areaId -> ids of related areas (containers: areas it contains; containedBy: areas that contain it)
export type ContainmentIndex = Map<AreaId, AreaId[]>;
