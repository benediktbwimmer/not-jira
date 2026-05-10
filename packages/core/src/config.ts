import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { defaultNotJiraConfigPath } from "./types.js";

export const notJiraConfigSchema = z.object({
  ui: z.object({
    refreshIntervalMs: z.number().int().min(1000).max(600000).optional(),
    persistState: z.boolean().optional()
  }).optional()
}).transform((config) => ({
  ui: {
    refreshIntervalMs: config.ui?.refreshIntervalMs ?? 5000,
    persistState: config.ui?.persistState ?? true
  }
}));

export type NotJiraConfig = z.infer<typeof notJiraConfigSchema>;
export type PublicNotJiraConfig = Pick<NotJiraConfig, "ui">;

export interface NotJiraConfigReadResult {
  path: string;
  exists: boolean;
  config: NotJiraConfig;
  issues: string[];
}

export function defaultNotJiraConfig(): NotJiraConfig {
  return notJiraConfigSchema.parse({});
}

export function publicNotJiraConfig(config: NotJiraConfig): PublicNotJiraConfig {
  return { ui: config.ui };
}

export async function readNotJiraConfig(configPath = defaultNotJiraConfigPath()): Promise<NotJiraConfigReadResult> {
  const fallback = defaultNotJiraConfig();
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = notJiraConfigSchema.safeParse(parsed);
    if (!result.success) {
      return {
        path: configPath,
        exists: true,
        config: fallback,
        issues: result.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      };
    }
    return { path: configPath, exists: true, config: result.data, issues: [] };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { path: configPath, exists: false, config: fallback, issues: [] };
    }
    return {
      path: configPath,
      exists: false,
      config: fallback,
      issues: [error instanceof Error ? error.message : String(error)]
    };
  }
}

export async function ensureNotJiraConfig(configPath = defaultNotJiraConfigPath()): Promise<NotJiraConfigReadResult> {
  const result = await readNotJiraConfig(configPath);
  if (result.exists) {
    return result;
  }
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(defaultNotJiraConfig(), null, 2)}\n`, "utf8");
  return { ...result, exists: true };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
