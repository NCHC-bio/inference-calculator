/** Public surface of @nchc/core: the API functions and their types (spec §9). */
export {
  estimateRequirements,
  estimateCapacity,
  findFeasibleModels,
  explain,
  verifyCommand,
  resolvePlatform,
  resolveModel,
  resolveQuant,
  predictMeasurement,
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
  CoreInputError,
  type CoreInputErrorCode,
  CUSTOM_MODEL_WARNING,
  type ResultWarning,
} from './api';
/** Model math the data package reuses for config validation (Ruling R31c: one formula, no copies). */
/** Excluded-org owner lookup used by the config validator on the catalog (spec §2.2); not applied to user input. */
export { excludedOrgOf } from './policy';
export { expertParamsTotalB, activeParamsB, moeParamsIssue, mlaLayoutIssues, layerShapeIssues } from './model-math';
export type { ResolvedPlatform, Shape, Why, EtaMode, Ctx } from './solve';
/** vLLM's TP legality rule, shared with the config validator for calibration points (Ruling R41). */
export { legalTpOptions } from './solve';
export type { Replica, WorkloadIn } from './timing';
