import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import Localdrive from "localdrive";
import watch from "watch-drive";
import type Corestore from "corestore";
import { FileStore } from "./file-store";
import { type FileMetadata, ManifestStore } from "./manifest-store";

export interface SyncEvent {
	direction: "local-to-remote" | "remote-to-local";
	type: "update" | "delete";
	path: string;
}

export interface SyncEngineOptions {
	bootstrap?: { host: string; port: number }[];
	manifest?: ManifestStore;
}

export class SyncEngine extends EventEmitter {
	private store: InstanceType<typeof Corestore>;
	private syncFolder: string;
	private drive: InstanceType<typeof Localdrive> | null = null;
	private fileStore: FileStore | null = null;
	private manifest: ManifestStore | null = null;
	private ownsManifest: boolean;
	private watcher: ReturnType<typeof watch> | null = null;
	private options: SyncEngineOptions;

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

		if (!this.manifest) {
			this.manifest = ManifestStore.create(this.store, {
				bootstrap: this.options.bootstrap,
			});
		}
		await this.manifest.ready();
	}

	async start(): Promise<void> {
		if (!this.drive || !this.fileStore || !this.manifest) {
			throw new Error("SyncEngine not ready — call ready() first");
		}

		this.watcher = watch(this.drive, "/");
		this.watcher.on("data", (batch: { diff: { type: "update" | "delete"; key: string }[] }) => {
			for (const diff of batch.diff) {
				this.handleLocalChange(diff.type, diff.key).catch((err) =>
					this.emit("error", err),
				);
			}
		});

		this.manifest.on("update", this._onRemoteUpdate);

		await this.initialSync();
	}

	private _onRemoteUpdate = () => {
		this.handleRemoteChanges().catch((err) => this.emit("error", err));
	};

	async stop(): Promise<void> {
		if (this.watcher) {
			this.watcher.destroy();
			this.watcher = null;
		}
		if (this.manifest) {
			this.manifest.removeListener("update", this._onRemoteUpdate);
		}
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

	private async handleLocalChange(type: "update" | "delete", key: string): Promise<void> {
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
			const existing = await manifest.get(key);
			if (existing && existing.hash === hash) return;

			const stored = await fileStore.writeFile(data);

			const metadata: FileMetadata = {
				size: stored.size,
				mtime,
				hash: stored.hash,
				writerKey: fileStore.core.key.toString("hex"),
				blocks: { offset: stored.offset, length: stored.length },
			};
			await manifest.put(key, metadata);

			this.emit("sync", {
				direction: "local-to-remote",
				type: "update",
				path: key,
			} satisfies SyncEvent);
		} else if (type === "delete") {
			const existing = await manifest.get(key);
			if (existing) {
				await manifest.remove(key);
				this.emit("sync", {
					direction: "local-to-remote",
					type: "delete",
					path: key,
				} satisfies SyncEvent);
			}
		}
	}

	private async handleRemoteChanges(): Promise<void> {
		const manifest = this.manifest!;
		const fileStore = this.fileStore!;
		const drive = this.drive!;

		const entries = await manifest.list();

		for (const { path, metadata } of entries) {
			if (metadata.writerKey === fileStore.core.key.toString("hex")) continue;

			const localEntry = await drive.entry(path);
			if (localEntry) {
				const localData = await drive.get(path);
				if (localData) {
					const localHash = createHash("sha256").update(localData).digest("hex");
					if (localHash === metadata.hash) continue;
				}
			}

			const remoteCore = this.store.get({ key: Buffer.from(metadata.writerKey, "hex") });
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
			const fileData = Buffer.concat(blocks);

			this.suppressedPaths.add(path);
			await drive.put(path, fileData);

			this.emit("sync", {
				direction: "remote-to-local",
				type: "update",
				path,
			} satisfies SyncEvent);
		}
	}

	private async initialSync(): Promise<void> {
		const drive = this.drive!;
		const fileStore = this.fileStore!;
		const manifest = this.manifest!;

		for await (const entry of drive.list("/")) {
			const data = await drive.get(entry.key);
			if (!data) continue;

			const hash = createHash("sha256").update(data).digest("hex");
			const existing = await manifest.get(entry.key);
			if (existing && existing.hash === hash) continue;

			const stored = await fileStore.writeFile(data);
			const metadata: FileMetadata = {
				size: stored.size,
				mtime: entry.mtime,
				hash: stored.hash,
				writerKey: fileStore.core.key.toString("hex"),
				blocks: { offset: stored.offset, length: stored.length },
			};
			await manifest.put(entry.key, metadata);

			this.emit("sync", {
				direction: "local-to-remote",
				type: "update",
				path: entry.key,
			} satisfies SyncEvent);
		}

		await this.handleRemoteChanges();
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
