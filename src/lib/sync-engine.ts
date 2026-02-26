import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { FSWatcher, PathLike, WatchListener, WatchOptions } from "node:fs";
import { createRequire } from "node:module";
import Localdrive from "localdrive";
import watch from "watch-drive";
import type Corestore from "corestore";
import { FileStore } from "./file-store";
import { LocalStateStore } from "./local-state-store";
import {
	type FileMetadata,
	type TombstoneMetadata,
	ManifestStore,
	isFileMetadata,
	isPeerMetadata,
	isTombstone,
} from "./manifest-store";

const require = createRequire(import.meta.url);
const mutableFs = require("node:fs") as typeof import("node:fs") & {
	__pearsyncWatchPatched?: boolean;
};

export interface SyncEvent {
	direction: "local-to-remote" | "remote-to-local";
	type: "update" | "delete" | "conflict";
	path: string;
	conflictPath?: string;
}

export interface SyncEngineOptions {
	bootstrap?: { host: string; port: number }[];
	manifest?: ManifestStore;
}

export function buildConflictPath(originalPath: string, peerName: string): string {
	const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
	const lastDot = originalPath.lastIndexOf(".");
	const lastSlash = originalPath.lastIndexOf("/");

	// Dot must be after the last slash to be a real extension
	if (lastDot > lastSlash + 1) {
		const stem = originalPath.slice(0, lastDot);
		const ext = originalPath.slice(lastDot);
		return `${stem}.conflict-${date}-${peerName}${ext}`;
	}
	return `${originalPath}.conflict-${date}-${peerName}`;
}

export class SyncEngine extends EventEmitter {
	private store: InstanceType<typeof Corestore>;
	private syncFolder: string;
	private drive: InstanceType<typeof Localdrive> | null = null;
	private fileStore: FileStore | null = null;
	private manifest: ManifestStore | null = null;
	private ownsManifest: boolean;
	private watcher: ReturnType<typeof watch> | null = null;
	private localChangeQueue: Promise<void> = Promise.resolve();
	private remoteUpdateQueue: Promise<void> = Promise.resolve();
	private options: SyncEngineOptions;
	private localState: LocalStateStore;

	/** Tracks which paths we're currently writing to disk, to suppress watcher feedback */
	private suppressedPaths: Set<string> = new Set();

	constructor(
		store: InstanceType<typeof Corestore>,
		syncFolder: string,
		options?: SyncEngineOptions,
	) {
		super();
		this.store = store;
		this.syncFolder = syncFolder;
		this.options = options ?? {};
		this.localState = new LocalStateStore(syncFolder);
		if (options?.manifest) {
			this.manifest = options.manifest;
			this.ownsManifest = false;
		} else {
			this.ownsManifest = true;
		}
	}

	async ready(): Promise<void> {
		this.drive = new Localdrive(this.syncFolder);

		this.fileStore = new FileStore(this.store);
		await this.fileStore.ready();

		await this.localState.load();

		if (!this.manifest) {
			this.manifest = ManifestStore.create(this.store, {
				replicate: this.options.bootstrap !== undefined,
				bootstrap: this.options.bootstrap,
			});
		}
		await this.manifest.ready();

		// Register peer name
		const writerKey = this.manifest.writerKey;
		const peerName = writerKey.slice(0, 8);
		await this.manifest.putPeer(writerKey, peerName);
	}

	async start(): Promise<void> {
		if (!this.drive || !this.fileStore || !this.manifest) {
			throw new Error("SyncEngine not ready — call ready() first");
		}

		await this.initialSync();

		this.ensureFsWatchPatched();
		this.watcher = watch(this.drive, "");
		this.applyLocalwatchDestroyWorkaround(this.watcher);
		this.watcher.on("data", (batch: { diff: { type: "update" | "delete"; key: string }[] }) => {
			for (const diff of batch.diff) {
				this.localChangeQueue = this.localChangeQueue.then(async () => {
					try {
						await this.handleLocalChange(diff.type, diff.key);
					} catch (err) {
						this.emit("error", err);
					}
				});
			}
		});
		this.watcher.on("error", (err) => this.emit("error", err));

		this.manifest.on("update", this._onRemoteUpdate);
	}

	private _onRemoteUpdate = () => {
		this.remoteUpdateQueue = this.remoteUpdateQueue.then(async () => {
			try {
				await this.handleRemoteChanges();
			} catch (err) {
				this.emit("error", err);
			}
		});
	};

	async stop(): Promise<void> {
		if (this.watcher) {
			this.watcher.destroy();
			this.watcher = null;
		}
		if (this.manifest) {
			this.manifest.removeListener("update", this._onRemoteUpdate);
		}
		await this.localChangeQueue;
		await this.remoteUpdateQueue;
	}

	async close(): Promise<void> {
		await this.stop();
		if (this.fileStore) {
			await this.fileStore.close();
			this.fileStore = null;
		}
		if (this.manifest && this.ownsManifest) {
			await this.manifest.close();
		}
		this.manifest = null;
		if (this.drive) {
			await this.drive.close();
			this.drive = null;
		}
	}

	async getPeerName(writerKey: string): Promise<string> {
		const entry = await this.manifest!.get(`__peer:${writerKey}`);
		if (entry && isPeerMetadata(entry)) return entry.name;
		return writerKey.slice(0, 8); // fallback
	}

	private async handleLocalChange(type: "update" | "delete", key: string): Promise<void> {
		if (key.startsWith("/.pearsync/")) return;
		if (this.suppressedPaths.has(key)) {
			this.suppressedPaths.delete(key);
			return;
		}

		const drive = this.drive!;
		const fileStore = this.fileStore!;
		const manifest = this.manifest!;

		if (type === "update") {
			const data = await drive.get(key);
			if (data === null) return;

			const entry = await drive.entry(key);
			const mtime = entry?.mtime ?? Date.now();

			const hash = createHash("sha256").update(data).digest("hex");
			const manifestValue = await manifest.get(key);

			// Skip if manifest already has this exact hash (and it's not a tombstone)
			if (manifestValue && isFileMetadata(manifestValue) && manifestValue.hash === hash) return;

			const stored = await fileStore.writeFile(data);
			const baseHash = manifestValue
				? isFileMetadata(manifestValue)
					? manifestValue.hash
					: isTombstone(manifestValue)
						? manifestValue.baseHash
						: null
				: null;
			const seq =
				manifestValue && (isFileMetadata(manifestValue) || isTombstone(manifestValue))
					? manifestValue.seq + 1
					: 1;

			const metadata: FileMetadata = {
				kind: "file",
				size: stored.size,
				mtime,
				hash: stored.hash,
				baseHash,
				seq,
				writerKey: fileStore.core.key.toString("hex"),
				blocks: { offset: stored.offset, length: stored.length },
			};
			await manifest.put(key, metadata);

			// Update local state tracker
			await this.localState.set(key, {
				lastSyncedHash: hash,
				lastSyncedMtime: mtime,
				lastManifestHash: hash,
				lastManifestWriterKey: metadata.writerKey,
			});

			this.emit("sync", {
				direction: "local-to-remote",
				type: "update",
				path: key,
			} satisfies SyncEvent);
		} else if (type === "delete") {
			const manifestValue = await manifest.get(key);
			if (manifestValue && isFileMetadata(manifestValue)) {
				// Write tombstone instead of remove()
				await manifest.putTombstone(key, fileStore.core.key.toString("hex"), {
					baseHash: manifestValue.hash,
					seq: manifestValue.seq + 1,
				});
				await this.localState.remove(key);
				this.emit("sync", {
					direction: "local-to-remote",
					type: "delete",
					path: key,
				} satisfies SyncEvent);
			}
		}
	}

	private async handleRemoteChanges(): Promise<void> {
		const entries = await this.manifest!.list();
		const myWriterKey = this.fileStore!.core.key.toString("hex");

		for (const { path, metadata } of entries) {
			if (path.startsWith("__")) continue;

			if (isTombstone(metadata)) {
				await this.handleRemoteDeletion(path, metadata);
				continue;
			}
			if (!isFileMetadata(metadata)) continue;

			// Skip our own writes
			if (metadata.writerKey === myWriterKey) continue;

			await this.handleRemoteUpdate(path, metadata);
		}
	}

	private async handleRemoteUpdate(path: string, remote: FileMetadata): Promise<void> {
		const tracked = this.localState.get(path);
		const localData = await this.drive!.get(path);

		// Case 1: File doesn't exist locally → just download
		if (!localData) {
			await this.downloadFile(path, remote);
			this.emit("sync", {
				direction: "remote-to-local",
				type: "update",
				path,
			} satisfies SyncEvent);
			return;
		}

		const localHash = createHash("sha256").update(localData).digest("hex");

		// Case 2: Local file matches remote → already in sync
		if (localHash === remote.hash) {
			await this.localState.set(path, {
				lastSyncedHash: localHash,
				lastSyncedMtime: remote.mtime,
				lastManifestHash: remote.hash,
				lastManifestWriterKey: remote.writerKey,
			});
			return;
		}

		// Case 3: No tracking state → first sync, treat remote as authoritative
		if (!tracked) {
			await this.downloadFile(path, remote);
			this.emit("sync", {
				direction: "remote-to-local",
				type: "update",
				path,
			} satisfies SyncEvent);
			return;
		}

		const remoteChanged = remote.hash !== tracked.lastManifestHash;
		if (!remoteChanged) return;

		const localChanged = localHash !== tracked.lastSyncedHash;
		if (!localChanged) {
			await this.downloadFile(path, remote);
			this.emit("sync", {
				direction: "remote-to-local",
				type: "update",
				path,
			} satisfies SyncEvent);
			return;
		}

		// If remote is based directly on our local content, this is a fast-forward.
		if (remote.baseHash !== null && remote.baseHash === localHash) {
			await this.downloadFile(path, remote);
			this.emit("sync", {
				direction: "remote-to-local",
				type: "update",
				path,
			} satisfies SyncEvent);
			return;
		}

		// Divergence: both sides changed from different bases.
		await this.handleConflict(path, remote, localData);
	}

	private async handleConflict(
		path: string,
		remote: FileMetadata,
		localData: Buffer,
	): Promise<void> {
		// Manifest winner is authoritative for the canonical path.
		const loserWriterKey = this.fileStore!.core.key.toString("hex");
		const peerName = await this.getPeerName(loserWriterKey);
		const conflictPath = buildConflictPath(path, peerName);

		// Save local version as conflict copy.
		this.suppressedPaths.add(conflictPath);
		await this.drive!.put(conflictPath, localData);

		// Apply manifest winner at canonical path.
		await this.downloadFile(path, remote);

		this.emit("sync", {
			direction: "remote-to-local",
			type: "conflict",
			path,
			conflictPath,
		} satisfies SyncEvent);
	}

	private async handleRemoteDeletion(path: string, tombstone: TombstoneMetadata): Promise<void> {
		const myWriterKey = this.fileStore!.core.key.toString("hex");

		// Don't process our own tombstones
		if (tombstone.writerKey === myWriterKey) return;

		const tracked = this.localState.get(path);

		// If we have no record of this file, it's either already gone or never existed locally
		if (!tracked) return;
		if (tombstone.baseHash !== tracked.lastSyncedHash) return;

		// Check if local file was modified since last sync
		const localData = await this.drive!.get(path);
		if (localData) {
			const localHash = createHash("sha256").update(localData).digest("hex");
			if (localHash !== tracked.lastSyncedHash) {
				// Local was modified — edit wins over delete
				return;
			}
		}

		// Safe to delete: local file is unmodified since last sync
		if (localData) {
			this.suppressedPaths.add(path);
			await this.drive!.del(path);
		}
		await this.localState.remove(path);

		this.emit("sync", {
			direction: "remote-to-local",
			type: "delete",
			path,
		} satisfies SyncEvent);
	}

	private async downloadFile(path: string, metadata: FileMetadata): Promise<void> {
		const data = await this.fetchRemoteFile(metadata);

		this.suppressedPaths.add(path);
		await this.drive!.put(path, data);

		const hash = createHash("sha256").update(data).digest("hex");
		await this.localState.set(path, {
			lastSyncedHash: hash,
			lastSyncedMtime: metadata.mtime,
			lastManifestHash: metadata.hash,
			lastManifestWriterKey: metadata.writerKey,
		});
	}

	private async fetchRemoteFile(metadata: FileMetadata): Promise<Buffer> {
		const remoteCore = this.store.get({ key: Buffer.from(metadata.writerKey, "hex") });
		try {
			await remoteCore.ready();

			const blocks: Buffer[] = [];
			for (let i = 0; i < metadata.blocks.length; i++) {
				const block = await remoteCore.get(metadata.blocks.offset + i);
				if (!block)
					throw new Error(
						`Missing block ${metadata.blocks.offset + i} from ${metadata.writerKey}`,
					);
				blocks.push(block);
			}
			return Buffer.concat(blocks);
		} finally {
			await remoteCore.close();
		}
	}

	private ensureFsWatchPatched(): void {
		if (mutableFs.__pearsyncWatchPatched) return;

		const originalWatch = mutableFs.watch.bind(mutableFs);
		const patchedWatch = ((
			filename: PathLike,
			optionsOrListener?: WatchOptions | WatchListener<string>,
			maybeListener?: WatchListener<string>,
		): FSWatcher => {
			let options: WatchOptions | undefined;
			let listener: WatchListener<string> | undefined;

			if (typeof optionsOrListener === "function") {
				listener = optionsOrListener;
			} else {
				options = optionsOrListener;
				listener = maybeListener;
			}

			const normalizedOptions = options?.recursive
				? { ...options, recursive: false }
				: options;
			const watcher = (listener
				? (originalWatch as any)(filename, normalizedOptions, listener)
				: (originalWatch as any)(filename, normalizedOptions)) as FSWatcher;

			// Node 25 can emit EMFILE from recursive watchers in long-running test workers.
			// localwatch does not attach an error listener, so this would otherwise crash.
			watcher.on("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EMFILE") return;
				throw err;
			});
			return watcher;
		}) as typeof mutableFs.watch;

		(mutableFs as any).watch = patchedWatch;
		mutableFs.__pearsyncWatchPatched = true;
	}

	private applyLocalwatchDestroyWorkaround(stream: unknown): void {
		// localwatch can throw on destroy() if the watched root never observed a visible entry.
		// Pre-initialize the root entries map to avoid that null-stat teardown path.
		const tree = (stream as { _tree?: { entries: Map<string, unknown> | null } })._tree;
		if (tree && tree.entries === null) {
			tree.entries = new Map();
		}
	}

	private async initialSync(): Promise<void> {
		const drive = this.drive!;
		const fileStore = this.fileStore!;
		const manifest = this.manifest!;

		// Reconcile remote state first so a restarting peer does not re-upload stale local files.
		await this.handleRemoteChanges();

		for await (const entry of drive.list("/")) {
			if (entry.key.startsWith("/.pearsync/")) continue;

			const data = await drive.get(entry.key);
			if (!data) continue;

			const hash = createHash("sha256").update(data).digest("hex");
			const existing = await manifest.get(entry.key);
			if (existing && isFileMetadata(existing) && existing.hash === hash) {
				// Already in sync — update local state tracker
				await this.localState.set(entry.key, {
					lastSyncedHash: hash,
					lastSyncedMtime: entry.mtime,
					lastManifestHash: existing.hash,
					lastManifestWriterKey: existing.writerKey,
				});
				continue;
			}

			const stored = await fileStore.writeFile(data);
			const metadata: FileMetadata = {
				kind: "file",
				size: stored.size,
				mtime: entry.mtime,
				hash: stored.hash,
				baseHash: existing
					? isFileMetadata(existing)
						? existing.hash
						: isTombstone(existing)
							? existing.baseHash
							: null
					: null,
				seq:
					existing && (isFileMetadata(existing) || isTombstone(existing))
						? existing.seq + 1
						: 1,
				writerKey: fileStore.core.key.toString("hex"),
				blocks: { offset: stored.offset, length: stored.length },
			};
			await manifest.put(entry.key, metadata);

			await this.localState.set(entry.key, {
				lastSyncedHash: hash,
				lastSyncedMtime: entry.mtime,
				lastManifestHash: hash,
				lastManifestWriterKey: metadata.writerKey,
			});

			this.emit("sync", {
				direction: "local-to-remote",
				type: "update",
				path: entry.key,
			} satisfies SyncEvent);
		}
	}

	getManifest(): ManifestStore {
		if (!this.manifest) throw new Error("SyncEngine not ready");
		return this.manifest;
	}

	getFileStore(): FileStore {
		if (!this.fileStore) throw new Error("SyncEngine not ready");
		return this.fileStore;
	}
}
