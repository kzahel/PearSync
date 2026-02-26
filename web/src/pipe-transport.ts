import type { Transport } from "./transport";

interface PipeRequest {
  id: number;
  method: "get" | "post";
  params: { path: string; body?: unknown; query?: Record<string, string> };
}

interface PipeResponse {
  id?: number;
  result?: unknown;
  error?: string;
  type?: string;
  payload?: unknown;
  timestamp?: number;
}

export type PushCallback = (msg: { type: string; payload: unknown; timestamp: number }) => void;

// Toggle with: localStorage.setItem("pipe:debug", "1") then reload
const DEBUG = typeof localStorage !== "undefined" && localStorage.getItem("pipe:debug") === "1";

function log(dir: string, summary: string, detail?: unknown) {
  if (!DEBUG) return;
  const ts = new Date().toISOString().slice(11, 23);
  if (detail !== undefined) console.log(`%c[pipe:ui ${ts}] ${dir} ${summary}`, "color:#7af", detail);
  else console.log(`%c[pipe:ui ${ts}] ${dir} ${summary}`, "color:#7af");
}

// Access the IPC pipe that pear-electron provides in the renderer.
// This is the same approach pear-pipe uses internally (PearElectronPipe),
// inlined here because the Vite bundle can't resolve bare pear-pipe imports.
function getIpcPipe(): {
  on(event: string, fn: (data: unknown) => void): void;
  off(event: string, fn: (data: unknown) => void): void;
  write(data: string | Uint8Array): boolean;
} {
  const P = globalThis.Pear;
  const ipc = P?.[P?.constructor.IPC];
  if (!ipc?.pipe) throw new Error("Pear IPC pipe not available");
  return ipc.pipe();
}

export class PipeTransport implements Transport {
  private static REQUEST_TIMEOUT_MS = 30_000;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private pushListeners = new Set<PushCallback>();
  private pipe: ReturnType<typeof getIpcPipe>;
  private buf = "";

  constructor() {
    this.pipe = getIpcPipe();
    this.pipe.on("data", this.onRawData);
  }

  // Newline-delimited JSON framing: buffer chunks, split on \n
  private onRawData = (raw: unknown) => {
    const chunk = typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString();
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handleMessage(line);
    }
  };

  private handleMessage(line: string) {
    let msg: PipeResponse;
    try {
      msg = JSON.parse(line);
    } catch {
      log("<<", "malformed JSON", line.slice(0, 120));
      return;
    }

    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          log("<<", `#${msg.id} ERR`, msg.error);
          pending.reject(new Error(msg.error));
        } else {
          log("<<", `#${msg.id} OK`, msg.result);
          pending.resolve(msg.result);
        }
      } else {
        log("<<", `#${msg.id} (no pending handler)`);
      }
    } else if (msg.type) {
      log("<<", `push:${msg.type}`, msg.payload);
      for (const fn of this.pushListeners) {
        fn({ type: msg.type, payload: msg.payload, timestamp: msg.timestamp ?? Date.now() });
      }
    }
  }

  private send(request: PipeRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`Request ${request.params.path} timed out`));
      }, PipeTransport.REQUEST_TIMEOUT_MS);
      this.pending.set(request.id, { resolve, reject, timer });
      log(">>", `#${request.id} ${request.method.toUpperCase()} ${request.params.path}`);
      this.pipe.write(JSON.stringify(request) + "\n");
    });
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const id = this.nextId++;
    return this.send({ id, method: "get", params: { path, query: params } }) as Promise<T>;
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const id = this.nextId++;
    return this.send({ id, method: "post", params: { path, body } }) as Promise<T>;
  }

  subscribe(fn: PushCallback): () => void {
    this.pushListeners.add(fn);
    return () => this.pushListeners.delete(fn);
  }
}
