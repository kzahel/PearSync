# Authentication & Consensus Model

## Overview

PearSync has no accounts, passwords, or servers. Identity is a cryptographic keypair stored locally. Authorization is managed by a replicated membership set. Peers discover each other and communicate over an encrypted P2P network.

This document explains how peers authenticate, authorize, and trust each other.

## Key Concepts

### Identity = Hypercore Keypair

Each peer generates a unique Ed25519 keypair when they first create or join a vault. This keypair lives in the local Corestore (RocksDB) and persists across restarts. The public key is the peer's identity — there are no usernames or emails.

```
Peer A:  keypair-A  →  public key = A's identity
Peer B:  keypair-B  →  public key = B's identity
```

### No Central Authority

There is no root key, no master server, no certificate authority. Instead, authorization is maintained by a **replicated membership set** — a list of allowed writer keys that all peers agree on via deterministic consensus.

## The Two Layers

PearSync separates data into two layers with different write models:

### Layer 1: File Data (Single-Writer Hypercores)

Each peer has their own Hypercore for file content. Only the owning peer can append to their core — enforced cryptographically by the Ed25519 signature on every block.

```
Peer A's core:  [chunk1][chunk2][chunk3]...   ← only A can write
Peer B's core:  [chunk1][chunk2]...           ← only B can write
Peer C's core:  [chunk1]...                   ← only C can write
```

Other peers get read-only replicas. No multi-writer complexity here.

### Layer 2: Manifest (Multi-Writer via Autobase)

The file metadata manifest needs multi-writer support — any peer should be able to register that they've added or modified a file. This is handled by **Autobase**, which sits underneath Autopass.

```
A's local core:  [put /foo.txt] ───────┐
B's local core:  [put /bar.txt] ────────┼──→  Autobase  ──→  HyperDB view
C's local core:  [del /old.txt] ───────┘     (linearizer)   (queryable index)
```

Each peer appends commands to their own single-writer core. Autobase deterministically linearizes all writers' cores into a single ordered log. A materialized HyperDB view is built from this log, providing the `get`/`list`/`find` query interface.

All peers run the same linearization algorithm on the same inputs, so they converge on the same view — eventual consistency.

## Pairing: The "Sign In" Moment

Pairing is the one-time process that establishes trust between two peers. It replaces account creation and login.

### Flow

```
1. Device A creates a vault
   └─ A is the first writer (bootstraps the system)

2. A generates an invite code
   └─ await pass.createInvite()  →  "4xk7y...qz9m"  (z32-encoded, ~106 chars)
   └─ Encodes: discovery key + pairing secret

3. Invite is shared out-of-band
   └─ QR code, copy-paste, verbal, etc.
   └─ This is the ONLY secret exchange needed

4. Device B uses the invite to pair
   └─ Autopass.pair(store, inviteCode)
   └─ B joins the DHT swarm for the encoded discovery key
   └─ BlindPairing handshake: neither side knows the other's identity in advance

5. Key exchange during handshake
   └─ A sends B: vault encryption key + Autobase key
   └─ B sends A: B's local writer key

6. A authorizes B
   └─ A appends "add-writer B.key" to the Autobase system log
   └─ This command replicates to all peers

7. Invite is consumed and deleted
   └─ One-time use — cannot be reused

8. From now on: automatic
   └─ Both devices discover each other on the DHT via shared discovery key
   └─ No invite needed on subsequent launches
```

### Read-Only Pairing

```javascript
await pass.createInvite({ readOnly: true })
```

The peer is paired but NOT added as a writer. They can read and replicate all data but cannot modify the manifest.

## Membership Management

### Adding Peers (N-peer scaling)

Any existing writer can invite new peers:

```
A creates vault                        →  members: [A]
A invites B                            →  members: [A, B]
B invites C  (B is a writer, so can)   →  members: [A, B, C]
A invites D                            →  members: [A, B, C, D]
```

There is no hierarchy. The creator has no special ongoing authority — they simply happened to be first. All writers have equal permissions.

### Removing Peers

Any writer can remove any other writer:

```javascript
await pass.removeWriter(peerKey)
```

This appends a `remove-writer` command to the Autobase system log. Once replicated and linearized, all peers agree the removed peer is no longer authorized.

The removed peer's existing data remains in the log (append-only), but they can no longer append new commands that will be accepted.

### Membership Consensus

The membership set is not stored in a single location — it's derived from the linearized Autobase system log. The process:

1. Each `add-writer` and `remove-writer` command is appended to a peer's local core
2. All cores are replicated to all peers
3. Autobase's deterministic linearization orders all commands
4. Every peer processes the same ordered commands → same membership set

This means there's no "split brain" on membership — all peers converge on the same set of authorized writers, even if they receive commands in different orders.

## Encryption

### At Rest

The Autobase vault is encrypted with a symmetric key (XSalsa20). This key is:
- Generated automatically when the vault is created
- Shared with new peers during the pairing handshake
- Stored in each peer's local Corestore (`getUserData('autobase/encryption')`)

### In Transit

All peer-to-peer connections go through Hyperswarm, which provides:
- **Noise protocol** handshake (authenticated key exchange)
- **End-to-end encryption** on every connection
- **NAT holepunching** for direct peer-to-peer paths
- **Relay fallback** through blind relays when direct connection fails (relays cannot read the data)

### Optional Password Protection

```javascript
const pass = new Autopass(store, {
  blindEncryption: new BlindEncryptionSodium(password)
})
```

Adds an additional encryption layer using a shared password. The vault encryption key is itself encrypted with the password. Peers must know the password to decrypt — even if they obtain the encryption key buffer, it's useless without the password.

## How File Sync Uses This

When Peer A syncs a file:

```
1. A chunks the file into A's Hypercore           →  core-A blocks [5..8]
2. A puts a manifest entry via Autopass            →  add("/readme.txt", {
                                                         writerKey: A.keyHex,
                                                         blocks: { offset: 5, length: 4 },
                                                         hash: "abc123...",
                                                         size: 250000,
                                                         mtime: 1709000000000
                                                       })
3. Autobase replicates A's command to all peers
4. Peer B sees 'update' event, reads the manifest  →  get("/readme.txt")
5. B uses writerKey to open A's core               →  store.get({ key: A.key })
6. B reads blocks [5..8] from A's core             (already replicated via Corestore)
7. B reassembles and writes /readme.txt to disk
```

The `writerKey` in the manifest entry is how peers know which Hypercore to read from. It's the public key of the peer who wrote those bytes — verifiable, unforgeable.

## Replication Topology

All Hypercores (file data + Autobase cores) live in the same Corestore. Autopass creates a single Hyperswarm and calls `store.replicate(connection)` on every peer connection. This replicates everything — manifest, membership, and file data — over one set of connections.

```
Peer A ←──encrypted──→ Peer B
  ↑                       ↑
  └────encrypted──→ Peer C ┘

All connections replicate: manifest + all file cores
No separate swarm needed — piggyback on Autopass networking
```

## Trust Assumptions

| What | Trust model |
|------|------------|
| Peer identity | Ed25519 keypair — unforgeable |
| File integrity | Hypercore Merkle tree — tamper-evident |
| Membership | Autobase consensus — all peers agree |
| Invite security | One-time code shared out-of-band — security depends on the channel |
| Transport | Noise protocol — encrypted, authenticated |
| Storage | XSalsa20 encryption at rest |

## Threat Model Summary

- **Compromised invite code**: An attacker who intercepts the invite code before the intended peer uses it can join the vault. Mitigation: share invites over secure channels; invites are single-use.
- **Compromised device**: If a peer's device is compromised, the attacker has their keypair and can write to the vault. Mitigation: other peers can `removeWriter` to revoke access.
- **Network adversary**: Cannot read or modify traffic (Noise protocol encryption). Cannot determine vault contents from network observation (encrypted discovery keys).
- **Malicious peer**: A writer can append garbage to their core or spam the manifest. They cannot forge another peer's core (wrong signing key). They can be removed via `removeWriter`.
