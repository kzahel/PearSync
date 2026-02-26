import { PipeTransport, type PushCallback } from "./pipe-transport";
import { runtime } from "./runtime";

export type { PushCallback } from "./pipe-transport";

export interface Transport {
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

class HttpTransport implements Transport {
  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = params ? `${path}?${new URLSearchParams(params)}` : path;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text);
    }
    return res.json();
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method: "POST",
      headers: body != null ? { "Content-Type": "application/json" } : {},
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text);
    }
    return res.json();
  }
}

let _pipeTransport: PipeTransport | null = null;

function createTransport(): Transport {
  if (runtime.isPear) {
    _pipeTransport = new PipeTransport();
    return _pipeTransport;
  }
  return new HttpTransport();
}

export const transport: Transport = createTransport();

export function subscribeToPush(fn: PushCallback): (() => void) | null {
  if (_pipeTransport) {
    return _pipeTransport.subscribe(fn);
  }
  return null;
}
