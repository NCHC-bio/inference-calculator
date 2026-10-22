import { ModelOverrideSchema, type ModelOverride } from '@nchc/core';
import { HF_REPO_RE } from '@nchc/schema';
import { useSyncExternalStore } from 'react';

/**
 * The user's own models (Hugging Face imports and manual entries), kept in this browser so they survive switching to
 * a catalog model and opening the site again. Per-viewer convenience only: localStorage, every access guarded (a
 * private window or blocked site data gives an empty list and nothing breaks). An import is stored as repo@commit and
 * its name only, never a token and never the computed model: picking it imports it again at that commit, so an
 * architecture modelled precisely since then gets precise numbers.
 */
export type MyModel =
  | { kind: 'hf'; repo: string; sha: string; name: string }
  | { kind: 'manual'; value: ModelOverride; name: string };

export const MY_MODELS_KEY = 'nchc-calc.my-models.v1';
/** Most recent first; the oldest drops off past this many. */
export const MY_MODELS_MAX = 20;
const SHA_RE = /^[\w.-]+$/;

/** A stable identity: repo@commit, or the manual architecture itself. */
export const myModelKey = (m: MyModel): string =>
  m.kind === 'hf' ? `hf:${m.repo}@${m.sha}` : `manual:${JSON.stringify(m.value)}`;

function valid(x: unknown): MyModel | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (o.kind === 'hf' && typeof o.repo === 'string' && HF_REPO_RE.test(o.repo) && typeof o.sha === 'string' && SHA_RE.test(o.sha)) {
    return { kind: 'hf', repo: o.repo, sha: o.sha, name: typeof o.name === 'string' && o.name ? o.name : o.repo };
  }
  if (o.kind === 'manual') {
    const v = ModelOverrideSchema.safeParse(o.value);
    if (v.success) return { kind: 'manual', value: v.data, name: typeof o.name === 'string' && o.name ? o.name : (v.data.name ?? '') };
  }
  return null;
}

function read(): MyModel[] {
  try {
    const raw = JSON.parse(localStorage.getItem(MY_MODELS_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.map(valid).filter((m): m is MyModel => m !== null) : [];
  } catch {
    return [];
  }
}

let cache: MyModel[] | null = null;
const listeners = new Set<() => void>();
const snapshot = (): MyModel[] => (cache ??= read());

function write(list: MyModel[]): void {
  cache = list;
  try {
    localStorage.setItem(MY_MODELS_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: the list still holds for this visit */
  }
  for (const l of listeners) l();
}

/** Adds or refreshes a model at the top of the list (same key: moved up, name updated). */
export function saveMyModel(m: MyModel): void {
  const key = myModelKey(m);
  write([m, ...snapshot().filter((x) => myModelKey(x) !== key)].slice(0, MY_MODELS_MAX));
}

export function removeMyModel(key: string): void {
  write(snapshot().filter((x) => myModelKey(x) !== key));
}

export function clearMyModels(): void {
  write([]);
}

/** Test hook: forget the in-memory copy so the next read comes from storage. */
export function resetMyModelsCache(): void {
  cache = null;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  // Another tab changed the list.
  const onStorage = (e: StorageEvent) => {
    if (e.key === MY_MODELS_KEY) {
      cache = null;
      l();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

export function useMyModels(): MyModel[] {
  return useSyncExternalStore(subscribe, snapshot, () => []);
}
