/** Public surface of @nchc/core: the API functions and their types (spec §9). */
export {
  estimateRequirements,
  estimateCapacity,
  findFeasibleModels,
  explain,
  verifyCommand,
  resolvePlatform,
  resolveCustomPlatform,
  CustomPlatformInputSchema,
  type CustomPlatformInput,
  type ResolvedApiPlatform,
  resolveModel,
  resolveQuant,
  predictMeasurement,
  quantOptions,
  quantOptionsFor,
  type ImportedModelInput,
  QueryInputSchema,
  ModelOverrideSchema,
  type QueryInput,
  type RequirementInput,
  type CapacityInput,
  type FeasibleInput,
  type ExplainInput,
  type ModelOverride,
  type PredictInput,
  type MeasurementPrediction,
  type ApiPlatform,
  type SolveOut,
  type PlatformResult,
  type RequirementResult,
  type FeasibleModel,
  type NativeQuantOut,
  type QuantResolution,
  type BasisItem,
  type Queueing,
  type ShapeUsage,
  type CapacityResult,
  type SpeedCurve,
  CoreInputError,
  type CoreInputErrorCode,
  CUSTOM_MODEL_WARNING,
  nonstandardConfigWarning,
  type ResultWarning,
} from './api';
/** Model math the data package reuses for config validation (Ruling R31c: one formula, no copies). */
/** Excluded-org owner lookup used by the config validator on the catalog (spec §2.2); not applied to user input. */
export { excludedOrgOf, secondarySourceIssue, nativeQuantIssue, type NativeQuantIssue } from './policy';
export { expertParamsTotalB, activeParamsB, moeParamsIssue, mlaLayoutIssues, layerShapeIssues } from './model-math';
export type { ResolvedPlatform, Shape, Why, EtaMode, Ctx } from './solve';
/** vLLM's TP legality rule, shared with the config validator for calibration points (Ruling R41). */
export { legalTpOptions } from './solve';
/** Per-shape usage for the web detail panel (spec §8.3.3). */
export { shapeUsage } from './solve';
export type { Replica, WorkloadIn } from './timing';
/** Performance of a chosen platform, GPU count and user count (spec 2026-10-21 §5.1). */
export {
  estimatePerformance,
  estimatePerformanceSweep,
  PerformanceInputSchema,
  PERFORMANCE_CURVE_POINTS,
  type PerformanceInput,
  type PerformanceResult,
  type SplitEval,
  type SweepInput,
  type SweepPoint,
} from './performance';
/** Peak concurrent users from the total registered users (spec 2026-10-21 §5.5). */
export { peakConcurrentFromTotal, type FunnelInput, type FunnelResult } from './funnel';
