import { Cursor } from "@cursor/sdk";
import type { AdapterModel } from "@paperclipai/adapter-utils";

const MODELS_CACHE_TTL_MS = 60_000;
const MODELS_FETCH_TIMEOUT_MS = 10_000;

let cached: { keyFingerprint: string; expiresAt: number; models: AdapterModel[] } | null = null;

function fingerprint(apiKey: string): string {
  return `${apiKey.length}:${apiKey.slice(-6)}`;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function readLabel(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const rec = entry as Record<string, unknown>;
  for (const key of ["displayName", "label", "name"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

async function fetchCursorCloudModels(apiKey: string): Promise<AdapterModel[]> {
  const entries = await Promise.race([
    Cursor.models.list({ apiKey }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Cursor model list timed out.")), MODELS_FETCH_TIMEOUT_MS),
    ),
  ]);
  const models: AdapterModel[] = [];
  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) continue;
    models.push({ id: entry.id.trim(), label: readLabel(entry) ?? entry.id.trim() });
  }
  return dedupeModels(models);
}

/**
 * Discover Cursor Cloud models via the Cursor SDK using the server-level
 * CURSOR_API_KEY. Returns [] when no key is configured (per-agent keys live in
 * adapter config env and are not visible at registry scope).
 */
export async function listCursorCloudModels(options?: {
  forceRefresh?: boolean;
}): Promise<AdapterModel[]> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) return [];

  const forceRefresh = options?.forceRefresh === true;
  const now = Date.now();
  const keyFingerprint = fingerprint(apiKey);
  if (!forceRefresh && cached && cached.keyFingerprint === keyFingerprint && cached.expiresAt > now) {
    return cached.models;
  }

  try {
    const models = await fetchCursorCloudModels(apiKey);
    if (models.length > 0) {
      cached = { keyFingerprint, expiresAt: now + MODELS_CACHE_TTL_MS, models };
      return models;
    }
  } catch {
    // Fall through to stale cache / empty list below.
  }

  if (cached && cached.keyFingerprint === keyFingerprint && cached.models.length > 0) {
    return cached.models;
  }
  return [];
}

export function resetCursorCloudModelsCacheForTests() {
  cached = null;
}
