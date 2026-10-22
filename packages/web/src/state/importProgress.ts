import type { HfStep } from '@nchc/data/hf';
import { useSyncExternalStore } from 'react';

/**
 * What the running Hugging Face import is doing (fetchHfModel's onProgress), so the answer can say it step by step
 * instead of a bare spinner. One import at a time (the latest wins); `null` when none runs.
 */
export type ImportProgress = { repo: string; steps: Array<{ step: HfStep; repo: string }> } | null;

let current: ImportProgress = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function startImportProgress(repo: string): void {
  current = { repo, steps: [] };
  emit();
}

export function reportImportStep(step: HfStep, repo: string): void {
  if (!current) return;
  current = { ...current, steps: [...current.steps, { step, repo }] };
  emit();
}

export function endImportProgress(): void {
  current = null;
  emit();
}

export function useImportProgress(): ImportProgress {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}
