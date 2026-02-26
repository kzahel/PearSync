export interface RuntimeCapabilities {
  /** True when running inside pear-electron Chromium renderer */
  readonly isPear: boolean;
  /** True when native folder picking (absolute paths) is available */
  readonly canPickFolder: boolean;
}

// Use getters to prevent Vite/Rollup from evaluating the Pear check at build
// time and tree-shaking PipeTransport out of the bundle.
export const runtime: RuntimeCapabilities = {
  get isPear() {
    return typeof globalThis.Pear !== "undefined";
  },
  get canPickFolder() {
    return typeof globalThis.Pear !== "undefined";
  },
};
