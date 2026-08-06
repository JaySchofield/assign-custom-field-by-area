import type { AreaData, AreaId } from "@terros-inc/sdk";

export type FieldValue = string | number | boolean;

export type AreaUpdate = {
  area: AreaData;
  fieldId: `CF.${string}`;
  value: FieldValue;
  depth: number;
};

export type SkippedOverlap = { areaId: AreaId; overlappingAreaId: AreaId; fieldId: `CF.${string}` };

export type SubmitResult = {
  submitted: AreaId[];
  failures: { areaId: AreaId; message: string }[];
  skippedOverlaps: SkippedOverlap[];
};

// areaId -> ids of related areas (containers: areas it contains; containedBy: areas that contain it)
export type ContainmentIndex = Map<AreaId, AreaId[]>;
