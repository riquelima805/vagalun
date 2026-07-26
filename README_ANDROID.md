# Armazenamento Descentralizado — Android/Kotlin (conversão do protótipo Node.js)

Isso é a base real do app Android, portando o protótipo Node (`storageNode.js`,
`gf256.js`, `reedSolomon.js`, `keyManager.js`, `coordinator.js`, `client.js`) pra
Kotlin, trocando o coordenador central por descoberta+gossip P2P, e adicionando
wallet Solana real via **sol4k**.

## O que É real e funcional aqui

| Peça | Onde | Status |
|---|---|---|
| Cripto (seed phrase, AES-256-GCM) | `crypto/KeyManager.kt` | Port fiel do JS |
| Reed-Solomon (GF256) | `erasure/GF256.kt`, `erasure/ReedSolomon.kt` | Port fiel, mesmo algoritmo byte a byte |
| Servidor de shards (quem empresta espaço) | `network/ShardServer.kt` + `ShardProtocol.kt` | Socket TCP puro, sem Express/HTTP |
| Descoberta de peers na rede local | `network/PeerDiscovery.kt` | NSD/mDNS nativo do Android, sem servidor |
| "Coordenador" descentralizado | `network/GossipRegistry.kt` | Cada peer roda a própria cópia; troca metadados por gossip |
| Re-replicação automática | dentro do `GossipRegistry` | Mesma lógica do `coordinator.js`, rodando localmente em cada peer |
| Wallet Solana real | `wallet/SolanaWallet.kt` + `Slip10.kt` | sol4k + derivação SLIP-0010 igual Phantom/Solflare, MESMA seed do storage |
| Orquestração de upload/download | `StorageClient.kt` | Port do `client.js` |
| UI mínima pra testar tudo isso num aparelho | `MainActivity.kt` | Compose simples, não é a UI final do produto |
| Smart contract (tiers, pagamento, recompensa) | `contract/programs/storage_market/src/lib.rs` | Esqueleto Anchor — **não compilado, não deployado, não auditado** |

## O que NÃO dá pra fingir que está resolvido (limitações reais, não "detalhes")

1. **P2P pela internet (WAN), não só na rede local.** `PeerDiscovery` (NSD) só
   funciona na mesma Wi-Fi. Pra dois celulares em redes diferentes se acharem e
   trocarem dados, é preciso NAT traversal (STUN, com TURN de fallback) — isso
   não está implementado, é a próxima peça de infra real a construir.
   `BootstrapPeerList.kt` mostra a estratégia (lista de rendezvous, não um
   servidor que guarda dados), mas o transporte propriamente dito pela internet
   ainda falta.
2. **Consistência do gossip é "eventual".** Dois peers podem discordar por um
   tempo sobre quem tem o quê até o próximo ciclo convergir. Pra um MVP tá OK;
   produção séria evolui isso pra CRDT ou uma DHT real (Kademlia).
3. **Smart contract não foi compilado nem testado** — não há toolchain
   Solana/Anchor disponível neste ambiente de execução. O código segue a
   sintaxe Anchor corretamente pelo que sei, mas precisa passar por
   `anchor build`/`anchor test` num ambiente com o toolchain instalado antes de
   qualquer deploy, e por auditoria de segurança antes de mainnet com dinheiro real.
4. **Prova de posse (challenge) continua simplificada**, mesma ressalva do
   protótipo Node: hash(shard + nonce) não impede um peer malicioso sofisticado.
   Produção precisaria de algo tipo Proof-of-Replication/PoSt.
5. **Versões de dependência não foram compiladas aqui** (sem SDK Android/Gradle
   neste sandbox). `sol4k`, `io.github.novacrypto:BIP39` e `net.i2p.crypto:eddsa`
   são bibliotecas reais e existentes — mas ao abrir no Android Studio, confira
   se a versão mais recente de cada uma mudou algum nome de método (esses
   detalhes de API mudam entre releases).
6. **Persistência local**: hoje peers/arquivos conhecidos ficam só em memória
   (`GossipRegistry`). Precisa persistir em disco (Room/SQLite) pra sobreviver
   a reinício do app.

## Como abrir

1. Abra a pasta `android/` no Android Studio (Iguana ou mais novo).
2. Deixe o Gradle sincronizar (vai baixar sol4k, BIP39, eddsa do Maven Central).
3. Rode em 2+ dispositivos/emuladores na MESMA rede Wi-Fi (ou emuladores com
   rede em bridge) pra testar descoberta de peers + upload/download de verdade.
4. Toque "Gerar nova seed" → "Usar essa seed" → "Entrar na rede (LAN)" →
   "Escolher e enviar arquivo" → "Baixar de volta".

## Próximos passos sugeridos, em ordem de impacto

1. NAT traversal / P2P real pela internet (a peça mais difícil e mais importante)
2. Persistência local (Room) do que hoje só vive em memória
3. Compilar, testar e auditar o contrato Anchor antes de qualquer devnet real com valor
4. Trocar o challenge simplificado por algo mais robusto
5. UI de produto de verdade (a tela atual é só de teste)
