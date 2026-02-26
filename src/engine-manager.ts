import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import Localdrive from "localdrive";
import type { StartupConflictPolicy } from "./api-types.js";
import {
  isConfigMetadata,
  isFileMetadata,
  isTombstone,
  ManifestStore,
} from "./lib/manifest-store.js";
import { SyncEngine } from "./lib/sync-engine.js";

export const startupConflictPolicies: StartupConflictPolicy[] = [
  "remote-wins",
  "local-wins",
  "keep-both",
];

export interface JoinPreviewCounts {
  localFiles: number;
  remoteFiles: number;
  remoteTombstones: number;
  matchingFiles: number;
  localOnlyFiles: number;
  remoteOnlyFiles: number;
  fileConflicts: number;
  tombstoneConflicts: number;
}

export interface JoinPreviewPolicyImpact {
  remoteWins: {
    overwrite: number;
    delete: number;
    totalAffected: number;
  };
  localWins: {
    upload: number;
    conflictCopy: number;
    totalAffected: number;
  };
  keepBoth: {
    conflictCopy: number;
    totalAffected: number;
  };
}

export interface JoinPreview {
  counts: JoinPreviewCounts;
  policyImpact: JoinPreviewPolicyImpact;
  samples: {
    fileConflicts: string[];
    tombstoneConflicts: string[];
    localOnly: string[];
    remoteOnly: string[];
  };
}

export interface PreparedJoinSession {
  folder: string;
  inviteCode: string;
  store: InstanceType<typeof Corestore>;
  manifest: ManifestStore;
  preview: JoinPreview;
}

interface ResolvedPolicyState {
  resolvedPolicy: StartupConflictPolicy | null;
  existingConfig: Awaited<ReturnType<ManifestStore["get"]>>;
  existingSettings: Record<string, unknown>;
}

export function resolveFolder(folder: string): string {
  if (folder.startsWith("~/") || folder === "~") {
    return join(homedir(), folder.slice(2));
  }
  return folder;
}

async function resolvePolicyState(
  manifest: ManifestStore,
  startupConflictPolicy?: StartupConflictPolicy,
): Promise<ResolvedPolicyState> {
  const existingConfig = await manifest.get("__config");
  const existingSettings =
    existingConfig && isConfigMetadata(existingConfig) ? (existingConfig.settings ?? {}) : {};

  let resolvedPolicy: StartupConflictPolicy | null = null;
  const persistedPolicy = existingSettings.startupConflictPolicy;
  if (
    typeof persistedPolicy === "string" &&
    startupConflictPolicies.includes(persistedPolicy as StartupConflictPolicy)
  ) {
    resolvedPolicy = persistedPolicy as StartupConflictPolicy;
  }
  if (startupConflictPolicy) {
    resolvedPolicy = startupConflictPolicy;
  }

  return {
    resolvedPolicy,
    existingConfig,
    existingSettings,
  };
}

async function persistConfig(
  manifest: ManifestStore,
  folder: string,
  policyState: ResolvedPolicyState,
): Promise<void> {
  await manifest.putConfig({
    ...(policyState.existingConfig && isConfigMetadata(policyState.existingConfig)
      ? { peerName: policyState.existingConfig.peerName }
      : {}),
    syncFolder: folder,
    settings:
      policyState.resolvedPolicy === null
        ? policyState.existingSettings
        : { ...policyState.existingSettings, startupConflictPolicy: policyState.resolvedPolicy },
  });
}

async function startEngineFromManifest(
  folder: string,
  store: InstanceType<typeof Corestore>,
  manifest: ManifestStore,
  startupConflictPolicy?: StartupConflictPolicy,
): Promise<{
  engine: SyncEngine;
  store: InstanceType<typeof Corestore>;
  startupConflictPolicy: StartupConflictPolicy | null;
}> {
  await manifest.ready();
  const policyState = await resolvePolicyState(manifest, startupConflictPolicy);
  await persistConfig(manifest, folder, policyState);

  const engine = new SyncEngine(store, folder, {
    manifest,
    startupConflictPolicy: policyState.resolvedPolicy ?? undefined,
  });
  await engine.ready();
  await engine.start();
  return { engine, store, startupConflictPolicy: policyState.resolvedPolicy };
}

export async function prepareJoinPreview(
  folder: string,
  inviteCode: string,
  bootstrap?: { host: string; port: number }[],
): Promise<PreparedJoinSession> {
  await mkdir(folder, { recursive: true });
  const storePath = join(folder, ".pearsync", "corestore");
  await mkdir(storePath, { recursive: true });
  const store = new Corestore(storePath);

  let manifest: ManifestStore | null = null;
  let drive: InstanceType<typeof Localdrive> | null = null;
  try {
    manifest = await ManifestStore.pair(store, inviteCode, { bootstrap });
    await manifest.ready();

    drive = new Localdrive(folder);
    const localHashes = new Map<string, string>();
    for await (const entry of drive.list("/")) {
      if (entry.key.startsWith("/.pearsync/")) continue;
      const data = await drive.get(entry.key);
      if (!data) continue;
      const hash = createHash("sha256").update(data).digest("hex");
      localHashes.set(entry.key, hash);
    }

    const localFiles = localHashes.size;
    let remoteFiles = 0;
    let remoteTombstones = 0;
    let matchingFiles = 0;
    let remoteOnlyFiles = 0;
    let fileConflicts = 0;
    let tombstoneConflicts = 0;

    const fileConflictPaths: string[] = [];
    const tombstoneConflictPaths: string[] = [];
    const remoteOnlyPaths: string[] = [];

    const entries = await manifest.list();
    const seenLocal = new Set<string>();
    for (const { path, metadata } of entries) {
      if (path.startsWith("__")) continue;
      if (isFileMetadata(metadata)) {
        remoteFiles += 1;
        const localHash = localHashes.get(path);
        if (localHash === undefined) {
          remoteOnlyFiles += 1;
          if (remoteOnlyPaths.length < 10) remoteOnlyPaths.push(path);
          continue;
        }
        seenLocal.add(path);
        if (localHash === metadata.hash) {
          matchingFiles += 1;
        } else {
          fileConflicts += 1;
          if (fileConflictPaths.length < 10) fileConflictPaths.push(path);
        }
        continue;
      }

      if (isTombstone(metadata)) {
        remoteTombstones += 1;
        if (localHashes.has(path)) {
          seenLocal.add(path);
          tombstoneConflicts += 1;
          if (tombstoneConflictPaths.length < 10) tombstoneConflictPaths.push(path);
        }
      }
    }

    const localOnlyPaths: string[] = [];
    for (const path of localHashes.keys()) {
      if (!seenLocal.has(path)) {
        if (localOnlyPaths.length < 10) localOnlyPaths.push(path);
      }
    }
    const localOnlyFiles = localHashes.size - seenLocal.size;
    const totalAffected = fileConflicts + tombstoneConflicts;

    const preview: JoinPreview = {
      counts: {
        localFiles,
        remoteFiles,
        remoteTombstones,
        matchingFiles,
        localOnlyFiles,
        remoteOnlyFiles,
        fileConflicts,
        tombstoneConflicts,
      },
      policyImpact: {
        remoteWins: {
          overwrite: fileConflicts,
          delete: tombstoneConflicts,
          totalAffected,
        },
        localWins: {
          upload: fileConflicts,
          conflictCopy: tombstoneConflicts,
          totalAffected,
        },
        keepBoth: {
          conflictCopy: totalAffected,
          totalAffected,
        },
      },
      samples: {
        fileConflicts: fileConflictPaths,
        tombstoneConflicts: tombstoneConflictPaths,
        localOnly: localOnlyPaths,
        remoteOnly: remoteOnlyPaths,
      },
    };

    return {
      folder,
      inviteCode,
      store,
      manifest,
      preview,
    };
  } catch (err) {
    if (drive) await drive.close();
    if (manifest) await manifest.close();
    await store.close();
    throw err;
  } finally {
    if (drive) await drive.close();
  }
}

export async function startEngineFromPreparedJoin(
  prepared: PreparedJoinSession,
  startupConflictPolicy?: StartupConflictPolicy,
): Promise<{
  engine: SyncEngine;
  store: InstanceType<typeof Corestore>;
  startupConflictPolicy: StartupConflictPolicy | null;
}> {
  return startEngineFromManifest(
    prepared.folder,
    prepared.store,
    prepared.manifest,
    startupConflictPolicy,
  );
}

export async function startEngine(
  folder: string,
  mode: "create" | "join",
  inviteCode: string | undefined,
  bootstrap?: { host: string; port: number }[],
  startupConflictPolicy?: StartupConflictPolicy,
): Promise<{
  engine: SyncEngine;
  store: InstanceType<typeof Corestore>;
  startupConflictPolicy: StartupConflictPolicy | null;
}> {
  await mkdir(folder, { recursive: true });
  const storePath = join(folder, ".pearsync", "corestore");
  await mkdir(storePath, { recursive: true });
  const store = new Corestore(storePath);

  let manifest: ManifestStore;
  if (mode === "join" && inviteCode) {
    manifest = await ManifestStore.pair(store, inviteCode, { bootstrap });
  } else {
    manifest = ManifestStore.create(store, { bootstrap });
  }

  return startEngineFromManifest(folder, store, manifest, startupConflictPolicy);
}
