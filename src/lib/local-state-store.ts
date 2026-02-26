import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface FileState {
	/** Hash of the file content when we last completed a sync (upload or download) */
	lastSyncedHash: string;
	/** Mtime when we last completed a sync */
	lastSyncedMtime: number;
	/** Hash from the manifest entry we last processed */
	lastManifestHash: string;
	/** Writer key from the manifest entry we last processed */
	lastManifestWriterKey: string;
}

let persistCounter = 0;

export class LocalStateStore {
	private state: Map<string, FileState> = new Map();
	private filePath: string;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(syncFolder: string) {
		this.filePath = join(syncFolder, ".pearsync", "state.json");
	}

	/** Load state from disk. Creates the file if it doesn't exist. */
	async load(): Promise<void> {
		try {
			const data = await readFile(this.filePath, "utf-8");
			const parsed = JSON.parse(data) as Record<string, FileState>;
			this.state = new Map(Object.entries(parsed));
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				this.state = new Map();
				await this.persist();
			} else {
				throw err;
			}
		}
	}

	/** Get the tracked state for a file path. */
	get(path: string): FileState | undefined {
		return this.state.get(path);
	}

	/** Update state for a file path and persist to disk. */
	async set(path: string, state: FileState): Promise<void> {
		this.state.set(path, state);
		await this.persist();
	}

	/** Remove state for a file path and persist to disk. */
	async remove(path: string): Promise<void> {
		this.state.delete(path);
		await this.persist();
	}

	/** Check if a path is tracked. */
	has(path: string): boolean {
		return this.state.has(path);
	}

	/** Get all tracked paths. */
	paths(): string[] {
		return [...this.state.keys()];
	}

	/** Atomic write: write to uniquely-named .tmp, then rename over the real file. Serialized via queue. */
	private persist(): Promise<void> {
		this.writeQueue = this.writeQueue.then(() => this.doPersist());
		return this.writeQueue;
	}

	private async doPersist(): Promise<void> {
		const dir = dirname(this.filePath);
		await mkdir(dir, { recursive: true });

		const obj: Record<string, FileState> = {};
		for (const [k, v] of this.state) {
			obj[k] = v;
		}

		const tmpPath = `${this.filePath}.${++persistCounter}.tmp`;
		await writeFile(tmpPath, JSON.stringify(obj, null, 2));
		await rename(tmpPath, this.filePath);
	}
}
