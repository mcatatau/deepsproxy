/*
 * File: telemetry.ts
 * Project: deepsproxy
 * Telemetry system to automatically detect and estimate model context window limits based on usage.
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface ModelTelemetry {
  detectedLimit: number; // in characters
  maxSuccessSize: number; // in characters
  minFailureSize: number; // in characters
}

const DEFAULT_CONTEXT_CHARACTERS = 64_000 * 3.5; // Roughly 224,000 characters (representing 64,000 tokens)
const MIN_CONTEXT_CHARACTERS = 50 * 3.5; // 175 characters (representing 50 tokens)

// Thread-safe telemetry store using Map with async lock queue
class TelemetryStore {
  private store: Map<string, ModelTelemetry> = new Map();
  private locks: Map<string, Promise<void>> = new Map();
  private als: AsyncLocalStorage<Map<string, ModelTelemetry>> = new AsyncLocalStorage();

  constructor() {
    // Initialize from globalThis if available (for hot-reload survival)
    const existing = (globalThis as any)._telemetryStore;
    if (existing && existing instanceof Map) {
      this.store = existing;
    } else {
      (globalThis as any)._telemetryStore = this.store;
    }
  }

  private async withLock<T>(model: string, fn: () => T): Promise<T> {
    // Get or create lock for this model
    let lock = this.locks.get(model);
    
    if (!lock) {
      lock = Promise.resolve();
    }

    let resolveLock: () => void;
    const newLock = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    this.locks.set(model, newLock);
    
    // Wait for previous lock to release
    await lock;

    try {
      return fn();
    } finally {
      resolveLock!();
    }
  }

  get(model: string): ModelTelemetry {
    if (!this.store.has(model)) {
      this.store.set(model, {
        detectedLimit: DEFAULT_CONTEXT_CHARACTERS,
        maxSuccessSize: 0,
        minFailureSize: Infinity,
      });
    }
    return this.store.get(model)!;
  }

  async recordSuccess(model: string, promptSize: number): Promise<void> {
    await this.withLock(model, () => {
      const stats = this.get(model);
      stats.maxSuccessSize = Math.max(stats.maxSuccessSize, promptSize);
      
      // If the successful prompt was larger than our estimated limit, increase the limit
      if (promptSize > stats.detectedLimit) {
        stats.detectedLimit = promptSize;
      }
      
      // Ensure detectedLimit is not above minFailureSize if we have recorded a failure
      if (stats.detectedLimit >= stats.minFailureSize) {
        stats.detectedLimit = Math.floor(stats.minFailureSize * 0.95);
      }
      
      console.log(`[Telemetry] Recorded success for model '${model}'. Prompt size: ${promptSize} chars. Estimated context limit: ${stats.detectedLimit} chars (~${Math.ceil(stats.detectedLimit / 3.5)} tokens).`);
    });
  }

  async recordFailure(model: string, promptSize: number): Promise<void> {
    await this.withLock(model, () => {
      const stats = this.get(model);
      stats.minFailureSize = Math.min(stats.minFailureSize, promptSize);
      
      // On failure, adjust the estimated limit downwards.
      // We estimate the new limit as 85% of the failed prompt size
      const newLimit = Math.floor(promptSize * 0.85);
      
      // Do not let it drop below our safe minimum context size
      stats.detectedLimit = Math.max(MIN_CONTEXT_CHARACTERS, Math.min(stats.detectedLimit, newLimit));
      
      // Keep it above the maximum known success size
      if (stats.detectedLimit < stats.maxSuccessSize) {
        stats.detectedLimit = stats.maxSuccessSize;
      }
      
      console.log(`[Telemetry] Recorded failure for model '${model}'. Prompt size: ${promptSize} chars. Estimated context limit reduced to: ${stats.detectedLimit} chars (~${Math.ceil(stats.detectedLimit / 3.5)} tokens).`);
    });
  }
}

export const telemetryStore = new TelemetryStore();

export function getModelTelemetry(model: string): ModelTelemetry {
  return telemetryStore.get(model);
}

export function getContextLength(model: string): number {
  const stats = telemetryStore.get(model);
  // Return in tokens (assuming roughly 3.5 characters per token)
  return Math.ceil(stats.detectedLimit / 3.5);
}

export async function recordSuccess(model: string, promptSize: number): Promise<void> {
  await telemetryStore.recordSuccess(model, promptSize);
}

export async function recordFailure(model: string, promptSize: number): Promise<void> {
  await telemetryStore.recordFailure(model, promptSize);
}

export function getTelemetryStats(): { models: Record<string, ModelTelemetry> } {
  const models: Record<string, ModelTelemetry> = {};
  // Access the internal store map
  for (const [key, value] of (telemetryStore as any).store.entries()) {
    models[key] = value;
  }
  return { models };
}
