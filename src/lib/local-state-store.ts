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
	private backupPath: string;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(syncFolder: string) {
		this.filePath = join(syncFolder, ".pearsync", "state.json");
		this.backupPath = join(syncFolder, ".pearsync", "state.json.bak");
	}

	/** Load state from disk. Creates the file if it doesn't exist. */
	async load(): Promise<void> {
		const primary = await this.tryLoadFromPath(this.filePath);
		if (primary) {
			this.state = primary;
			return;
		}

		const backup = await this.tryLoadFromPath(this.backupPath);
		if (backup) {
			this.state = backup;
			await this.persist();
			return;
		}

		this.state = new Map();
		await this.persist();
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

		const serialized = JSON.stringify(this.toObject(), null, 2);
		const id = ++persistCounter;

		const tmpPath = `${this.filePath}.${id}.tmp`;
		await writeFile(tmpPath, serialized);
		await rename(tmpPath, this.filePath);

		const tmpBackupPath = `${this.backupPath}.${id}.tmp`;
		await writeFile(tmpBackupPath, serialized);
		await rename(tmpBackupPath, this.backupPath);
	}

	private async tryLoadFromPath(path: string): Promise<Map<string, FileState> | null> {
		try {
			const data = await readFile(path, "utf-8");
			return this.parseState(data);
		} catch (err: unknown) {
			if (this.isRecoverableLoadError(err)) return null;
			throw err;
		}
	}

	private isRecoverableLoadError(err: unknown): boolean {
		if (err instanceof SyntaxError) return true;
		if (err instanceof Error && err.name === "StateFormatError") return true;
		return (err as NodeJS.ErrnoException).code === "ENOENT";
	}

	private parseState(data: string): Map<string, FileState> {
		const parsed = JSON.parse(data) as unknown;
		if (!this.isObject(parsed)) {
			throw this.stateFormatError("State file root must be an object");
		}

		const next = new Map<string, FileState>();
		for (const [path, value] of Object.entries(parsed)) {
			if (!this.isObject(value)) {
				throw this.stateFormatError(`Invalid state object for path ${path}`);
			}
			if (
				typeof value.lastSyncedHash !== "string" ||
				typeof value.lastSyncedMtime !== "number" ||
				typeof value.lastManifestHash !== "string" ||
				typeof value.lastManifestWriterKey !== "string"
			) {
				throw this.stateFormatError(`Invalid state fields for path ${path}`);
			}

			next.set(path, {
				lastSyncedHash: value.lastSyncedHash,
				lastSyncedMtime: value.lastSyncedMtime,
				lastManifestHash: value.lastManifestHash,
				lastManifestWriterKey: value.lastManifestWriterKey,
			});
		}
		return next;
	}

	private isObject(value: unknown): value is Record<string, any> {
		return typeof value === "object" && value !== null;
	}

	private toObject(): Record<string, FileState> {
		const obj: Record<string, FileState> = {};
		for (const [k, v] of this.state) obj[k] = v;
		return obj;
	}

	private stateFormatError(message: string): Error {
		const err = new Error(message);
		err.name = "StateFormatError";
		return err;
	}
}
