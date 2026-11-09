export * from './types';
export { Face, flatToLocal } from './geometry';
export { RefError, REF_PATTERN, isRef } from './refs';
export { validatePlane, type Problem } from './validate';
export {
  GAP, PlaneError, compilePlane, compilePlaneSoFar, paperSize, opMatrix, stepMatrices, faceMatrix, arrowPath,
  linear, thereAndBack, range,
  type CompiledPlane, type CreaseRecord, type Step, type Op, type Profile,
} from './compile';
export { projectFinal, projectStep, type ThumbPolygon, type Projection } from './thumbnail';
export { auditPlane, auditStep, type AuditIssue, type AuditKind } from './audit';
export { refsAt, describeAfter, measureFinished, type RefInfo, type RefsReport, type StateReport, type FinishedMeasures } from './inspect';
export { projectionSvg, projectionShapes, stepsSheetSvg, stepDiagram, stepResult } from './svg';
