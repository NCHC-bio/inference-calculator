import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { loadConfig } from './load';
import { validateConfig } from './validate';
import { BUNDLE_PATH, CONFIG_DIR } from './paths';

const { bundle, issues } = validateConfig(loadConfig(CONFIG_DIR));
for (const i of issues) {
  console[i.level === 'error' ? 'error' : 'warn'](`${i.level}: config/${i.file} ${i.path}: ${i.message}`);
}
const errorCount = issues.filter((i) => i.level === 'error').length;
if (errorCount > 0 || !bundle) {
  console.error(`data:build failed with ${errorCount} error(s)`);
  process.exit(1);
}
mkdirSync(dirname(BUNDLE_PATH), { recursive: true });
writeFileSync(BUNDLE_PATH, `${JSON.stringify(bundle, null, 2)}\n`);
const shown = relative(process.cwd(), BUNDLE_PATH).split(sep).join('/');
console.log(`wrote ${shown} (dataVersion ${bundle.meta.dataVersion})`);
