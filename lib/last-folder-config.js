import { existsSync, mkdirSync, readFileSync, writeFileSync } from "bare-fs";
import { homedir } from "bare-os";
import { dirname, join } from "bare-path";
const CONFIG_PATH = join(homedir(), ".pearsync", "config.json");
function saveLastFolder(folder) {
  const dir = dirname(CONFIG_PATH);
  mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ folder }), "utf-8");
}
function loadLastFolder() {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const data = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (typeof data?.folder === "string" && data.folder) return data.folder;
    return null;
  } catch {
    return null;
  }
}
export {
  loadLastFolder,
  saveLastFolder
};
//# sourceMappingURL=last-folder-config.js.map
