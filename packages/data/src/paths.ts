import { fileURLToPath } from 'node:url';

/** Repo-level `config/` directory (the single source of data truth). */
export const CONFIG_DIR = fileURLToPath(new URL('../../../config', import.meta.url));
/** Built bundle consumed by the website, MCP and core tests. */
export const BUNDLE_PATH = fileURLToPath(new URL('../dist/bundle.json', import.meta.url));
