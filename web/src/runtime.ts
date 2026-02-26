export interface RuntimeCapabilities {
  /** True when running inside pear-electron Chromium renderer */
  isPear: boolean;
  /** True when native folder picking (absolute paths) is available */
  canPickFolder: boolean;
}

export const runtime: RuntimeCapabilities = {
  isPear: typeof globalThis.Pear !== "undefined",
  canPickFolder: typeof globalThis.Pear !== "undefined",
};
