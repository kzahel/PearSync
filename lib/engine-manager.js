import { createHash } from "bare-crypto";
import { mkdir } from "bare-fs/promises";
import { homedir } from "bare-os";
import { join } from "bare-path";
import Corestore from "corestore";
import Localdrive from "localdrive";
import {
  isConfigMetadata,
  isFileMetadata,
  isTombstone,
  ManifestStore
} from "./manifest-store.js";
import { SyncEngine } from "./sync-engine.js";
const startupConflictPolicies = [
  "remote-wins",
  "local-wins",
  "keep-both"
];
function resolveFolder(folder) {
  if (folder.startsWith("~/") || folder === "~") {
    return join(homedir(), folder.slice(2));
  }
  return folder;
}
async function resolvePolicyState(manifest, startupConflictPolicy) {
  const existingConfig = await manifest.get("__config");
  const existingSettings = existingConfig && isConfigMetadata(existingConfig) ? existingConfig.settings ?? {} : {};
  let resolvedPolicy = null;
  const persistedPolicy = existingSettings.startupConflictPolicy;
  if (typeof persistedPolicy === "string" && startupConflictPolicies.includes(persistedPolicy)) {
    resolvedPolicy = persistedPolicy;
  }
  if (startupConflictPolicy) {
    resolvedPolicy = startupConflictPolicy;
  }
  return {
    resolvedPolicy,
    existingConfig,
    existingSettings
  };
}
async function persistConfig(manifest, folder, policyState) {
  await manifest.putConfig({
    ...policyState.existingConfig && isConfigMetadata(policyState.existingConfig) ? { peerName: policyState.existingConfig.peerName } : {},
    syncFolder: folder,
    settings: policyState.resolvedPolicy === null ? policyState.existingSettings : { ...policyState.existingSettings, startupConflictPolicy: policyState.resolvedPolicy }
  });
}
async function startEngineFromManifest(folder, store, manifest, startupConflictPolicy) {
  await manifest.ready();
  const policyState = await resolvePolicyState(manifest, startupConflictPolicy);
  await persistConfig(manifest, folder, policyState);
  const engine = new SyncEngine(store, folder, {
    manifest,
    startupConflictPolicy: policyState.resolvedPolicy ?? void 0
  });
  await engine.ready();
  await engine.start();
  return { engine, store, startupConflictPolicy: policyState.resolvedPolicy };
}
async function prepareJoinPreview(folder, inviteCode, bootstrap) {
  await mkdir(folder, { recursive: true });
  const storePath = join(folder, ".pearsync", "corestore");
  await mkdir(storePath, { recursive: true });
  const store = new Corestore(storePath);
  let manifest = null;
  let drive = null;
  try {
    manifest = await ManifestStore.pair(store, inviteCode, { bootstrap });
    await manifest.ready();
    drive = new Localdrive(folder);
    const localHashes = /* @__PURE__ */ new Map();
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
    const fileConflictPaths = [];
    const tombstoneConflictPaths = [];
    const remoteOnlyPaths = [];
    const entries = await manifest.list();
    const seenLocal = /* @__PURE__ */ new Set();
    for (const { path, metadata } of entries) {
      if (path.startsWith("__")) continue;
      if (isFileMetadata(metadata)) {
        remoteFiles += 1;
        const localHash = localHashes.get(path);
        if (localHash === void 0) {
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
    const localOnlyPaths = [];
    for (const path of localHashes.keys()) {
      if (!seenLocal.has(path)) {
        if (localOnlyPaths.length < 10) localOnlyPaths.push(path);
      }
    }
    const localOnlyFiles = localHashes.size - seenLocal.size;
    const totalAffected = fileConflicts + tombstoneConflicts;
    const preview = {
      counts: {
        localFiles,
        remoteFiles,
        remoteTombstones,
        matchingFiles,
        localOnlyFiles,
        remoteOnlyFiles,
        fileConflicts,
        tombstoneConflicts
      },
      policyImpact: {
        remoteWins: {
          overwrite: fileConflicts,
          delete: tombstoneConflicts,
          totalAffected
        },
        localWins: {
          upload: fileConflicts,
          conflictCopy: tombstoneConflicts,
          totalAffected
        },
        keepBoth: {
          conflictCopy: totalAffected,
          totalAffected
        }
      },
      samples: {
        fileConflicts: fileConflictPaths,
        tombstoneConflicts: tombstoneConflictPaths,
        localOnly: localOnlyPaths,
        remoteOnly: remoteOnlyPaths
      }
    };
    return {
      folder,
      inviteCode,
      store,
      manifest,
      preview
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
async function startEngineFromPreparedJoin(prepared, startupConflictPolicy) {
  return startEngineFromManifest(
    prepared.folder,
    prepared.store,
    prepared.manifest,
    startupConflictPolicy
  );
}
async function startEngine(folder, mode, inviteCode, bootstrap, startupConflictPolicy) {
  await mkdir(folder, { recursive: true });
  const storePath = join(folder, ".pearsync", "corestore");
  await mkdir(storePath, { recursive: true });
  const store = new Corestore(storePath);
  let manifest;
  if (mode === "join" && inviteCode) {
    manifest = await ManifestStore.pair(store, inviteCode, { bootstrap });
  } else {
    manifest = ManifestStore.create(store, { bootstrap });
  }
  return startEngineFromManifest(folder, store, manifest, startupConflictPolicy);
}
export {
  prepareJoinPreview,
  resolveFolder,
  startEngine,
  startEngineFromPreparedJoin,
  startupConflictPolicies
};
//# sourceMappingURL=engine-manager.js.map
