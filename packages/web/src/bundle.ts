import { BundleSchema, type Bundle } from '@nchc/schema';
import raw from '../../data/dist/bundle.json';

let cached: Bundle | undefined;

/** The only place bundle.json is imported: validated once by BundleSchema, then cached. */
export function getBundle(): Bundle {
  cached ??= BundleSchema.parse(raw);
  return cached;
}
