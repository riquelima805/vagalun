// Esqueleto de smart contract Anchor pro "mercado de armazenamento" — versão completa
// com vault por arquivo, prova de posse (PoR por amostragem) e pagamento por época (dia).
//
// ATENÇÃO — ISSO CONTINUA SENDO UM PONTO DE PARTIDA, NÃO PRODUÇÃO:
//   - Não foi compilado/testado neste ambiente (sem toolchain Solana/Anchor disponível aqui).
//     A API de manipulação direta de lamports (`try_borrow_mut_lamports`) e a assinatura
//     exata de alguns helpers do Anchor podem ter mudado de nome entre versões — confira
//     contra a versão do `anchor-lang` que você instalar antes de rodar `anchor build`.
//   - Não foi auditado. Contrato mexendo em dinheiro real PRECISA de auditoria antes de mainnet.
//   - "Prova de posse" aqui NÃO é zero-knowledge de verdade (ver seção mais abaixo). É uma
//     Proof-of-Retrievability por amostragem: barata de gerar num celular, verificável
//     on-chain a custo baixo, mas REVELA um pedacinho (chunk) do shard a cada prova — não
//     é sigilosa como um SNARK seria. Pra um MVP isso é uma troca razoável; ZK real fica
//     de roadmap (fase 2/3), documentado no TODO da função de verificação.
//   - O modelo de confiança dos `Placement`/`FreeContribution` (quem registra é o DONO do
//     arquivo, não o provider) é seguro quanto a ROUBO DE FUNDOS: ninguém recebe nada sem
//     provar posse de verdade. Mas é vulnerável a GRIEFING: um dono desonesto pode registrar
//     um `merkle_root` errado, e aí o provider (mesmo guardando os bytes certinho) nunca
//     consegue gerar uma prova que bata, e não recebe. Mitigação futura: provider co-assinar
//     o registro confirmando que aceitou aquele commitment antes de guardar. Não implementado
//     aqui de propósito, pra não inflar demais o escopo do MVP.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;

declare_id!("11111111111111111111111111111111111111111"); // troque pelo Program ID real após `anchor deploy`

pub const FREE_TIER_BYTES: u64 = 500 * 1024 * 1024; // 500MB, igual ao combinado na conversa
pub const SECONDS_PER_EPOCH: i64 = 86_400; // 1 "dia" de rede = 1 época de cobrança/prova
pub const BYTES_PER_GB: u64 = 1024 * 1024 * 1024;

#[program]
pub mod storage_market {
    use super::*;

    // ============================================================
    // Configuração global do mercado (preço por GB/dia) — só o admin mexe.
    // ============================================================

    pub fn init_market_config(ctx: Context<InitMarketConfig>, price_lamports_per_gb_day: u64) -> Result<()> {
        let config = &mut ctx.accounts.market_config;
        config.admin = ctx.accounts.admin.key();
        config.price_lamports_per_gb_day = price_lamports_per_gb_day;
        Ok(())
    }

    pub fn update_price(ctx: Context<UpdateMarketConfig>, new_price_lamports_per_gb_day: u64) -> Result<()> {
        require_keys_eq!(ctx.accounts.admin.key(), ctx.accounts.market_config.admin, ErrorCode::Unauthorized);
        ctx.accounts.market_config.price_lamports_per_gb_day = new_price_lamports_per_gb_day;
        Ok(())
    }

    // ============================================================
    // Conta de usuário — tier free (bytes que dá pra usar sem pagar nada).
    // ============================================================

    pub fn init_account(ctx: Context<InitAccount>) -> Result<()> {
        let account = &mut ctx.accounts.user_account;
        account.owner = ctx.accounts.owner.key();
        account.tier_bytes = FREE_TIER_BYTES;
        account.bytes_used = 0;
        Ok(())
    }

    /// Pagamento avulso por mais tier (bytes que o usuário pode usar sem passar por vault
    /// de arquivo — pense nisso como "plano mensal legado"). O pagamento de verdade por
    /// armazenamento de arquivo específico usa `create_file_vault`, não isso aqui.
    pub fn purchase_tier(ctx: Context<PurchaseTier>, extra_gb: u64) -> Result<()> {
        let config = &ctx.accounts.market_config;
        // preço "flat" pra tier avulso = 30 dias de GB/dia, só de referência —
        // ajuste essa fórmula quando definir o plano de verdade.
        let cost = config
            .price_lamports_per_gb_day
            .checked_mul(30)
            .and_then(|v| v.checked_mul(extra_gb))
            .ok_or(ErrorCode::MathOverflow)?;

        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, cost)?;

        let account = &mut ctx.accounts.user_account;
        account.tier_bytes = account
            .tier_bytes
            .checked_add(extra_gb.checked_mul(BYTES_PER_GB).ok_or(ErrorCode::MathOverflow)?)
            .ok_or(ErrorCode::MathOverflow)?;
        Ok(())
    }

    // ============================================================
    // Vault por arquivo — o dono deposita antecipado (escrow), o dinheiro fica TRANCADO
    // no vault (não vai direto pro provider), e só sai conforme provas válidas chegam.
    // ============================================================

    /// `file_id`: mesmo id que o app já gera em KeyManager.fileIdFor (sha256 hex) — converta
    /// os primeiros 32 bytes do hex pra `[u8; 32]` do lado do cliente antes de chamar isso.
    /// `shard_size_bytes`: tamanho de CADA shard (todos iguais no Reed-Solomon), já calculado
    /// pelo `ReedSolomon.encode` no cliente — o contrato cobra por shard/dia, não pelo
    /// arquivo inteiro, porque cada provider só guarda 1 shard e é isso que ele prova.
    pub fn create_file_vault(
        ctx: Context<CreateFileVault>,
        file_id: [u8; 32],
        shard_size_bytes: u64,
        k: u8,
        n: u8,
        days: u32,
    ) -> Result<()> {
        require!(k >= 1 && n >= k, ErrorCode::InvalidRedundancyParams);
        require!(days >= 1, ErrorCode::InvalidRedundancyParams);

        let config = &ctx.accounts.market_config;
        let gb_ceil = ((shard_size_bytes + BYTES_PER_GB - 1) / BYTES_PER_GB).max(1);
        let rate_per_shard_per_epoch = config
            .price_lamports_per_gb_day
            .checked_mul(gb_ceil)
            .ok_or(ErrorCode::MathOverflow)?;
        let total_cost = rate_per_shard_per_epoch
            .checked_mul(n as u64)
            .and_then(|v| v.checked_mul(days as u64))
            .ok_or(ErrorCode::MathOverflow)?;

        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.file_vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, total_cost)?;

        let vault = &mut ctx.accounts.file_vault;
        vault.owner = ctx.accounts.owner.key();
        vault.file_id = file_id;
        vault.shard_size_bytes = shard_size_bytes;
        vault.k = k;
        vault.n = n;
        vault.days = days;
        vault.rate_per_shard_per_epoch = rate_per_shard_per_epoch;
        vault.balance_lamports = total_cost;
        vault.created_at_unix = Clock::get()?.unix_timestamp;
        vault.active = true;
        Ok(())
    }

    /// Registra QUEM guarda o shard `shard_index` desse arquivo + o commitment (raiz Merkle)
    /// contra o qual as provas futuras vão ser checadas. Assinado pelo DONO do arquivo (é
    /// ele quem sabe, via GossipRegistry/StorageClient, onde cada shard foi distribuído).
    /// Registrar aqui não libera nenhum fundo — só o `submit_paid_claim` com prova válida faz isso.
    pub fn register_placement(ctx: Context<RegisterPlacement>, shard_index: u8, merkle_root: [u8; 32]) -> Result<()> {
        require!((shard_index as u8) < ctx.accounts.file_vault.n, ErrorCode::InvalidRedundancyParams);
        let placement = &mut ctx.accounts.placement;
        placement.file_vault = ctx.accounts.file_vault.key();
        placement.shard_index = shard_index;
        placement.provider = ctx.accounts.provider.key();
        placement.merkle_root = merkle_root;
        placement.last_claimed_epoch = -1;
        Ok(())
    }

    /// Chamado pelo PROVIDER pra cobrar 1 época (1 dia) de armazenamento do shard dele,
    /// mandando uma prova de posse por amostragem (ver `verify_merkle_proof` mais abaixo).
    /// Só paga 1x por época por shard — tentar de novo na mesma época falha (EpochAlreadyClaimed).
    pub fn submit_paid_claim(
        ctx: Context<SubmitPaidClaim>,
        chunk_index: u32,
        chunk_hash: [u8; 32],
        merkle_proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        require_keys_eq!(ctx.accounts.provider.key(), ctx.accounts.placement.provider, ErrorCode::NotAssignedProvider);
        require!(ctx.accounts.file_vault.active, ErrorCode::VaultInactive);

        let now = Clock::get()?.unix_timestamp;
        let epoch = (now - ctx.accounts.file_vault.created_at_unix) / SECONDS_PER_EPOCH;
        require!(epoch >= 0 && epoch < ctx.accounts.file_vault.days as i64, ErrorCode::EpochOutOfRange);
        require!(epoch > ctx.accounts.placement.last_claimed_epoch, ErrorCode::EpochAlreadyClaimed);

        require!(
            verify_merkle_proof(chunk_index, chunk_hash, &merkle_proof) == ctx.accounts.placement.merkle_root,
            ErrorCode::InvalidProof
        );

        let payout = ctx.accounts.file_vault.rate_per_shard_per_epoch;
        require!(ctx.accounts.file_vault.balance_lamports >= payout, ErrorCode::InsufficientVaultBalance);

        // Manipulação direta de lamports (em vez de CPI transfer): o vault é uma PDA do
        // NOSSO programa, então dá pra debitar dele diretamente; creditar o provider (uma
        // wallet comum) também é permitido diretamente — só DÉBITO exige ser dono da conta.
        **ctx.accounts.file_vault.to_account_info().try_borrow_mut_lamports()? -= payout;
        **ctx.accounts.provider.to_account_info().try_borrow_mut_lamports()? += payout;

        let vault = &mut ctx.accounts.file_vault;
        vault.balance_lamports = vault.balance_lamports.checked_sub(payout).ok_or(ErrorCode::MathOverflow)?;

        let placement = &mut ctx.accounts.placement;
        placement.last_claimed_epoch = epoch;

        let record = &mut ctx.accounts.provider_record;
        record.provider = ctx.accounts.provider.key();
        record.total_shards_proven = record.total_shards_proven.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
        record.last_proof_unix = now;
        Ok(())
    }

    /// O dono do arquivo pode sacar de volta o que ainda não foi reclamado pelos providers
    /// (ex: cancelou antes do prazo). Como `balance_lamports` só diminui quando um claim
    /// válido acontece, o que sobra é exatamente o não-gasto — não precisa de conta de dias
    /// pra fazer proporção. Ao zerar o saldo, marca o vault inativo: os providers percebem
    /// que não tem mais fundo (claims novos falham com VaultInactive) e decidem localmente
    /// apagar o shard pra liberar espaço, igual combinado na conversa de design.
    pub fn withdraw_unused(ctx: Context<WithdrawUnused>) -> Result<()> {
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.file_vault.owner, ErrorCode::Unauthorized);
        require!(ctx.accounts.file_vault.active, ErrorCode::VaultInactive);

        let remaining = ctx.accounts.file_vault.balance_lamports;
        **ctx.accounts.file_vault.to_account_info().try_borrow_mut_lamports()? -= remaining;
        **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += remaining;

        let vault = &mut ctx.accounts.file_vault;
        vault.balance_lamports = 0;
        vault.active = false;
        Ok(())
    }

    // ============================================================
    // Tier free — "quem cede espaço ganha espaço": provider guarda shard de outra pessoa
    // SEM vault pago por trás, e em troca ganha bytes de tier free na PRÓPRIA conta.
    // ============================================================

    /// Igual ao `register_placement`, mas pro caso sem pagamento em SOL — ainda assinado
    /// pelo dono do conteúdo (é ele quem sabe o commitment real do shard).
    pub fn register_free_contribution(
        ctx: Context<RegisterFreeContribution>,
        content_id: [u8; 32],
        shard_index: u8,
        shard_size_bytes: u64,
        merkle_root: [u8; 32],
    ) -> Result<()> {
        let contribution = &mut ctx.accounts.contribution;
        contribution.provider = ctx.accounts.provider.key();
        contribution.content_id = content_id;
        contribution.shard_index = shard_index;
        contribution.shard_size_bytes = shard_size_bytes;
        contribution.merkle_root = merkle_root;
        contribution.registered_at_unix = Clock::get()?.unix_timestamp;
        contribution.last_claimed_epoch = -1;
        Ok(())
    }

    /// Prova diária de posse pro caso free-tier — não move SOL nenhum, só credita
    /// `tier_bytes` na conta do PRÓPRIO provider.
    ///
    /// ATENÇÃO (simplificação intencional pro MVP, documentada de propósito): o crédito é
    /// CUMULATIVO por época provada, sem decair. Isso é explorável em teoria (guardar 1
    /// shard pequeno pra sempre e provar todo dia faz `tier_bytes` crescer sem limite). O
    /// jeito certo em produção seria o crédito refletir CAPACIDADE ATIVA sendo contribuída
    /// agora (ex: recalcular com base nas contribuições vivas, não na soma histórica de
    /// provas) — deixado simples aqui de propósito, é TODO de roadmap, não bug esquecido.
    pub fn report_free_tier_proof(
        ctx: Context<ReportFreeTierProof>,
        chunk_index: u32,
        chunk_hash: [u8; 32],
        merkle_proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        require_keys_eq!(ctx.accounts.provider.key(), ctx.accounts.contribution.provider, ErrorCode::NotAssignedProvider);

        let now = Clock::get()?.unix_timestamp;
        let epoch = (now - ctx.accounts.contribution.registered_at_unix) / SECONDS_PER_EPOCH;
        require!(epoch > ctx.accounts.contribution.last_claimed_epoch, ErrorCode::EpochAlreadyClaimed);

        require!(
            verify_merkle_proof(chunk_index, chunk_hash, &merkle_proof) == ctx.accounts.contribution.merkle_root,
            ErrorCode::InvalidProof
        );

        let shard_size_bytes = ctx.accounts.contribution.shard_size_bytes;

        let contribution = &mut ctx.accounts.contribution;
        contribution.last_claimed_epoch = epoch;

        let user_account = &mut ctx.accounts.provider_user_account;
        user_account.tier_bytes = user_account
            .tier_bytes
            .checked_add(shard_size_bytes)
            .ok_or(ErrorCode::MathOverflow)?;

        let record = &mut ctx.accounts.provider_record;
        record.provider = ctx.accounts.provider.key();
        record.total_shards_proven = record.total_shards_proven.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
        record.last_proof_unix = now;
        Ok(())
    }
}

// ============================================================
// Verificação da prova de posse por amostragem (Merkle).
//
// Como funciona: no upload, o app monta uma árvore Merkle sobre pedaços (chunks) do
// shard e manda só a RAIZ pro `register_placement`/`register_free_contribution` (32
// bytes, barato). Quando desafiado, o provider manda o hash de UM chunk específico + o
// caminho até a raiz (`merkle_proof`); o contrato recomputa a raiz a partir disso e
// compara com a que foi commitada — só bate se o provider realmente tem aquele chunk.
//
// TODO (roadmap fase 2/3): trocar por um SNARK de posse de verdade (zero-knowledge —
// não revela nem o hash do chunk, só "eu tenho isso"). Essa troca não muda a interface
// pública das instruções acima (ainda seria "manda uma prova, contrato verifica, paga
// se bater") — só troca o que tem dentro de `merkle_proof`/`verify_merkle_proof` por uma
// verificação de SNARK. Ver conversa de design sobre custo de gerar SNARK num celular.
fn verify_merkle_proof(leaf_index: u32, leaf_hash: [u8; 32], proof: &[[u8; 32]]) -> [u8; 32] {
    let mut hash = leaf_hash;
    let mut index = leaf_index;
    for sibling in proof {
        hash = if index % 2 == 0 {
            keccak::hashv(&[&hash, sibling]).0
        } else {
            keccak::hashv(&[sibling, &hash]).0
        };
        index /= 2;
    }
    hash
}

// ============================================================
// Contas (dados persistidos)
// ============================================================

#[account]
pub struct MarketConfig {
    pub admin: Pubkey,
    pub price_lamports_per_gb_day: u64,
}

#[account]
pub struct UserAccount {
    pub owner: Pubkey,
    pub tier_bytes: u64,
    pub bytes_used: u64,
}

/// Vault de escrow de UM arquivo — dinheiro pré-pago, liberado aos poucos conforme provas.
#[account]
pub struct FileVault {
    pub owner: Pubkey,
    pub file_id: [u8; 32],
    pub shard_size_bytes: u64,
    pub k: u8,
    pub n: u8,
    pub days: u32,
    pub rate_per_shard_per_epoch: u64,
    pub balance_lamports: u64,
    pub created_at_unix: i64,
    pub active: bool,
}

/// Quem guarda o shard `shard_index` de um `FileVault` — caminho PAGO.
#[account]
pub struct Placement {
    pub file_vault: Pubkey,
    pub shard_index: u8,
    pub provider: Pubkey,
    pub merkle_root: [u8; 32],
    pub last_claimed_epoch: i64,
}

/// Equivalente ao `Placement`, mas pro caminho FREE-TIER (sem vault pago por trás).
#[account]
pub struct FreeContribution {
    pub provider: Pubkey,
    pub content_id: [u8; 32],
    pub shard_index: u8,
    pub shard_size_bytes: u64,
    pub merkle_root: [u8; 32],
    pub registered_at_unix: i64,
    pub last_claimed_epoch: i64,
}

#[account]
pub struct ProviderRecord {
    pub provider: Pubkey,
    pub total_shards_proven: u64,
    pub last_proof_unix: i64,
}

// ============================================================
// Contextos de conta (accounts) de cada instrução
// ============================================================

#[derive(Accounts)]
pub struct InitMarketConfig<'info> {
    #[account(init, payer = admin, space = 8 + 32 + 8, seeds = [b"market_config"], bump)]
    pub market_config: Account<'info, MarketConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateMarketConfig<'info> {
    #[account(mut, seeds = [b"market_config"], bump)]
    pub market_config: Account<'info, MarketConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitAccount<'info> {
    #[account(init, payer = owner, space = 8 + 32 + 8 + 8, seeds = [b"user", owner.key().as_ref()], bump)]
    pub user_account: Account<'info, UserAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PurchaseTier<'info> {
    #[account(mut, has_one = owner, seeds = [b"user", owner.key().as_ref()], bump)]
    pub user_account: Account<'info, UserAccount>,
    #[account(seeds = [b"market_config"], bump)]
    pub market_config: Account<'info, MarketConfig>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: conta simples do tesouro do protocolo, só recebe lamports
    #[account(mut)]
    pub treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(file_id: [u8; 32])]
pub struct CreateFileVault<'info> {
    #[account(
        init, payer = owner, space = 8 + 32 + 32 + 8 + 1 + 1 + 4 + 8 + 8 + 8 + 1,
        seeds = [b"vault", file_id.as_ref()], bump
    )]
    pub file_vault: Account<'info, FileVault>,
    #[account(seeds = [b"market_config"], bump)]
    pub market_config: Account<'info, MarketConfig>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(shard_index: u8)]
pub struct RegisterPlacement<'info> {
    #[account(
        init, payer = owner, space = 8 + 32 + 1 + 32 + 32 + 8,
        seeds = [b"placement", file_vault.key().as_ref(), &[shard_index]], bump
    )]
    pub placement: Account<'info, Placement>,
    #[account(mut, has_one = owner)]
    pub file_vault: Account<'info, FileVault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: só a pubkey do provider é usada como referência, ele não precisa assinar aqui
    /// (ver ressalva de griefing no topo do arquivo)
    pub provider: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitPaidClaim<'info> {
    #[account(mut)]
    pub placement: Account<'info, Placement>,
    #[account(mut, address = placement.file_vault)]
    pub file_vault: Account<'info, FileVault>,
    #[account(
        init_if_needed, payer = provider, space = 8 + 32 + 8 + 8,
        seeds = [b"provider_record", provider.key().as_ref()], bump
    )]
    pub provider_record: Account<'info, ProviderRecord>,
    #[account(mut)]
    pub provider: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawUnused<'info> {
    #[account(mut)]
    pub file_vault: Account<'info, FileVault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(content_id: [u8; 32], shard_index: u8)]
pub struct RegisterFreeContribution<'info> {
    #[account(
        init, payer = owner, space = 8 + 32 + 32 + 1 + 8 + 32 + 8 + 8,
        seeds = [b"free", provider.key().as_ref(), content_id.as_ref(), &[shard_index]], bump
    )]
    pub contribution: Account<'info, FreeContribution>,
    #[account(mut)]
    pub owner: Signer<'info>, // dono do conteúdo que está sendo guardado de graça
    /// CHECK: só a pubkey do provider é usada como referência
    pub provider: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReportFreeTierProof<'info> {
    #[account(mut)]
    pub contribution: Account<'info, FreeContribution>,
    #[account(mut, seeds = [b"user", provider.key().as_ref()], bump)]
    pub provider_user_account: Account<'info, UserAccount>,
    #[account(
        init_if_needed, payer = provider, space = 8 + 32 + 8 + 8,
        seeds = [b"provider_record", provider.key().as_ref()], bump
    )]
    pub provider_record: Account<'info, ProviderRecord>,
    #[account(mut)]
    pub provider: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("overflow numérico")]
    MathOverflow,
    #[msg("não autorizado")]
    Unauthorized,
    #[msg("parâmetros de redundância inválidos (K/N/dias)")]
    InvalidRedundancyParams,
    #[msg("essa conta não é o provider designado pra esse shard")]
    NotAssignedProvider,
    #[msg("vault inativo (sem fundos ou já sacado)")]
    VaultInactive,
    #[msg("época fora do intervalo do vault (antes do início ou depois do prazo pago)")]
    EpochOutOfRange,
    #[msg("essa época já foi reclamada — só dá pra provar 1x por dia por shard")]
    EpochAlreadyClaimed,
    #[msg("prova de posse inválida (raiz Merkle não bate)")]
    InvalidProof,
    #[msg("saldo insuficiente no vault pra pagar essa época")]
    InsufficientVaultBalance,
}
