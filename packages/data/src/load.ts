import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/** One parsed YAML file. `file` is relative to the config dir (forward slashes). */
export interface RawDoc {
  file: string;
  data: unknown;
}

/** Top-level config files, keyed by section name. */
export const CONFIG_FILES = {
  meta: 'meta.yaml',
  policy: 'policy.yaml',
  sources: 'sources.yaml',
  hardware: 'hardware.yaml',
  platforms: 'platforms.yaml',
  quantization: 'quantization.yaml',
  workloads: 'workloads.yaml',
  calibration: 'calibration.yaml',
  customHardware: 'custom-hardware.yaml',
} as const;
export type ConfigSection = keyof typeof CONFIG_FILES;

/** Raw, unvalidated config. A missing file is `undefined` here; validation reports it. */
export interface RawConfig {
  docs: Partial<Record<ConfigSection, RawDoc>>;
  /** One model per `models/*.yaml`, sorted by file name. Missing `models/` dir means no models. */
  models: RawDoc[];
}

function readYaml(dir: string, file: string): RawDoc {
  return { file, data: parse(readFileSync(join(dir, file), 'utf8')) as unknown };
}

/** Read every config YAML under `dir`. Throws only on YAML syntax errors. */
export function loadConfig(dir: string): RawConfig {
  const docs: RawConfig['docs'] = {};
  for (const [section, file] of Object.entries(CONFIG_FILES) as Array<[ConfigSection, string]>) {
    if (existsSync(join(dir, file))) docs[section] = readYaml(dir, file);
  }
  const modelsDir = join(dir, 'models');
  const models = existsSync(modelsDir)
    ? readdirSync(modelsDir)
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .sort()
        .map((f) => readYaml(dir, `models/${f}`))
    : [];
  return { docs, models };
}
