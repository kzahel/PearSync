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

export class PipeTransport implements Transport {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private pushListeners = new Set<PushCallback>();

  constructor() {
    this.listen();
  }

  private async listen() {
    const messages = Pear.messages();
    for await (const raw of messages) {
      let msg: PipeResponse;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        continue;
      }

      if (msg.id !== undefined) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        }
      } else if (msg.type) {
        for (const fn of this.pushListeners) {
          fn({ type: msg.type, payload: msg.payload, timestamp: msg.timestamp! });
        }
      }
    }
  }

  private send(request: PipeRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      Pear.message(JSON.stringify(request));
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
