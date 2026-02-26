import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_PATH = join(homedir(), ".pearsync", "config.json");

export function saveLastFolder(folder: string): void {
  const dir = dirname(CONFIG_PATH);
  mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ folder }), "utf-8");
}

export function loadLastFolder(): string | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const data = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (typeof data?.folder === "string" && data.folder) return data.folder;
    return null;
  } catch {
    return null;
  }
}
