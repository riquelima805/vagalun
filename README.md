⚠️ em manutençao. 04/08/2026 ⚠️

<<<
streaming de videos imprementado.

posibilidade de hospedagem de site estatico.

pagamento de banda usada para os nodes.

nova uix app de nodes.. 





>>>>>>> 1d76cef0f769e166e5fcffd28934156078583020

<div align="center">

<img src="./assets/logo.png" alt="Vagalun Logo" width="140"/>

# VAGALUN

### Decentralized, encrypted storage paid via Solana

<img alt="status" src="https://img.shields.io/badge/status-devnet-8A2BE2?style=for-the-badge&labelColor=0B0E13">
<img alt="platform" src="https://img.shields.io/badge/platform-Android-8A2BE2?style=for-the-badge&labelColor=0B0E13">
<img alt="blockchain" src="https://img.shields.io/badge/blockchain-Solana-8A2BE2?style=for-the-badge&logo=solana&labelColor=0B0E13">
<img alt="license" src="https://img.shields.io/badge/license-MIT-8A2BE2?style=for-the-badge&labelColor=0B0E13">

<br/>

<a href="./assets/vagalun.apk">
  <img alt="Download APK" src="https://img.shields.io/badge/⬇️_DOWNLOAD_APK-00FFA3?style=for-the-badge&labelColor=0B0E13&color=8A2BE2">
</a>

</div>

---

**What is Vagalun?**
**Vagalun** is a **decentralized** cloud storage Android app: instead of storing your files on a company's server, they are **fragmented, encrypted, and distributed across other users' phones on the network** — and you can also lend free space on your own device to store pieces of other people's files and get paid for it, in SOL, straight to your wallet.

Every user starts with **500 MB free** (the "free" tier), which can be expanded by purchasing extra space or by contributing storage to the network (free tier earned by providing a service).

---

## How it works under the hood

### 1. Reed-Solomon fragmentation

Before it leaves your device, each file is split into **shards** using Reed-Solomon encoding.

```
   original file
         │
   ┌─────┴─────┐
   │ Reed-Solomon (K=6, M=4) │
   └─────┬─────┘
         │
   10 shards total (N = K + M)
         │
 ┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐
 │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │ 7 │ 8 │ 9 │10 │  → 10 different nodes
 └───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
   6 data shards   +   4 parity shards
```

This means **any 6 of the 10 shards** are enough to reconstruct the entire file.

The network monitors this continuously: if the number of live copies of a file drops close to the `K` threshold, the protocol itself reconstructs the missing shard and automatically reallocates it to another healthy node, with no intervention from the file owner.

### 2. End-to-end encryption

- Your seed phrase generates, via SHA-256, a local **master key**.
- For each file, a **key derived via HMAC-SHA256** is generated from the master key + file ID.
- The content is encrypted with authenticated **AES-256-GCM**, with a random IV per file, **before** being split into shards.
- The nodes storing the shards only ever see encrypted bytes — never the actual content, the original filename, or the key.

### 3. P2P network (WebRTC + Gossip)

- **Metadata discovery and sync**: a *gossip* protocol — each node periodically exchanges its list of known peers and file metadata with a random sample of other nodes, until the information converges across the entire network.
- **Data transport**: direct **WebRTC** connections (DataChannel) between phones, using only **public STUN servers** (Google/Cloudflare) — with no dependency on a central server for file traffic.
- **Signaling**: a lightweight Node.js/WebSocket server (included in this repo) handles only the initial "introduction" between peers (offer/answer/ICE exchange) to open the direct WebRTC connection.
- **Relay fallback**: if two nodes can't establish a direct connection (restrictive NAT, no TURN), the signaling server itself relays shard requests as an alternative channel, so the file never becomes inaccessible.

### 4. Built-in Solana wallet

The app derives an **Ed25519** Solana wallet directly from your seed phrase (SLIP-0010 derivation, path `m/44'/501'/0'/0'`, compatible with the standard Solana wallet convention). You can check your balance, send SOL, and buy more space, all without leaving the app.

---

## Economic model — pay for usage, the node gets paid

Vagalun **charges no subscription**. The model is *pay-as-you-go*, all settled on-chain:

1. **When you store a paid file**, you deposit SOL into a **vault** exclusive to that file (`create_file_vault`), calculated as: `price per GB/day × N shards × storage days`.
2. That amount is **held in escrow in the vault itself** — it does not go to any team wallet.
3. Each epoch, the nodes that prove (via a Merkle proof) they still hold the shard intact **get paid directly from the vault** (`submit_paid_claim`) — **100% of the amount paid for the file goes to the nodes that actually store the shards**, proportional to how long they hold the data.
4. If the file owner deletes the file before the term ends, the unused vault balance is returned to them (`withdraw_unused`).
5. Those who don't want to pay can contribute free space on their own device to the network and earn extra free tier in exchange (`register_free_contribution` / `report_free_tier_proof`).

> Purchasing extra storage tiers is the only charge that goes to the project treasury — used to maintain the signaling server and protocol development. **All payment for file hosting itself goes to the nodes.**

---

## On-chain addresses

| Item | Address |
|---|---|
| Program ID (`storage_market` contract) | `FPpM2qXfpddkNxuUNqoF2UZg7MJiwF4Un96EWKhVecS6` |
| Treasury / admin wallet | `DDE7RZCCbipWuBGwZLYszBQuMxvDSEF59225YoFzkFba` |
| Network | Solana Devnet *(in testing — migration to Mainnet planned after audit)* |

---

## Installation

1. Download the APK.
2. Allow "install from unknown sources" on Android.
3. Open the app → create a new vault or restore an existing one.
4. Set your contributed space quota and, if you want full WAN connectivity, the signaling server address in **Settings → Network**.

> **Keep your seed phrase on paper, off your phone.** It is the only way to access your wallet and your files — Vagalun has no "password recovery."

## ⚠️ Notice

Project under **active development, running on Devnet**. Do not deposit real funds or store production data until the contract has been audited and the mainnet deployment is confirmed.
