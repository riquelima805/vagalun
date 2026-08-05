# Vagalun Gateway — CDN lite (passos 3 e 4)

Serviço HTTP separado do `sever/server.js` (que continua só fazendo signaling/relay
WebRTC). Este aqui fala **TCP direto** com os nós usando o mesmo protocolo binário do
`ShardServer.kt`/`ShardProtocol.kt`, reconstrói os blocos (Reed-Solomon + AES-256-GCM,
portados 1:1 de `ReedSolomon.kt`/`KeyManager.kt`) e serve tudo por HTTP normal, com
suporte a `Range`.

Implementa:
- **Passo 3** — gateway HTTP com `Range` → `206 Partial Content`, + site estático via
  manifesto de domínio assinado (Ed25519, mesma curva da wallet Solana do app).
- **Passo 4** — multi-source (dispara pros N nós do bloco, fica com os K mais rápidos)
  e cache LRU de blocos já decodificados.

**Não implementa passo 5** (cobrança por entrega / recibo assinado / claim on-chain) —
combinado, isso mexe no contrato Anchor e fica pra depois.

## Rodando

```bash
cd sever
npm run gateway            # sobe em :8788 (GATEWAY_PORT pra mudar)
npm run gateway:test       # self-test end-to-end (RS, AES-GCM, TCP, HTTP, range, assinatura)
```

Sem `GATEWAY_ADMIN_TOKEN` configurado, as rotas `/admin/*` ficam abertas (modo dev) —
o processo avisa isso no boot. Em produção, defina a env var e mande o header
`X-Admin-Token` nas chamadas admin.

## Por que o gateway precisa que alguém "publique" as coisas nele

O gateway roda fora do app Android — ele não participa do gossip P2P (isso seria um
próximo passo). Por enquanto, quem sobe um arquivo (ou o próprio nó) precisa **publicar**
no gateway:

1. Os **peers** que guardam os shards (`host`/`port` TCP alcançável pelo gateway — LAN
   ou port-forward; WebRTC/relay não são falados por esse gateway ainda).
2. O **manifesto do arquivo** (mesmo formato que `GossipRegistry.serializeFiles()` já
   produz: `fileId`, `k`, `m`, `n`, `blockSize`, `originalLength`, `blocks[]` com
   `placements`, `iv`, `authTag`).
3. Opcionalmente, a **chave do arquivo** (`fileKeyB64`) — **só se o dono quer que esse
   arquivo específico seja servido publicamente por HTTP**. Sem isso, o gateway até
   consegue reconstruir o ciphertext via Reed-Solomon, mas não decifra — o arquivo fica
   opaco pra ele por padrão (é assim que o gateway não vira um jeito de vazar arquivo
   privado: publicar a chave é decisão explícita de quem sobe, faz sentido pra conteúdo
   público como um site estático, não pra storage privado).

## Endpoints

### Conteúdo

```
GET/HEAD /raw/:fileId
GET/HEAD /*              (resolve por domínio via Host header + manifesto de site)
```

Ambos suportam `Range: bytes=X-Y`, `bytes=X-`, `bytes=-N` → `206 Partial Content` /
`416 Range Not Satisfiable`. `Accept-Ranges: bytes` sempre presente.

### Admin

```
POST /admin/peers   { "nodeId": "...", "host": "...", "port": 9000 }
POST /admin/files   <FileMeta — ver formato acima, + "fileKeyB64" opcional>
POST /admin/sites   { "domain": "...", "ownerPubkey": "<base58>", "signature": "<base64>",
                       "routes": [{ "path": "/", "fileId": "...", "contentType": "text/html; charset=utf-8" }] }
GET  /admin/status
```

`signature` é Ed25519 sobre o manifesto canônico:
`domain + "\n" + routes.sort(path).map(r => "${path}|${fileId}|${contentType}").join("\n")`
— assinado com a mesma keypair Ed25519 da wallet Solana do dono do domínio (TOFU: o
primeiro publish de um domínio grava o dono; publishes seguintes precisam da mesma chave).

## Limitações conhecidas (de propósito, não é descuido)

- **Transporte só TCP direto.** Nós só alcançáveis via WebRTC (NAT restritivo sem
  port-forward) não são visitados por este gateway ainda — precisaria portar
  `RelayTransport`/`WebRtcTransport` pro lado Node, que é bem mais peso (WebRTC nativo
  em Node) e ficou fora de escopo dos passos 3-4.
- **Granularidade de range é por bloco.** Pra servir um `Range`, o gateway sempre
  reconstrói o(s) bloco(s) inteiros que tocam o intervalo pedido e corta em memória —
  não faz decode parcial dentro de um shard. Isso já cobre 100% do ganho que os passos
  3/4 prometem (não baixa o arquivo inteiro, streaming funciona, multi-source funciona);
  decode sub-bloco é uma otimização fina que não estava no escopo pedido.
- **Sem cobrança nova** — exatamente como o roadmap definiu pro passo 3 ("sem cobrança
  nova ainda"). Isso é o passo 5, que fica pro contrato.
