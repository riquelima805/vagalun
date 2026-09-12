<div align="center">

### CDN livre de censura — hospedagem, vídeo sob demanda, **live streaming**  **navegador P2P próprio**, rodando em celulares e PCs comuns, pago em Solana

![status](https://img.shields.io/badge/status-devnet%20%2F%20MVP-b30000?style=for-the-badge)
![android](https://img.shields.io/badge/Android-Kotlin-8b0000?style=for-the-badge)
![browser](https://img.shields.io/badge/Navegador-P2P%20standalone-d62828?style=for-the-badge)
![pcnode](https://img.shields.io/badge/N%C3%B3%20de%20PC-RTMP%20%2F%20TURN-c1121f?style=for-the-badge)
![solana](https://img.shields.io/badge/Solana-Anchor-a30000?style=for-the-badge)
![license](https://img.shields.io/badge/licen%C3%A7a-a%20definir-660708?style=for-the-badge)

*"Mesmo que a hospedagem caia, mesmo que o site saia do ar em algum canto da rede — se existe um peer com o conteúdo, o navegador acha ele."*

</div>

---

## Sumário

1. [O que é o Vagalun hoje](#o-que-é-o-vagalun-hoje)
2. [O que é novo nesta versão: o Navegador](#o-que-é-novo-nesta-versão-o-navegador)
3. [O problema](#o-problema)
4. [Visão geral da arquitetura](#visão-geral-da-arquitetura)
5. [Camada 0 — Navegador P2P (app novo, standalone)](#camada-0--navegador-p2p-app-novo-standalone)
6. [Camada 1 — App Android (nó de celular)](#camada-1--app-android-nó-de-celular)
7. [Camada 2 — Nó de PC (`node pc app/`)](#camada-2--nó-de-pc-node-pc-app)
8. [Camada 3 — Protocolo de shard (CDN estático/VOD)](#camada-3--protocolo-de-shard-cdn-estáticovod)
9. [Camada 4 — Live streaming distribuído (RTMP → HTTP-FLV)](#camada-4--live-streaming-distribuído-rtmp--http-flv)
10. [Camada 5 — Signaling / diretório central (`sever/server.js`)](#camada-5--signaling--diretório-central-severserverjs)
11. [Camada 6 — Gateway HTTP (CDN lite, estático/VOD)](#camada-6--gateway-http-cdn-lite-estáticovod)
12. [Camada 7 — Publisher / gateway-client](#camada-7--publisher--gateway-client)
13. [Camada 8 — Plataforma de hospedagem estática (`hosting/`, legado ainda ativo)](#camada-8--plataforma-de-hospedagem-estática-hosting-legado-ainda-ativo)
14. [Camada 9 — Painel de CDN/Streaming (`cdn-panel/`, produto novo, front-end only)](#camada-9--painel-de-cdnstreaming-cdn-panel-produto-novo-front-end-only)
15. [Camada 10 — Contrato Solana (`storage_market`)](#camada-10--contrato-solana-storage_market)
16. [Sistema de pontos e payout por época (epoch)](#sistema-de-pontos-e-payout-por-época-epoch)
17. [Segurança e modelo de confiança](#segurança-e-modelo-de-confiança)
18. [Fluxo ponta a ponta: abrindo um site no navegador quando a hospedagem caiu](#fluxo-ponta-a-ponta-abrindo-um-site-no-navegador-quando-a-hospedagem-caiu)
19. [Fluxo ponta a ponta: uma live começando](#fluxo-ponta-a-ponta-uma-live-começando)
20. [Fluxo ponta a ponta: publicar um site (VOD/estático)](#fluxo-ponta-a-ponta-publicar-um-site-vodestático)
21. [Stack tecnológica](#stack-tecnológica)
22. [Estrutura de pastas](#estrutura-de-pastas)
23. [Como rodar localmente](#como-rodar-localmente)


---

## O que é o Vagalun hoje

Vagalun é uma **rede de CDN descentralizada** com três produtos rodando em cima da mesma rede de nós:

- **Estático / VOD**: sites, apps web, jogos e vídeo/áudio pré-gravado são fatiados, cifrados e distribuídos entre nós (celulares e PCs), reconstruídos sob demanda por um **gateway HTTP** que qualquer navegador comum acessa normalmente.
- **Live streaming**: transmissão ao vivo via **RTMP ingest** e entrega por **HTTP-FLV**, com failover automático entre nós e fan-out por relay.
- **Navegador P2P** (**novo nesta versão**): um app Android separado que não depende do gateway HTTP nem de nenhuma VPS de origem para exibir um site — ele entra direto na rede de peers e busca o conteúdo, arquivo por arquivo, via WebRTC.

A camada econômica continua em **Solana**: um job de payout semanal por época (epoch) soma pontos (uptime + banda de relay/live + provas de armazenamento), publica uma raiz Merkle on-chain e deixa cada nó reivindicar sua parte com uma prova, de uma vez só.

Em uma frase: **é uma tentativa de reconstruir o que Cloudflare, Mux/S3+CloudFront e até um navegador fazem juntos — hospedar, transmitir ao vivo e exibir um site — só que sem nenhum ponto único (nem o site do dono do conteúdo, nem a VPS de gateway) que precise estar de pé para o conteúdo continuar acessível.**

## O que é novo nesta versão: o Navegador

A pergunta que motivou esta camada foi: **"e se a hospedagem cair, ou a VPS do gateway sair do ar — o conteúdo já publicado morre junto?"** A resposta implementada foi construir um **segundo app Android, totalmente separado do app-nó**, que não passa pelo gateway HTTP em nenhum momento — ele fala diretamente com a rede de peers.

Diferença fundamental: o app-nó (Camada 1) e o gateway (Camada 6) são **intermediários** — um guarda shard, o outro resolve domínio e reconstrói arquivo por HTTP normal, para que **qualquer navegador do mercado** (Chrome, Firefox) possa abrir o site. O Navegador novo **substitui os dois**: ele mesmo entra no gossip, ele mesmo resolve o manifesto do domínio, ele mesmo baixa os shards via WebRTC e ele mesmo renderiza o HTML numa `WebView` embutida — sem depender de DNS, HTTP ou de nenhuma VPS estar de pé no meio do caminho. Se existir **pelo menos um peer real**  com aquele conteúdo replicado, o Navegador acha e exibe, mesmo que o site original, o gateway e a hospedagem tenham caído todos ao mesmo tempo.

## O problema

Hospedagem de site, vídeo gravado ou transmissão ao vivo hoje depende de:

- **Um dono**: a nuvem, o provedor de streaming ou o próprio gateway de acesso pode cair, ser derrubado por ordem judicial, ban de conta, ou simplesmente sair do ar por falta de manutenção.
- **Um ponto único de acesso**: mesmo numa CDN "descentralizada" de armazenamento, se o único jeito de *ver* o conteúdo é através de um gateway HTTP centralizado, esse gateway ainda é um ponto de censura e de falha.
- **Um custo alto de banda**, especialmente em live.

O Vagalun ataca isso em duas frentes complementares: a rede de armazenamento em si (sem dono único, qualquer nó guarda shard) **e agora também a camada de acesso** — o Navegador prova que dá para **contornar completamente o gateway** e ainda assim abrir o site, contanto que a rede de peers continue viva.

## Visão geral da arquitetura

```
┌────────────────────────┐        ┌─────────────────────────┐
│  NAVEGADOR (app novo,    │◄──────►│  outros NÓS (celular/PC) │
│  com.decentstorage.      │ WebRTC │  guardam shard de        │
│  browser)                │ direto │  verdade (Camada 1/2)    │
│  — capacidade 0, nunca   │  ou    │                          │
│  guarda nada, só         │ relay  └───────────┬──────────────┘
│  consome via gossip      │  via                │
└───────────┬─────────────┘ signaling            │ gossip de sites
            │ WebSocket (achar peers)            │ conhecidos
            ▼                                     ▼
┌─────────────────────────────────────────────────────────────┐
│  SIGNALING / DIRETÓRIO CENTRAL — sever/server.js              │
│  (mesmo servidor que os nós reais usam; navegador só troca    │
│   offer/answer/ICE aqui — nunca guarda shard nem serve nada)  │
└─────────────────────────────────────────────────────────────┘

   (em paralelo, sem relação com o navegador — fluxos que        ┌─────────────────────┐
    continuam existindo para quem acessa por HTTP normal:)       │  cdn-panel/ (React)  │
                                                                   │  UI: Vídeos, Streams,│
┌──────────────┐   RTMP push    ┌────────────────────────────┐  │  API Keys, Billing,  │
│  Transmissor  │───────────────►│   NÓ (celular OU PC)        │  │  Preços — front-end  │
│  (OBS/ffmpeg) │                │   RTMP ingest + HTTP-FLV     │  │  aguardando API      │
└──────────────┘                └───────────┬────────────────┘  │  própria em :8790    │
                                             │ heartbeat           └─────────────────────┘
                    ┌──────────────────▼───┐   ┌──▼─────────────────┐
                    │  GATEWAY HTTP (VPS)    │   │  App Android /     │
                    │  sever/gateway/        │◄─►│  outros nós de PC  │
                    │  CDN estático + VOD    │   │  (shard TCP/relay) │
                    │  para navegador comum  │   └─────────────────────┘
                    │  (Chrome, Firefox)     │
                    └──────────┬────────────┘
                                │ publica via
                    ┌──────────▼────────────┐
                    │  gateway-client/       │
                    │  publish.cjs           │
                    └────────────────────────┘

                        ┌───────────────────────────────────┐
                        │  SOLANA — programa Anchor            │
                        │  storage_market + payout por época   │
                        │  (epochJob.js, Merkle root)           │
                        └───────────────────────────────────┘
```

Existem agora **quatro planos**: o plano de **acesso via navegador próprio** (novo — sem gateway, sem HTTP/DNS), o plano de **conteúdo estático/VOD via gateway** (para navegador comum), o plano de **live** (ingest, failover, relay), e o plano **econômico** (Solana). O Navegador é o único desses planos que **não precisa de nenhuma VPS própria do Vagalun estar de pé** para funcionar — só precisa do signaling (que também pode ser hospedado por qualquer nó, hoje ainda centralizado) e de pelo menos um peer com o conteúdo.

---

## Camada 0 — Navegador P2P (app novo, standalone)

`vagalume-browser-main/` — **app Android separado**, `namespace com.decentstorage.app` mas **`applicationId com.decentstorage.browser`** — proposital: isso permite instalar o Navegador **lado a lado** com o app-nó original no mesmo aparelho, sem conflito, como dois apps distintos (um guarda shard, o outro só consome).


## Camada 1 — App Android (nó de celular)

`app/` (repositório principal) — Kotlin, pacote `com.decentstorage.app`, nome de exibição **Vagalun**. Continua sendo **nó de armazenamento** de shards (protocolo TCP/relay), **carteira Solana embutida** (SLIP-10, Ed25519) e **cliente de upload/download** com AES-256-GCM + Reed-Solomon (`erasure/`). É este app (e o nó de PC) que efetivamente **guardam** o conteúdo que o Navegador (Camada 0) só consome. O celular não tem, neste snapshot, ingest RTMP/HTTP-FLV — isso é exclusivo do nó de PC.

## Camada 2 — Nó de PC (`node pc app/`)

Executável Node.js standalone (empacotado com `pkg`), que soma três papéis num processo só: **signaling WebSocket**, **STUN/TURN** (`node-turn`) e **servidor de mídia** (RTMP ingest + HTTP-FLV, via `node-media-server`). Tem painel local (`http://localhost:8787`), auto-detecção de alcançabilidade via UPnP/NAT (`natUpnp.js`), vínculo de dono (`ownerLink.js`) entre a wallet efêmera do nó e uma wallet pessoal (Phantom) para onde vai o payout, e relay/fan-out de live via `ffmpeg` (`relay.js`) quando um `streamPath` fica popular demais para um único nó aguentar sozinho. Registra-se por padrão contra o diretório oficial (`https://signal.vagalun.shop`, configurável via `VAGALUN_DIRECTORY_URL`).

## Camada 3 — Protocolo de shard (CDN estático/VOD)

Reimplementado de forma independente em três lugares que precisam ficar em sincronia (app Android, app Navegador via `StorageClient`/`GossipRegistry`, `sever/gateway/shardTransport.js`, `vagalun-node.js`): frame `[4 bytes de tamanho][payload]`, operações `put`/`get`/`get_range`/`delete`/`challenge`/`status`, transporte `tcp` (direto) ou `relay` (via signaling, para nó atrás de NAT). Sustenta **sites estáticos e vídeo pré-gravado (VOD)** — é conceitualmente separada da camada de live, que não usa Reed-Solomon nem fatiamento.

## Camada 4 — Live streaming distribuído (RTMP → HTTP-FLV)

1. Um transmissor (OBS, ffmpeg) faz **push** para um nó de PC numa URL assinada (`rtmp://host:1935/streamPath?sign=exp-hash`).
2. `media.js` aceita o ingest, mede bitrate real por `streamPath` a cada 5s, e avisa `sever/server.js` **na hora** (não espera o próximo heartbeat).
3. `sever/server.js` mantém `liveStreamIndex` (`streamPath -> Map<nodeId, {kbps, publicHost, mediaHttpPort}>`) e escolhe o melhor nó para cada novo espectador.
4. Um espectador pede `GET /live/location?streamPath=...` e recebe a URL HTTP-FLV pronta; espectadores já assistindo recebem `live_location`/`live_offline` empurrados via WebSocket se o nó de origem cair ou trocar.
5. `ensureRelayCapacity()` designa outro nó ocioso para puxar (via `ffmpeg`) e republicar a live quando ela cresce, distribuindo a carga de banda.
6. Se o nó de origem cai, o índice central escolhe automaticamente a próxima fonte disponível e notifica os espectadores.

Autenticação: **transmitir exige** URL assinada; **assistir é sempre livre** — mesmo modelo de um CDN de vídeo comum.

## Camada 5 — Signaling / diretório central (`sever/server.js`)

O "quadro de avisos" da rede: registro de `nodeId` (com prova de posse via assinatura Ed25519, anti-hijack), troca de sinalização WebRTC, relay de shard/gossip para quem está atrás de NAT — usado tanto pelos nós reais quanto pelo **Navegador** (Camada 0). Também carrega as responsabilidades de live: índice de streams ativas, atribuição de relay/fan-out, notificação de espectadores em tempo real, e as rotas de consulta de época (`Epochapi.js`).

## Camada 6 — Gateway HTTP (CDN lite, estático/VOD)

`sever/gateway/gateway.js` — serve `GET/HEAD /raw/:fileId` (com `Range`), `GET /p2p/:fileId` (bilhete para WebRTC direto no navegador comum), resolução de site por domínio, rotas `/admin/*`. É o caminho de acesso para **navegadores do mercado** (Chrome, Firefox) — diferente do app Navegador (Camada 0), que dispensa esse gateway inteiramente. O gateway não participa da entrega de live (HTTP-FLV é servido direto pelo nó de PC/celular com a live).

## Camada 7 — Publisher / gateway-client

`hosting/gateway-client/` e `sever/publisher/` publicam **conteúdo estático/VOD**: `deriveFileId` determinístico, cifra + Reed-Solomon, upload por shard, manifesto assinado (Ed25519) por domínio. Vídeo pré-gravado é publicado em modo replicado `k=1` com o player `@vagalun/player` injetado automaticamente no HTML — fluxo separado do live streaming (Camada 4).

## Camada 8 — Plataforma de hospedagem estática (`hosting/`, legado ainda ativo)

`hosting/server.js` + `hosting/client/` — plataforma SaaS original (auth, upload de `.zip`, explorador de arquivos, domínio customizado, anúncios em vídeo VAST, billing via Solana Pay com reconciliação automática), continua no repositório, sem indicação de estar quebrada. Convive com o `cdn-panel/` novo (Camada 9) — é o único dos dois com backend completo funcionando hoje.

## Camada 9 — Painel de CDN/Streaming (`cdn-panel/`, produto novo, front-end only)

`sever/cdn-panel/` — painel React/Vite novo, com **Overview**, **Vídeos**, **Streams**, **Chaves de API**, **Billing**, **Preços**, **Docs**. O `api/client.js` já tem todas as chamadas escritas.

## Camada 10 — Contrato Solana (`storage_market`)

`contract/programs/storage_market/src/lib.rs` — `MarketConfig`, `UserAccount` com tier gratuito e pago, `FileVault` por arquivo, `Placement` por shard, `submit_paid_claim`, `withdraw_unused`, contribuição gratuita com prova Merkle. `declare_id!` continua no placeholder padrão do Anchor, `Anchor.toml` aponta para `devnet`. Na prática, o caminho de payout hoje seguido é o **payout por época** (próxima seção), que consulta este mesmo programa por uma rota de Merkle root semanal.

## Sistema de pontos e payout por época (epoch)

- `sever/points.js`: uptime verificado por assinatura Ed25519, prova on-chain de armazenamento valendo mais que uptime sozinho, e agora também **banda de relay/live** como fonte de pontos.
- `Epochjob.js` roda 1x por época, pega quem ainda não recebeu, converte pontos em lamports (`USD_PER_POINT`, cotação manual revisada de tempos em tempos, + `priceFeed.js` para SOL/USD), monta uma árvore Merkle (`merkle.js`), publica a raiz on-chain e salva snapshot local (`epochs/epoch-<id>.json`).
- Quem não bate o mínimo de saque na época (`MIN_CLAIM_USD`, padrão US$1) não entra na árvore daquela vez — os pontos continuam e somam para a próxima época.
- `Epochapi.js` expõe rotas de leitura (`/epoch/current`, `/epoch/:id/proof/:pubkey`) para o nó de PC e o app mobile reivindicarem (`claim_epoch`) contra o programa on-chain.

## Segurança e modelo de confiança

- **Criptografia ponta a ponta por bloco** em conteúdo estático/VOD (AES-256-GCM), **TOFU por domínio** com assinatura Ed25519 do manifesto de site, comparação em tempo constante para tokens de admin, prova de posse de wallet fora da blockchain no registro do signaling, filtragem de nós de infraestrutura.
- **Push assinado, play livre** na live: transmitir exige `sign=exp-md5(streamPath-exp-secret)`; assistir via HTTP-FLV não exige nada — decisão de produto deliberada.
- **Auto-checagem de alcançabilidade antes de se anunciar**: um nó só se declara `mediaCapable`/`turnCapable` depois de `checkNatAndReachability()` confirmar que a porta responde de fora.
- **Anti-hijack de `nodeId` no signaling**: desde este snapshot, **todo** peer — nó real ou o Navegador — precisa provar posse do próprio `nodeId` via assinatura Ed25519 no registro; sem isso, o servidor responde `register_unauthorized`. Isso vale também para o Navegador, que gera e persiste uma identidade local só para esse fim (não é a wallet pessoal do usuário, já que o Navegador nunca movimenta payout).
- **O Navegador nunca guarda nada de ninguém**: capacidade `0` no `GossipRegistry`, `dataDir` vazio — mesmo que um peer malicioso tentasse mandar um `put`, o handler recusa. Isso limita a superfície de ataque de rodar o Navegador em qualquer aparelho, sem exigir o mesmo nível de confiança que se exige de quem opera um nó de armazenamento de verdade.

## Fluxo ponta a ponta: abrindo um site no navegador quando a hospedagem caiu

1. Alguém abre o app **Navegador** (instalado lado a lado com o app-nó, ou sozinho) e digita `meusite.vgl` na barra de endereço.
2. O Navegador já sobe seu peer de capacidade zero desde o `onCreate`: busca a URL de signaling, se registra com sua identidade Ed25519 local, e começa a conectar via WebRTC (direto ou relay, após o timeout de 12s) com cada peer que o signaling anuncia.
3. Enquanto isso acontece em segundo plano, o gossip de metadados de sites vai chegando de peers reais que guardam shards daquele domínio — **mesmo que a VPS de hospedagem original e o gateway HTTP estejam fora do ar**, porque nenhum dos dois participa desse caminho.
4. Ao apertar "Ir", `resolveAndFetch("meusite.vgl", "/")` consulta o índice local (`registry.getSite`); se o gossip já chegou, encontra a rota `/`, decodifica a `fileKey` e baixa o arquivo shard a shard via `storageClient.downloadFileWithKey`, direto dos peers conectados.
5. O HTML decifrado é carregado na `WebView`; qualquer sub-recurso que a página peça depois (CSS, imagem, outra rota) passa de novo por `resolveAndFetch`, sem nunca sair para uma requisição de rede real.
6. Se o domínio ainda não apareceu no índice local (gossip pode levar alguns segundos, ou nenhum peer com aquele conteúdo está online agora), o app mostra isso explicitamente na barra de status, em vez de dar erro genérico de rede — e o painel de debug embutido permite ver exatamente o que já chegou via gossip até aquele momento.

## Fluxo ponta a ponta: uma live começando

1. Uma pessoa com um PC ocioso e porta alcançável roda o `.exe` do nó de PC; `checkNatAndReachability()` confirma RTMP/TURN acessíveis de fora e o nó se anuncia como `mediaCapable`.
2. O operador vincula sua wallet pessoal (`POST /api/owner`) para onde vai o payout de época.
3. Um transmissor pede uma URL RTMP assinada para aquele `streamPath` e faz push via OBS/ffmpeg.
4. `media.js` detecta `postPublish`, mede kbps real, avisa `sever/server.js` na hora.
5. Um espectador chama `GET /live/location?streamPath=...`, recebe o `pullUrl` HTTP-FLV certo; se muitos espectadores aparecerem, `ensureRelayCapacity` designa outro nó para puxar e republicar.
6. Se o nó de origem cai, o próximo nó servindo aquele `streamPath` assume, e espectadores já conectados recebem a nova localização via WebSocket.
7. Ao fim da época, os pontos acumulados entram na árvore Merkle semanal e podem ser reivindicados on-chain.

## Fluxo ponta a ponta: publicar um site (VOD/estático)

Fatiar/cifrar/Reed-Solomon para a maioria dos arquivos, modo replicado `k=1` para vídeo/áudio pré-gravado, manifesto de site assinado — resolvido e servido pelo gateway por HTTP normal com suporte a `Range` para quem acessa por um navegador comum, **ou** resolvido diretamente pelo app Navegador via P2P puro, sem gateway no meio (ver fluxo anterior).

---

## Stack tecnológica

| Camada | Tecnologia |
|---|---|
| Navegador P2P  | Kotlin, `WebView` Android nativa, WebRTC (`org.webrtc`), `GossipRegistry`/`StorageClient` reaproveitados do app-nó, Ed25519 local (identidade, sem wallet) |
| App Android (nó) | Kotlin, WebRTC nativo, NSD/mDNS, WorkManager, `sol4k` + `net.i2p.crypto.eddsa` (Ed25519/SLIP-10) |
| Nó de PC | Node.js puro + `pkg`, `node-media-server` (RTMP/HTTP-FLV), `node-turn` (STUN/TURN), `@achingbrain/nat-port-mapper` (UPnP), `tweetnacl`/`bs58`, `@solana/web3.js` |
| Relay/fan-out de live | `ffmpeg`, pull HTTP-FLV + push RTMP local |
| Gateway / Signaling / Nó semente | Node.js puro (`http`, `net`, `ws`), sem framework |
| Plataforma de hospedagem (`hosting/`) | Express, JWT, bcrypt, multer, unzipper, `qrcode` |
| Painel de CDN/Streaming (`cdn-panel/`, front-end only) | React + Vite, `lucide-react`, i18n próprio |
| Payout por época | `@coral-xyz/anchor`, árvore Merkle própria (`merkle.js`), cotação SOL/USD manual (`priceFeed.js`) |
| Blockchain | Solana (Anchor / Rust), `@solana/web3.js`, Solana Pay |
| Redundância de dados (VOD/estático) | Reed-Solomon sobre GF(256), independente em Kotlin e JS |
| Criptografia de conteúdo (VOD/estático) | AES-256-GCM por bloco |

## Estrutura de pastas

```
vagalun-main/
├── vagalume-browser-main/    # NOVO — App Navegador P2P (applicationId com.decentstorage.browser)
│   └── app/src/main/java/com/decentstorage/app/
│       ├── browser/BrowserActivity.kt   #   UI de navegador + resolveAndFetch (client-side)
│       ├── network/GossipRegistry.kt      #   compartilhado com o app-nó, aqui em capacidade 0
│       └── network/RelayConfig.kt          #   mesma URL de signaling que os nós usam
├── app/                     # App Android (Kotlin) — nó de celular: armazenamento + carteira + UI
├── node pc app/             # Nó de PC: signaling + STUN/TURN + RTMP/HTTP-FLV + painel local
│   ├── index.js               #   processo principal, heartbeat, detecção de alcançabilidade
│   ├── media.js               #   camada RTMP ingest / HTTP-FLV (node-media-server)
│   ├── relay.js                #   fan-out de live via ffmpeg
│   ├── ownerLink.js            #   vínculo node efêmero -> wallet pessoal (payout)
│   └── natUpnp.js              #   mapeamento de porta via UPnP
├── contract/                # Programa Anchor storage_market (Rust)
├── sever/
│   ├── server.js              #   Signaling/diretório central + índice de lives + relay assignment
│   ├── Epochjob.js / Epochapi.js  # payout semanal por época, Merkle root, prova on-chain
│   ├── points.js               #   ledger de pontos (uptime + banda de live + provas)
│   ├── gateway/                #   HTTP CDN lite (estático/VOD), registry, multi-fonte
│   ├── publisher/               #   CLI de publicação standalone (estático/VOD)
│   ├── hosting/                #   Plataforma SaaS de hospedagem estática (backend completo)
│   │   └── gateway-client/        #   biblioteca de publicação
│   └── cdn-panel/               # painel React do produto de vídeo/streaming (front-end only)
├── vagalun-node.js          # Nó semente standalone (Node.js puro, protocolo de shard)
└── .github/workflows/        # CI de build do APK (app-nó e Navegador, workflows separados)
```

## Como rodar localmente

> Visão simplificada — cada `.env`/`.env.example` dentro de `sever/`, `hosting/` e `node pc app/` tem a lista completa de variáveis.

```bash
# 1) Signaling / diretório central (porta padrão 8787) — inclui índice de lives e rotas de época
cd sever && npm install && node server.js

# 2) Gateway HTTP / CDN lite, estático/VOD (porta padrão 8788) — necessário só para
#    quem acessa por um navegador comum (Chrome/Firefox); o app Navegador não precisa dele
cd sever/gateway && node gateway.js

# 3) Nó de PC — signaling+TURN+RTMP/HTTP-FLV+painel local (porta padrão 8787 local, RTMP 1935, HTTP-FLV 8000)
cd "node pc app" && npm install && node index.js
#    (ou baixe/gere o .exe: npm run build:win)

# 4) (opcional, pra testar sem celular/PC real) Nó semente — só protocolo de shard, estático/VOD
NODE_ID=seed-1 PORT=9500 SIGNALING_URL=ws://127.0.0.1:8787 \
GATEWAY_ADMIN_URL=http://127.0.0.1:8788 node vagalun-node.js

# 5) Plataforma de hospedagem estática (porta padrão 3000) — backend completo, VOD/sites
cd sever/hosting && cp .env.example .env
npm install && node server.js

# 6) Painel de hospedagem estática (Vite dev server)
cd sever/hosting/client && npm install && npm run dev

# 7) Painel novo de CDN/Streaming (Vite dev server) — ATENÇÃO: front-end sem backend próprio ainda
cd sever/cdn-panel && npm install && npm run dev

# 8) App Android (nó) — abrir app/ no Android Studio, ou usar o workflow de build de APK

# 9) App Navegador (NOVO) — abrir vagalume-browser-main/ no Android Studio como projeto separado,
#    ou usar o workflow de CI dele; pode ser instalado no MESMO aparelho que o app-nó (applicationId
#    diferente). Antes de abrir um domínio, garanta que existe pelo menos um nó real (Camada 1 ou 2)
#    já publicado com aquele conteúdo e registrado no MESMO signaling apontado em RelayConfig

# 10) (opcional) Payout por época — roda 1x por semana, ou sob demanda:
cd sever && node Epochjob.js
```

O contrato Solana (`contract/`) é um projeto Anchor separado — requer `anchor build`/`anchor deploy` num cluster (`Anchor.toml` já aponta para `devnet`). Testar live localmente: apontar OBS/ffmpeg para `rtmp://127.0.0.1:1935/live/teste?sign=...` e assistir em `http://127.0.0.1:8000/live/teste.flv?sign=...`. Testar o Navegador localmente: apontar `RelayConfig.CONFIG_URL` (ou o `reley.json` que ele busca) para o seu signaling local, publicar um site de teste via `gateway-client`/`publisher`, e então digitar o domínio no Navegador — o painel de debug embutido mostra se o gossip chegou e por quê, caso não chegue.

---




<div align="center">


</div>

