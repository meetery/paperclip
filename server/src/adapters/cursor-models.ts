import { models as cursorFallbackModels } from "@paperclipai/adapter-cursor-local";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { AdapterModel } from "./types.js";

// `agent models` can pay CLI cold-start overhead on first invocation, so give
// discovery more headroom than a bare exec would need.
const CURSOR_MODELS_TIMEOUT_MS = 15_000;
const CURSOR_MODELS_CACHE_TTL_MS = 60_000;

let cached: { expiresAt: number; models: AdapterModel[] } | null = null;

type CursorModelsCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  hasError: boolean;
};

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

function sanitizeModelId(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\(.*\)\s*$/g, "")
    .trim();
}

function isLikelyModelId(raw: string): boolean {
  const value = sanitizeModelId(raw);
  if (!value) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}

function pushModelId(target: AdapterModel[], raw: string, label?: string) {
  const id = sanitizeModelId(raw);
  if (!isLikelyModelId(id)) return;
  const trimmedLabel = label?.trim() ?? "";
  target.push({ id, label: trimmedLabel || id });
}

function collectFromJsonValue(value: unknown, target: AdapterModel[]) {
  if (typeof value === "string") {
    pushModelId(target, value);
    return;
  }
  if (!Array.isArray(value)) return;

  for (const item of value) {
    if (typeof item === "string") {
      pushModelId(target, item);
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    const rawLabel = (item as { label?: unknown }).label;
    pushModelId(target, id, typeof rawLabel === "string" ? rawLabel : undefined);
  }
}

// Matches the current `agent models` plain-text format:
//   gpt-5.5-high - GPT-5.5 1M High
const MODEL_ID_LABEL_LINE_RE = /^([A-Za-z0-9][A-Za-z0-9._/-]*)\s+-\s+(.+)$/;

export function parseCursorModelsOutput(stdout: string, stderr: string): AdapterModel[] {
  const models: AdapterModel[] = [];
  const combined = `${stdout}\n${stderr}`;

  const trimmedStdout = stdout.trim();
  if (trimmedStdout.startsWith("{") || trimmedStdout.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmedStdout) as unknown;
      if (Array.isArray(parsed)) {
        collectFromJsonValue(parsed, models);
      } else if (typeof parsed === "object" && parsed !== null) {
        const rec = parsed as Record<string, unknown>;
        collectFromJsonValue(rec.models, models);
        collectFromJsonValue(rec.data, models);
      }
    } catch {
      // Ignore malformed JSON and continue parsing plain text formats.
    }
  }

  for (const match of combined.matchAll(/available models?:\s*([^\n]+)/gi)) {
    const list = match[1] ?? "";
    for (const token of list.split(",")) {
      pushModelId(models, token);
    }
  }

  for (const lineRaw of combined.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    const bullet = line.replace(/^[-*]\s+/, "").trim();
    if (!bullet) continue;
    const idLabelMatch = bullet.match(MODEL_ID_LABEL_LINE_RE);
    if (idLabelMatch) {
      pushModelId(models, idLabelMatch[1] ?? "", idLabelMatch[2]);
      continue;
    }
    if (bullet.includes(" ")) continue;
    pushModelId(models, bullet);
  }

  return dedupeModels(models);
}

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeModels([...models, ...cursorFallbackModels]);
}

async function defaultCursorModelsRunner(): Promise<CursorModelsCommandResult> {
  try {
    const result = await runChildProcess(
      `cursor-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "agent",
      ["models"],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: CURSOR_MODELS_TIMEOUT_MS / 1000,
        graceSec: 3,
        onLog: async () => {},
      },
    );
    return {
      status: result.timedOut ? null : result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      hasError: result.timedOut,
    };
  } catch {
    return { status: null, stdout: "", stderr: "", hasError: true };
  }
}

let cursorModelsRunner: () => CursorModelsCommandResult | Promise<CursorModelsCommandResult> =
  defaultCursorModelsRunner;

async function fetchCursorModelsFromCli(): Promise<AdapterModel[]> {
  const result = await cursorModelsRunner();
  const { stdout, stderr } = result;
  if (result.hasError && stdout.trim().length === 0 && stderr.trim().length === 0) {
    return [];
  }
  if ((result.status ?? 1) !== 0 && !/available models?\b/i.test(`${stdout}\n${stderr}`)) {
    return [];
  }

  return parseCursorModelsOutput(stdout, stderr);
}

async function loadCursorModels(options?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  const forceRefresh = options?.forceRefresh === true;
  const now = Date.now();
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.models;
  }

  const discovered = await fetchCursorModelsFromCli();
  if (discovered.length > 0) {
    const merged = mergedWithFallback(discovered);
    cached = {
      expiresAt: now + CURSOR_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (cached && cached.models.length > 0) {
    return cached.models;
  }

  return dedupeModels(cursorFallbackModels);
}

export async function listCursorModels(): Promise<AdapterModel[]> {
  return loadCursorModels();
}

export async function refreshCursorModels(): Promise<AdapterModel[]> {
  return loadCursorModels({ forceRefresh: true });
}

export function resetCursorModelsCacheForTests() {
  cached = null;
}

export function setCursorModelsRunnerForTests(
  runner: (() => CursorModelsCommandResult | Promise<CursorModelsCommandResult>) | null,
) {
  cursorModelsRunner = runner ?? defaultCursorModelsRunner;
}
