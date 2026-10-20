import { readFileSync } from 'node:fs';
import { BundleSchema, type Bundle } from '@nchc/schema';
import { BUNDLE_PATH } from './paths';

/** Read and re-validate `packages/data/dist/bundle.json` (run `pnpm data:build` first). */
export function loadBundle(path: string = BUNDLE_PATH): Bundle {
  return BundleSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
