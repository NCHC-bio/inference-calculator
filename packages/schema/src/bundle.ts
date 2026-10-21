import { z } from 'zod';
import { SourceSchema } from './provenance';
import {
  HardwareSchema, PlatformSchema, QuantizationSchema, ModelSchema, WorkloadSchema,
  SpeedPresetSchema, CalibrationProfileSchema, ConcurrencyRuleSchema, CalibrationPointSchema,
  MetaSchema, PolicySchema, SkippedCalibrationPointSchema, CalibrationGapSchema, BenchmarkRuleSchema, CustomHardwareSchema,
} from './domain';

/** Bundle: every collection is a Record keyed by id; `concurrency`, `benchmark` and `policy` are single objects. */
export const BundleSchema = z.strictObject({
  meta: MetaSchema,
  policy: PolicySchema,
  sources: z.record(z.string(), SourceSchema),
  hardware: z.record(z.string(), HardwareSchema),
  platforms: z.record(z.string(), PlatformSchema),
  quantization: z.record(z.string(), QuantizationSchema),
  models: z.record(z.string(), ModelSchema),
  workloads: z.record(z.string(), WorkloadSchema),
  speedPresets: z.record(z.string(), SpeedPresetSchema),
  calibration: z.record(z.string(), CalibrationProfileSchema),
  concurrency: ConcurrencyRuleSchema,
  benchmark: BenchmarkRuleSchema,
  calibrationPoints: z.record(z.string(), CalibrationPointSchema),
  skippedCalibrationPoints: z.record(z.string(), SkippedCalibrationPointSchema),
  calibrationGaps: z.record(z.string(), CalibrationGapSchema),
  customHardware: CustomHardwareSchema,
});
export type Bundle = z.infer<typeof BundleSchema>;
