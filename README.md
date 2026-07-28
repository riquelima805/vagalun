<div align="center">

<img src="./assets/logo.png" alt="Vagalun Logo" width="140"/>

# 🟣 VAGALUN

### Armazenamento descentralizado, criptografado e pago via Solana

<img alt="status" src="https://img.shields.io/badge/status-devnet-8A2BE2?style=for-the-badge&labelColor=0B0E13">
<img alt="platform" src="https://img.shields.io/badge/plataforma-Android-8A2BE2?style=for-the-badge&labelColor=0B0E13">
<img alt="blockchain" src="https://img.shields.io/badge/blockchain-Solana-8A2BE2?style=for-the-badge&logo=solana&labelColor=0B0E13">
<img alt="license" src="https://img.shields.io/badge/licença-MIT-8A2BE2?style=for-the-badge&labelColor=0B0E13">

<br/>

<a href="./assets/vagalun.apk">
  <img alt="Download APK" src="https://img.shields.io/badge/⬇️_BAIXAR_APK-00FFA3?style=for-the-badge&labelColor=0B0E13&color=8A2BE2">
</a>

</div>

---

**O uqe e nosso app vagalun ?*
O **Vagalun** é um app Android de armazenamento em nuvem **descentralizado**: em vez de guardar seus arquivos num servidor de uma empresa, eles são **fragmentados, criptografados e distribuídos entre os celulares de outros usuários da rede** — e você também pode ceder espaço livre do seu aparelho para armazenar pedaços de arquivos de outras pessoas e ser pago por isso, em SOL, direto na sua carteira.

Todo usuário começa com **500 MB gratuitos** (o "tier" free), que podem ser ampliados comprando espaço extra ou contribuindo com armazenamento para a rede (tier gratuito ganho por prestar serviço).

---

##  Como funciona por dentro

### 1. Fragmentação com Reed-Solomon

Antes de sair do seu aparelho, cada arquivo é dividido em **shards** usando codificação Reed-Solomon.

```
   arquivo original
         │
   ┌─────┴─────┐
   │ Reed-Solomon (K=6, M=4) │
   └─────┬─────┘
         │
   10 shards no total (N = K + M)
         │
 ┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐
 │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │ 7 │ 8 │ 9 │10 │  → 10 nodes diferentes
 └───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
   6 shards de dado   +   4 shards de paridade
```

Isso significa que **qualquer 6 dos 10 shards** são suficientes para reconstruir o arquivo inteiro.

A rede monitora isso continuamente: se o número de cópias vivas de um arquivo cair perto do limite `K`, o próprio protocolo reconstrói o shard que faltou  e realoca ele automaticamente para outro node saudável, sem intervenção do dono do arquivo.

### 2. Criptografia ponta a ponta

- Sua seed phrase gera, via SHA-256, uma **chave mestra** local.
- Para cada arquivo, uma **chave derivada por HMAC-SHA256** é gerada a partir da chave mestra + ID do arquivo.
- O conteúdo é cifrado com **AES-256-GCM** autenticado, com IV aleatório por arquivo **antes** de ser fatiado em shards.
- Os nodes que armazenam os shards só enxergam bytes cifrados — nunca o conteúdo real, o nome do arquivo original nem a chave.

### 3. Rede P2P (WebRTC + Gossip)

- **Descoberta e sincronização de metadados**: protocolo de *gossip* — cada node troca periodicamente sua lista de peers conhecidos e os metadados dos arquivos com uma amostra aleatória de outros nodes, até a informação convergir pela rede inteira.
- **Transporte de dados**: conexões diretas **WebRTC** (DataChannel) entre os celulares, usando apenas servidores **STUN públicos** (Google/Cloudflare) — sem depender de um servidor central para tráfego de arquivos.
- **Sinalização**: um servidor leve em Node.js/WebSocket (incluso neste repo) faz apenas a "apresentação" inicial entre os peers (troca de offer/answer/ICE) para abrir o WebRTC direto.
- **Fallback de Relay**: se dois nodes não conseguirem abrir conexão direta (NAT restritivo, sem TURN), o próprio servidor de sinalização passa a retransmitir os pedidos de shard como canal alternativo, para o arquivo nunca ficar inacessível.

### 4. Carteira Solana embutida

O app deriva uma carteira Solana **Ed25519** diretamente da sua seed phrase (derivação SLIP-0010, caminho `m/44'/501'/0'/0'`, compatível com o padrão de carteiras Solana). Você pode consultar saldo, enviar SOL e comprar mais espaço, tudo sem sair do app.

---

##  Modelo econômico — pague pelo uso, o node recebe

O Vagalun **não cobra assinatura**. O modelo é *pay-as-you-go*, todo liquidado on-chain:

1. **Ao guardar um arquivo pago**, você deposita SOL num **cofre (vault)** exclusivo daquele arquivo (`create_file_vault`), calculado por: `preço por GB/dia × N shards × dias de armazenamento`.
2. Esse valor fica **retido em escrow no próprio vault** — não vai para nenhuma carteira da equipe.
3. A cada época, os nodes que provam (via prova de Merkle) que ainda têm o shard intacto **recebem o pagamento direto do vault** (`submit_paid_claim`) — **o valor pago pelo arquivo vai 100% para os nodes que efetivamente armazenam os shards**, de forma proporcional ao tempo que guardam o dado.
4. Se o dono do arquivo apagar antes do prazo, o saldo não usado do vault volta para ele (`withdraw_unused`).
5. Quem não quer pagar pode contribuir com espaço livre do próprio aparelho para a rede e ganhar tier gratuito extra em troca (`register_free_contribution` / `report_free_tier_proof`).

> Compra de tiers extras de armazenamento  é a única cobrança que vai para o tesouro do projeto — usada para manter o servidor de sinalização e o desenvolvimento do protocolo. **Todo o pagamento por hospedagem de arquivo em si vai para os nodes.**

---

## Endereços on-chain

| Item | Endereço |
|---|---|
| Program ID (contrato `storage_market`) | 
| Carteira do tesouro / admin | `DDE7RZCCbipWuBGwZLYszBQuMxvDSEF59225YoFzkFba` |
| Rede | Solana Devnet *(em testes — migração para Mainnet planejada após auditoria)* |

---

##  Instalação

1. Baixe o APK.
2. Permita "instalar de fontes desconhecidas" no Android.
3. Abra o app → crie um novo cofre ou restaure uma existente.
4. Configure sua cota de espaço cedido e, se quiser rede WAN completa, o endereço do servidor de sinalização em **Config → Rede**.

> **Guarde sua seed phrase em papel, fora do celular.** Ela é a única forma de acesso à sua carteira e aos seus arquivos — o Vagalun não tem "recuperar senha".



## ⚠️ Aviso

Projeto em **desenvolvimento ativo, rodando em Devnet**. Não deposite fundos reais nem armazene dados de produção até o contrato passar por auditoria e o deploy em mainnet ser confirmado.
