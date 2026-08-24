<div align="center">

# Vagalun

### CDN livre de censura, hospedada em celulares, paga em Solana

![status](https://img.shields.io/badge/status-devnet%20%2F%20MVP-b30000?style=for-the-badge)
![android](https://img.shields.io/badge/Android-Kotlin-8b0000?style=for-the-badge)
![solana](https://img.shields.io/badge/Solana-Anchor-a30000?style=for-the-badge)
![node](https://img.shields.io/badge/Node.js-Gateway%20%2B%20Signaling-c1121f?style=for-the-badge)
![license](https://img.shields.io/badge/licença-%20MIT-660708?style=for-the-badge)

*"Cada celular ligado é um pedacinho da internet que ninguém consegue desligar."*

</div>

---

Web site: https://vagalun.shop

## Testes rapidos.

## Hospedagem: https://vagalun.shop/app/

## Site com video para teste de stream ( em nó de teste): http://13c13228-49b8-4283-bd9c-abaffb26a1bb.vagalun.shop/

# Mini game: https://9fd85d1f-784e-4756-8b9b-75fe97a1e55b.vagalun.shop/snake.html



---

## Sumário

1. [O que é o Vagalun](#o-que-é-o-vagalun)
2. [O problema](#o-problema)
3. [Visão geral da arquitetura](#visão-geral-da-arquitetura)
4. [Camada 1 — App Android (o nó)](#camada-1--app-android-o-nó)
5. [Camada 2 — Protocolo de shard e transporte](#camada-2--protocolo-de-shard-e-transporte)
6. [Camada 3 — Signaling & Relay Server](#camada-3--signaling--relay-server)
7. [Camada 4 — Gateway HTTP (CDN lite)](#camada-4--gateway-http-cdn-lite)
8. [Camada 5 — Publisher / gateway-client](#camada-5--publisher--gateway-client)
9. [Camada 6 — Plataforma de hospedagem (SaaS)](#camada-6--plataforma-de-hospedagem-saas)
10. [Camada 7 — Contrato Solana (`storage_market`)](#camada-7--contrato-solana-storage_market)
11. [Camada 8 — Nó semente (`vagalun-node.js`)](#camada-8--nó-semente-vagalun-nodejs)
12. [Sistema de pontos (proof-of-contribution)](#sistema-de-pontos-proof-of-contribution)
13. [Segurança e modelo de confiança](#segurança-e-modelo-de-confiança)
14. [Fluxo ponta a ponta: publicar um site com vídeo](#fluxo-ponta-a-ponta-publicar-um-site-com-vídeo)
15. [Stack tecnológica](#stack-tecnológica)
16. [Estrutura de pastas](#estrutura-de-pastas)
17. [Como rodar localmente](#como-rodar-localmente)

---

## O que é o Vagalun

Vagalun é uma **CDN leve e hospedagem estática descentralizada**: sites, apps web, jogos e vídeos são fatiados, cifrados e distribuídos entre **celulares Android comuns** rodando o app da rede, em vez de ficarem em um único servidor de uma única empresa. Um **gateway HTTP** público reconstrói o conteúdo sob demanda e serve qualquer visitante — inclusive navegadores comuns, sem plugin nenhum — enquanto quem realmente guarda os bytes são os nós da rede (celulares e, hoje em fase inicial, alguns "nós semente" em VPS).

A camada econômica roda em **Solana**: um contrato Anchor (`storage_market`) paga quem hospeda por prova real de armazenamento, e a plataforma de hospedagem aceita pagamento via **Solana Pay** para planos pagos.

Em uma frase: **é uma tentativa de reconstruir o que uma CDN faz (Cloudflare, S3+CloudFront etc.), só que sem nenhum ponto único que possa ser desligado, multado ou pressionado a tirar um site do ar — porque não existe "o servidor", existe uma rede.**

## O problema

Hospedagem de site, joguinho ou vídeo hoje depende de:

- **Um dono**: a nuvem, o registrador de domínio, o provedor de hospedagem — qualquer um deles pode tirar o conteúdo do ar por decisão unilateral, ordem judicial de um único país, ou simplesmente falência da empresa.
- **Um custo alto de banda**: streaming de vídeo em especial é caro justamente porque uma empresa central paga a banda de tudo.
- **Um ponto de censura**: bloquear acesso a um conteúdo é, na prática, bloquear um IP ou um domínio — que aponta pra um único lugar.

O Vagalun ataca os três ao mesmo tempo: **sem dono único** (a rede é formada por qualquer celular que instale o app), **banda distribuída** (quem serve o vídeo pro visitante, quando possível, é o próprio celular via WebRTC — não a VPS do gateway) e **sem alvo único de censura** (derrubar o gateway não apaga o conteúdo, que continua nos nós; um novo gateway consegue voltar a servi-lo).

## Visão geral da arquitetura

```
┌──────────────┐        ┌────────────────────┐        ┌──────────────────┐
│  Visitante    │  HTTP  │   GATEWAY (VPS)     │  TCP/  │  Celulares       │
│  (navegador)  │◄──────►│  sever/gateway/     │  WebRTC│  App Android     │
│               │        │  gateway.js         │◄──────►│  (nós de shard)  │
└──────┬───────┘        └────────┬───────────┘        └────────┬─────────┘
       │  WebRTC direto (P2P,           │  admin API                │
       │  vídeo k=1 replicado)          │  (/admin/peers,           │
       └────────────────────────────────┤   /admin/files,           │
                                         │   /admin/sites)           │
                                         │                            │
                              ┌──────────▼───────────┐    WebSocket   │
                              │  SIGNALING/RELAY      │◄───────────────┘
                              │  sever/server.js      │  (registro, WebRTC
                              └──────────┬───────────┘   signal, relay p/
                                         │                celular atrás de NAT)
                                         │
                              ┌──────────▼───────────┐
                              │  PLATAFORMA (SaaS)    │
                              │  hosting/server.js    │  cadastro, editor de
                              │  + hosting/client/    │  arquivos, domínio,
                              │  (painel React)       │  billing, anúncios
                              └──────────┬───────────┘
                                         │  publica via
                              ┌──────────▼───────────┐
                              │  gateway-client/      │  Reed-Solomon +
                              │  publish.cjs          │  AES-256-GCM +
                              │  (encode/upload)      │  assinatura Ed25519
                              └───────────────────────┘

                        ┌───────────────────────────────┐
                        │  SOLANA — programa Anchor       │
                        │  storage_market (contract/)     │  cobrança por GB/dia,
                        │  + Solana Pay (billing do SaaS) │  pagamento a provedores,
                        └───────────────────────────────┘  free tier por prova
```

## Camada 1 — App Android (o nó)

`app/` — Kotlin, pacote `com.decentstorage.app`, nome de exibição **Vagalun**.

O app cumpre três papéis ao mesmo tempo:

- **Nó de armazenamento**: guarda "shards" (pedaços cifrados de arquivos) em disco e responde ao protocolo de shard (`put`/`get`/`get_range`/`delete`/`challenge`/`status`) tanto via **TCP direto** (LAN/rede local) quanto via **relay por WebSocket** quando está atrás de NAT/rede móvel (`ShardServer.kt`, `ShardRequestHandler.kt`, `SignalingClient.kt`).
- **Carteira Solana embutida**: a seed do usuário deriva uma carteira Ed25519 via **SLIP-10** (`wallet/Slip10.kt`, `wallet/SolanaWallet.kt`), sem depender de wallet externa instalada — a chave também assina mensagens fora da blockchain (prova de posse pro signaling, ver seção de segurança).
- **Cliente de upload/download**: fatia arquivos em blocos, cifra cada bloco com **AES-256-GCM**, aplica **codificação por apagamento Reed-Solomon** (`erasure/ReedSolomon.kt` + `erasure/GF256.kt`) e distribui os shards resultantes entre os peers conhecidos (`StorageClient.kt`).


Um `DailyClaimWorker.kt` (WorkManager, roda a cada 24h) percorre os shards guardados no aparelho e envia `submit_paid_claim` para o contrato Solana, reivindicando o pagamento por continuar hospedando.


## Camada 2 — Protocolo de shard e transporte

O formato de rede é o mesmo em **três implementações independentes** que precisam ficar em sincronia: o app Android (`ShardProtocol.kt`/`ShardServer.kt`), o gateway em Node (`sever/gateway/shardTransport.js`) e o nó semente em Node (`vagalun-node.js`). Isso é documentado explicitamente no topo do `vagalun-node.js`, que existe justamente como "reimplementação fiel, em JS, do protocolo TCP que o app Android fala".

**Wire format:** cada mensagem é um frame `[4 bytes de tamanho, big-endian][N bytes de payload]`. Toda operação começa com um frame JSON (o "header" — `{op, shardKey, ...}`); operações que devolvem bytes (`get`/`get_range`) mandam um segundo frame binário na sequência. Uma conexão TCP atende **uma única requisição** e fecha (espelhando o comportamento do app Android).

**Operações suportadas:** `put` (grava shard), `get`/`get_range` (lê inteiro ou por offset — usado pra servir `Range: bytes=` do HTTP), `delete`, `challenge` (prova simples de posse: hash do conteúdo + nonce, usada para auditoria/monitoramento — não deve ser confundida com a prova Merkle on-chain do contrato) e `status` (capacidade/uso).

**Dois transportes por peer:** `transport: 'tcp'` (host:porta direto — uso em LAN/dev/nó semente na mesma VPS) e `transport: 'relay'` (o peer só é alcançável repassando a mensagem pelo signaling, porque está atrás de NAT — típico de um celular real na rede móvel). Quem decide qual usar é o registry do gateway (`sever/gateway/registry.js`), guardado por `nodeId`.

## Camada 3 — Signaling & Relay Server

`sever/server.js` — servidor WebSocket (`ws`) + HTTP simples, é o "quadro de avisos" da rede: todo nó (celular ou infraestrutura) se registra com um `nodeId`, descobre quem mais está online, troca ofertas/respostas SDP de WebRTC (`type: 'signal'`) e — quando não dá pra estabelecer WebRTC ou é mais simples — repassa pedidos de shard inteiros (`type: 'relay'`/`relay_response`) sem o gateway precisar montar uma sessão WebRTC própria.

Detalhe de design que aparece bem documentado no código: processos de infraestrutura (o próprio gateway, o publisher, a plataforma de hospedagem) também se conectam ao signaling — mas com `nodeId`s como `gateway-1`, `publisher-<timestamp>`, `hosting-platform-<timestamp>` — e são filtrados (`isInfraNodeId`) para **nunca aparecer** na lista de peers de um celular real, nem gerar eventos `peer_joined`/`peer_left` pra ele. Isso corrigiu um bug de produção real: celulares tentando negociar WebRTC com o próprio gateway e travando em timeout.

O servidor também mantém **histórico de sessões** por nó (`data/node-sessions.json`) — conexão/desconexão/duração — usado pelas rotas `GET /nodes`, `/nodes/history` e `/nodes/stats`, que alimentam o painel de monitoramento de nós.

Por fim, é aqui que mora o **ledger de pontos off-chain** (`points.js`) e o poller de provas on-chain (`proofPoints.js`), descritos em detalhe mais abaixo.

## Camada 4 — Gateway HTTP (CDN lite)

`sever/gateway/gateway.js` — o único componente que fala **HTTP puro** com o mundo exterior; é o que faz o Vagalun parecer, pro visitante final, uma CDN qualquer.

Rotas de conteúdo:

| Rota | Função |
|---|---|
| `GET/HEAD /raw/:fileId` | Serve um arquivo publicado direto pelo `fileId`, com suporte a `Range` (206 Partial Content) — é a rota que qualquer `<img>`, `<script>` ou `<video src>` de um site publicado acaba usando como fallback. |
| `GET /p2p/:fileId` | Devolve um "bilhete" (chave do arquivo, candidatos de peer, URL do signaling) para o **navegador buscar direto nos celulares via WebRTC**, sem consumir banda da VPS — só existe para arquivos publicados em modo replicado (`k=1`, tipicamente vídeo/áudio). |
| `GET /__vgl/vagalun-player.iife.js` / `.css` | O player oficial (`@vagalun/player`), injetado automaticamente em todo `<video>`/`<audio>` do HTML publicado que aponte para um arquivo streamável — troca P2P/HTTP de fonte automaticamente, com suporte a anúncios VAST configurados pelo dono do site. |
| `GET/HEAD /*` (via `Host:`) | Resolve domínio + caminho através do manifesto de site assinado e serve o arquivo correspondente. |

Rotas administrativas (`/admin/*`, protegidas por `GATEWAY_ADMIN_TOKEN` com comparação em tempo constante): `POST /admin/peers` (registra nó TCP ou relay), `POST /admin/files` (registra o manifesto de um arquivo já fatiado/cifrado/RS-codificado), `DELETE /admin/files/:fileId`, `POST /admin/sites` (publica manifesto de site, com verificação de assinatura) e `GET /admin/status`.

Internamente, a leitura de um arquivo (`sever/gateway/content.js`) busca os shards necessários dos peers certos em paralelo (`multiSource.js`), decodifica com Reed-Solomon (`reedSolomon.js`), decifra o bloco (AES-256-GCM, `crypto.js`) e devolve — com um **cache LRU de blocos descriptografados** (`cache.js`) para não repetir esse trabalho a cada requisição do mesmo conteúdo popular.

## Camada 5 — Publisher / gateway-client

`hosting/gateway-client/` (versão biblioteca, usada pela plataforma) e `sever/publisher/` (versão CLI, standalone) implementam o mesmo pipeline de publicação, e é aqui que a "mágica" de fatiar/cifrar/redundar acontece do lado de quem publica:

1. Deriva um `fileId` determinístico do conteúdo (`deriveFileId`) — dois uploads do mesmo arquivo no mesmo caminho geram o mesmo `fileId`, o que permite **pular reencode/reenvio de arquivos que não mudaram** entre uma publicação e outra (ver `previousRoutes`/`reused` no fluxo de `publishSiteDir`).
2. Cifra e aplica Reed-Solomon (`encodeAndUpload.cjs`, espelhando `erasure/ReedSolomon.kt` do app e `sever/gateway/reedSolomon.js`).
3. Sobe cada shard ao(s) nó(s) certo(s), por TCP direto ou por relay (`relayTransport.cjs`/`shardTransport.cjs`).
4. Registra o manifesto do arquivo no gateway (`/admin/files`).
5. Monta o **manifesto do site** (lista de rotas → `fileId`), assina com a chave Ed25519 do site (`siteKeys.cjs` — gerada e guardada localmente por domínio) e publica (`/admin/sites`).

Um caso especial: **vídeo e áudio não são fatiados por Reed-Solomon como o resto** — são publicados em modo **replicado** (`k=1`, cada nó guarda uma cópia inteira e independente do arquivo cifrado), porque é isso que permite ao navegador do visitante baixar o arquivo **inteiro de um único peer** via WebRTC, sem precisar reconstruir múltiplos shards primeiro. O publisher também reescreve automaticamente o HTML publicado, trocando cada `<video>`/`<audio>` que aponte para um arquivo streamável por um embed do player oficial já configurado com fonte P2P + fallback HTTP — sem o usuário precisar editar nada manualmente.

## Camada 6 — Plataforma de hospedagem (SaaS)

`hosting/server.js` (Express) + `hosting/client/` (painel React/Vite) — é a camada de produto: onde uma pessoa sem saber nada de shard/Reed-Solomon consegue **criar conta, subir um site (ou arrastar um `.zip`), configurar domínio, editar arquivos num explorador in-browser, ver consumo, configurar anúncios em vídeo e pagar por mais espaço**.

Principais grupos de rota:

- **Auth** (`/api/auth/*`): registro/login com `bcrypt` + `jsonwebtoken`.
- **Sites** (`/api/sites/*`): criação, upload de `.zip`, **explorador de arquivos completo** (ler/editar conteúdo, upload avulso, extrair zip, criar pasta, mover, apagar), domínio customizado, configuração de anúncios (`/ads`).
- **Billing** (`/api/billing/*`): planos, histórico e **pagamento via Solana Pay** — gera um QR code com uma `reference` (chave pública descartável, conforme a spec do Solana Pay) e reconcilia o pagamento em dois caminhos: o painel faz polling em `GET /api/billing/solana/:paymentId`, **e** o próprio servidor varre pagamentos pendentes periodicamente (`reconcileSolanaPayments`, a cada 20s por padrão) procurando a transação on-chain — cobrindo o caso do usuário fechar a aba antes da confirmação.
- **Usage** (`/api/usage`): consumo de espaço/banda por conta.

O comentário mais importante do arquivo, arquitetonicamente falando: **o disco local da VPS (`hosting/sites/<id>`) é só estágio temporário** (extrair zip, medir tamanho, publicar) — depois que a publicação nos nós é confirmada, o diretório local é apagado. Quem serve o site pro visitante final é **sempre** a rede de nós através do gateway, nunca mais o disco desta VPS específica. Isso é o que torna a "hospedagem" de fato descentralizada e não só "um backend a mais na frente de um servidor tradicional".

A plataforma consulta o signaling (`GET /nodes`) a cada publicação para saber **quais celulares estão online agora** e calcula `k`/`m` dinamicamente: com N celulares online, tenta manter redundância (`m > 0`) suficiente pra o site sobreviver a alguns saírem do ar; com só um celular, cai para `k=1/m=0` (sem redundância — mas ainda no ar).

## Camada 7 — Contrato Solana (`storage_market`)

`contract/programs/storage_market/src/lib.rs` — programa Anchor que formaliza a parte econômica da rede.

**Conceitos principais do contrato:**

- **`MarketConfig`**: preço em lamports por GB/dia, definido pela conta admin (`init_market_config`/`update_price`).
- **`UserAccount`**: cada usuário começa com um **tier gratuito** (`FREE_TIER_BYTES = 500 MB`) e pode comprar mais espaço (`purchase_tier`), até um teto (`MAX_TIER_BYTES = 10 GB`).
- **`FileVault`**: ao publicar um arquivo com redundância `k`/`n` por `days` dias, o dono paga adiantado o custo total (`price × GB × n × days`) para um **vault (PDA) daquele arquivo especificamente** — o dinheiro fica travado ali, não vai direto pra ninguém.
- **`Placement`**: registra qual provedor (wallet) ficou responsável por qual índice de shard de qual vault, com uma raiz Merkle do conteúdo esperado.
- **`submit_paid_claim`**: o provedor que está de fato hospedando o shard reivindica o pagamento correspondente daquele vault — o PDA do vault assina a transferência para si mesmo (`CpiContext::new_with_signer`), sem intervenção manual do dono do arquivo.
- **`withdraw_unused`**: o dono do arquivo pode encerrar o vault e recuperar o saldo não reivindicado.
- **Contribuição gratuita** (`register_free_contribution` + `report_free_tier_proof`): mecanismo separado, pensado para quem hospeda **sem cobrar diretamente** (ex: um celular ocioso ajudando a rede) — em vez de receber SOL, ganha **espaço de tier gratuito** ao apresentar prova Merkle válida de um chunk, por época (1 época = 1 dia, `SECONDS_PER_EPOCH`), até uma vez por época por contribuição.
- **Prova Merkle** (`verify_merkle_proof`, `keccak`): tanto o claim pago quanto a prova de contribuição gratuita dependem de reconstruir a raiz Merkle a partir de um chunk + seu índice + a lista de irmãos no caminho, e comparar com a raiz registrada no momento do `register_placement`/`register_free_contribution` — é assim que o contrato verifica "esse provedor realmente tem o dado", sem precisar armazenar o arquivo inteiro on-chain.


## Camada 8 — Nó semente (`vagalun-node.js`)

Script Node.js standalone, autocontido, que implementa o **mesmo protocolo TCP de shard do app Android** — mas roda num processo comum em VPS, sem depender de um celular físico ligado 24 horas. É explicitamente descrito no próprio código como um **item de bootstrap** ("nó semente"), não como a visão final do projeto: ajuda a rede a ter redundância extra nos primeiros arquivos publicados, sem depender só de celulares intermitentes, mas continua sendo "um nó controlado por quem roda o gateway" — não é descentralização por si só.

Funciona nos dois modos de transporte (TCP direto, registrando-se via `POST /admin/peers` no gateway; e opcionalmente também via signaling/WebSocket, se `SIGNALING_URL` for configurada — nesse caso aparece em `GET /nodes` exatamente como um celular real apareceria). Traz exemplos prontos de systemd/pm2 para rodar de forma persistente.

---

## Sistema de pontos (proof-of-contribution)

Inspirado em modelos como o da Grass: um **ledger off-chain** (`sever/points.js`, persistido em `points-ledger.json`) acumula pontos por contribuição real, sem custar SOL a cada micro-evento — a conversão para um token/recompensa de verdade fica para uma fase futura (snapshot + Merkle tree + claim on-chain), fora do escopo deste arquivo.

Duas fontes de pontos, com pesos bem diferentes de propósito:

1. **Uptime verificado** — 1 ponto a cada 60s online, **só** se a conexão ao signaling veio acompanhada de uma assinatura Ed25519 válida (prova de posse da wallet — impede alguém de declarar a pubkey de outra pessoa e roubar pontos alheios).
2. **Prova on-chain de armazenamento** (`sever/proofPoints.js`) — vale **50 pontos por prova**, muito mais que uptime sozinho, porque só é creditada quando o contrato `storage_market` de fato aceitou uma prova Merkle de posse de shard (`total_shards_proven` subindo na conta `ProviderRecord`). O poller consulta essa conta on-chain a cada 5 minutos (padrão) para cada wallet conhecida.

Isso desenha intencionalmente uma hierarquia de confiança: "estar online" prova pouco, "provar posse de dado de verdade, on-chain" prova muito.

## Segurança e modelo de confiança

- **Criptografia ponta a ponta por bloco**: cada bloco de um arquivo é cifrado com **AES-256-GCM** (chave derivada da carteira do dono via `KeyManager`) antes de ser fatiado por Reed-Solomon e distribuído. Um nó de armazenamento — celular, nó semente ou até o próprio gateway — nunca vê o conteúdo em claro por padrão; só decifra quem tem a `fileKey`.
- **Publicação intencional de `fileKeyB64`**: para conteúdo que já é público por natureza (um site estático), a chave do arquivo é publicada no gateway de propósito — é isso que permite o gateway servir por HTTP normal para qualquer visitante, sem exigir que o navegador tenha uma carteira. Conteúdo privado nunca deveria ter a chave publicada — o gateway consegue reconstruir o ciphertext (via Reed-Solomon) mas fica opaco para ele, por padrão, sem a chave.
- **TOFU (trust-on-first-use) por domínio**: o primeiro `POST /admin/sites` de um domínio grava o dono; publicações seguintes só são aceitas se assinadas pela **mesma chave Ed25519** — a mesma curva usada pela carteira Solana derivada via SLIP-10 no app. A assinatura cobre um "manifesto canônico" (domínio + rotas ordenadas + `fileId` + `contentType` de cada uma), então não dá para adulterar uma única rota sem invalidar a assinatura inteira.
- **Comparação em tempo constante para tokens de admin** (`crypto.timingSafeEqual`) nas rotas administrativas do gateway e do signaling, evitando vazar o token por diferença de tempo de resposta.
- **Prova de posse de wallet fora da blockchain**: o app assina o próprio `nodeId` com a chave Ed25519 da carteira ao se registrar no signaling; o servidor verifica essa assinatura antes de começar a contar pontos de uptime para aquela pubkey — sem isso, qualquer cliente WebSocket poderia declarar a pubkey de outra pessoa.
- **Filtragem de nós de infraestrutura** no signaling, para que processos internos (gateway, publisher, plataforma) nunca sejam oferecidos como peer de WebRTC para um celular real.

## Fluxo ponta a ponta: publicar um site com vídeo

1. Usuário sobe um `.zip` (ou edita arquivos direto) no painel (`hosting/client/`).
2. `hosting/server.js` extrai/prepara os arquivos, consulta `GET /nodes` no signaling para saber quantos celulares estão online agora, e decide `k`/`m`.
3. Para cada arquivo que **não** é vídeo/áudio: cifra, aplica Reed-Solomon com `k`/`m`, sobe os `n` shards resultantes para os nós disponíveis, registra o manifesto no gateway.
4. Para vídeo/áudio: publica em modo replicado (`k=1`, várias cópias completas cifradas em celulares distintos).
5. Reescreve automaticamente qualquer `<video>`/`<audio>` do HTML para usar o player oficial, com fonte P2P + fallback HTTP.
6. Monta o manifesto do site (rotas → `fileId`), assina com a chave Ed25519 do domínio, publica no gateway.
7. Um visitante acessa o domínio → o gateway resolve a rota pelo manifesto assinado → busca os shards necessários dos peers certos (TCP ou relay) → reconstrói via Reed-Solomon → decifra → serve por HTTP, com suporte a `Range` para vídeo. Se o navegador conseguir negociar WebRTC direto com um dos celulares que guarda a cópia replicada, o vídeo é baixado **direto do celular**, sem passar pela banda da VPS do gateway.

---

## Stack tecnológica

| Camada | Tecnologia |
|---|---|
| App Android | Kotlin, WebRTC nativo (`org.webrtc`), NSD/mDNS, WorkManager, `sol4k` + `net.i2p.crypto.eddsa` (Ed25519/SLIP-10) |
| Gateway / Signaling / Nó semente | Node.js puro (`http`, `net`, `ws`), sem framework — foco em controle fino do protocolo binário |
| Plataforma de hospedagem | Express, JWT, bcrypt, multer, unzipper, `qrcode` |
| Painel (front-end) | React + Vite, `lucide-react`, `axios`, `react-router-dom` |
| Blockchain | Solana (Anchor / Rust), `@solana/web3.js`, Solana Pay |
| Redundância de dados | Reed-Solomon sobre GF(256), implementado de forma independente em Kotlin e em JS (mesma matemática, três execuções) |
| Criptografia de conteúdo | AES-256-GCM por bloco, chave derivada por arquivo |
| Player de vídeo | `@vagalun/player` (bundle próprio, IIFE), com suporte a anúncios VAST |

## Estrutura de pastas

```
vagalun-main/
├── app/                     # App Android (Kotlin) — nó + carteira + UI
├── contract/                # Programa Anchor storage_market (Rust)
├── sever/                   # Signaling/relay (server.js) + Gateway (gateway/) + nó publisher CLI
│   ├── gateway/              #   HTTP CDN lite, registry, reconstrução multi-fonte
│   └── publisher/             #   CLI de publicação standalone
├── hosting/                 # Plataforma SaaS (Express) + painel (client/, React)
│   └── gateway-client/        #   biblioteca de publicação (encode/upload/assina)
├── vagalun-node.js          # Nó semente standalone (Node.js puro)
└── .github/workflows/        # CI de build do APK
```

## Como rodar localmente

> Visão simplificada — cada `.env`/`.env.example` dentro de `sever/` e `hosting/` tem a lista completa de variáveis.

```bash
# 1) Signaling / relay (porta padrão 8787)
cd sever && npm install && node server.js

# 2) Gateway HTTP / CDN lite (porta padrão 8788)
cd sever/gateway && node gateway.js

# 3) (opcional, pra testar sem celular) Nó semente
NODE_ID=seed-1 PORT=9500 SIGNALING_URL=ws://127.0.0.1:8787 \
GATEWAY_ADMIN_URL=http://127.0.0.1:8788 node vagalun-node.js

# 4) Plataforma de hospedagem (porta padrão 3000)
cd hosting && cp .env.example .env    # preencher GATEWAY_URL, GATEWAY_RELAY_URL etc.
npm install && node server.js

# 5) Painel (Vite dev server)
cd hosting/client && npm install && npm run dev

# 6) App Android
#    abrir app/ no Android Studio, ou usar o workflow "Gerar APK do Adla"
#    (.github/workflows/apk.yml) via GitHub Actions -> workflow_dispatch
```
