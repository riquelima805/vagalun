use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_lang::solana_program::pubkey;
use anchor_lang::system_program::{transfer, Transfer};

pub mod site_registry;
pub use site_registry::*;

declare_id!("11111111111111111111111111111111111111111"); 

pub const SECONDS_PER_EPOCH: i64 = 86_400; 
pub const BYTES_PER_GB: u64 = 1024 * 1024 * 1024;

pub const EPOCH_SEED: &[u8] = b"epoch_root";
pub const CLAIM_SEED: &[u8] = b"claim";


// endereço carteira adm
pub const ADMIN: Pubkey = pubkey!("DDE7RZCCbipWuBGwZLYszBQuMxvDSEF59225YoFzkFba");

#[program]
pub mod storage_market {
    use super::*;

  
    pub fn init_market_config(ctx: Context<InitMarketConfig>, price_lamports_per_gb_day: u64) -> Result<()> {
        require_keys_eq!(ctx.accounts.admin.key(), ADMIN, ErrorCode::Unauthorized);
        let config = &mut ctx.accounts.market_config;
        config.admin = ctx.accounts.admin.key();
        config.price_lamports_per_gb_day = price_lamports_per_gb_day;
        emit!(MarketConfigChanged {
            admin: config.admin,
            price: price_lamports_per_gb_day,
        });
        Ok(())
    }

    pub fn update_price(ctx: Context<UpdateMarketConfig>, new_price_lamports_per_gb_day: u64) -> Result<()> {
        require_keys_eq!(ctx.accounts.admin.key(), ctx.accounts.market_config.admin, ErrorCode::Unauthorized);
        ctx.accounts.market_config.price_lamports_per_gb_day = new_price_lamports_per_gb_day;
        emit!(MarketConfigChanged {
            admin: ctx.accounts.market_config.admin,
            price: new_price_lamports_per_gb_day,
        });
        Ok(())
    }

 

    // ---- Registro de sites on-chain (ver site_registry.rs) ----
    pub fn register_site(ctx: Context<RegisterSite>, domain: String, owner: Pubkey) -> Result<()> {
        site_registry::handle_register_site(ctx, domain, owner)
    }

    pub fn update_site(ctx: Context<UpdateSite>, manifest_hash: [u8; 32], version: u64) -> Result<()> {
        site_registry::handle_update_site(ctx, manifest_hash, version)
    }

    pub fn transfer_site(ctx: Context<TransferSite>, new_owner: Pubkey) -> Result<()> {
        site_registry::handle_transfer_site(ctx, new_owner)
    }

    pub fn init_account(ctx: Context<InitAccount>) -> Result<()> {
        let account = &mut ctx.accounts.user_account;
        account.owner = ctx.accounts.owner.key();
        account.bytes_used = 0;
        Ok(())
    }

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
            Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.file_vault.to_account_info(),
            },
        );
        transfer(cpi_context, total_cost)?;

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

        emit!(VaultCreated {
            file_vault: vault.key(),
            owner: vault.owner,
            file_id,
            total_cost,
            days,
        });
        Ok(())
    }

  
    pub fn register_placement(
        ctx: Context<RegisterPlacement>,
        shard_index: u8,
        merkle_root: [u8; 32],
        total_chunks: u32,
    ) -> Result<()> {
        require!(ctx.accounts.file_vault.active, ErrorCode::VaultInactive);
        require!((shard_index as u8) < ctx.accounts.file_vault.n, ErrorCode::InvalidRedundancyParams);
        // total_chunks > 1 é exigido porque com 1 único chunk a "árvore"
        // vira só a folha e o desafio deixa de ter qualquer sentido —
        // nesse caso o dado deveria ser tratado fora do esquema Merkle.
        require!(total_chunks > 1, ErrorCode::InvalidChunkCount);
        let placement = &mut ctx.accounts.placement;
        placement.file_vault = ctx.accounts.file_vault.key();
        placement.shard_index = shard_index;
        placement.provider = ctx.accounts.provider.key();
        placement.merkle_root = merkle_root;
        placement.last_claimed_epoch = -1;
        placement.total_chunks = total_chunks;
        emit!(PlacementRegistered {
            file_vault: placement.file_vault,
            shard_index,
            provider: placement.provider,
        });
        Ok(())
    }

   
    pub fn submit_paid_claim(
        ctx: Context<SubmitPaidClaim>,
        chunk_hash: [u8; 32],
        merkle_proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        require!(ctx.accounts.file_vault.active, ErrorCode::VaultInactive);

        // Época corrente do vault, a partir da criação.
        let now = Clock::get()?.unix_timestamp;
        let epoch = (now - ctx.accounts.file_vault.created_at_unix) / SECONDS_PER_EPOCH;
        require!(
            epoch >= 0 && epoch < ctx.accounts.file_vault.days as i64,
            ErrorCode::EpochOutOfRange
        );
        require!(
            epoch > ctx.accounts.placement.last_claimed_epoch,
            ErrorCode::EpochAlreadyClaimed
        );

        // --- Desafio determinístico (não escolhido pelo provider) ---
        // O índice do chunk que precisa ser provado nesta época é derivado
        // on-chain a partir de dados que o provider não controla (chave do
        // vault, shard, época e o slot atual). Isso impede que o provider
        // sempre "prove" o mesmo chunk barato de guardar, todo epoch —
        // ele é forçado a ter o shard inteiro disponível, pois não sabe
        // de antemão qual chunk será exigido.
        let total_chunks = ctx.accounts.placement.total_chunks;
        require!(total_chunks > 1, ErrorCode::InvalidChunkCount);
        let clock = Clock::get()?;
        let challenge_seed = keccak::hashv(&[
            ctx.accounts.file_vault.key().as_ref(),
            &ctx.accounts.placement.shard_index.to_le_bytes(),
            &epoch.to_le_bytes(),
            &clock.slot.to_le_bytes(),
        ])
        .0;
        let chunk_index = u32::from_le_bytes(challenge_seed[0..4].try_into().unwrap()) % total_chunks;

        // A prova nunca pode ser vazia: prova vazia faz a raiz calculada
        // ser igual ao próprio chunk_hash informado, e como o merkle_root
        // é dado público, isso permitiria "provar" posse sem nenhum dado
        // real. Com total_chunks > 1, uma prova válida sempre tem pelo
        // menos 1 nível.
        require!(!merkle_proof.is_empty(), ErrorCode::InvalidProof);

        // Prova de posse do chunk contra a merkle_root registrada no placement.
        let computed_root = verify_merkle_proof(chunk_index, chunk_hash, &merkle_proof);
        require!(
            computed_root == ctx.accounts.placement.merkle_root,
            ErrorCode::InvalidProof
        );

        let payout = ctx.accounts.file_vault.rate_per_shard_per_epoch;
        require!(
            ctx.accounts.file_vault.balance_lamports >= payout,
            ErrorCode::InsufficientVaultBalance
        );

        // Trava a época (double-claim) e debita o saldo controlado do vault
        // ANTES de mover os lamports (efeitos antes da interação).
        let placement = &mut ctx.accounts.placement;
        placement.last_claimed_epoch = epoch;

        let vault = &mut ctx.accounts.file_vault;
        vault.balance_lamports = vault
            .balance_lamports
            .checked_sub(payout)
            .ok_or(ErrorCode::MathOverflow)?;

        // file_vault é uma conta de dados (dono = este programa, criada via
        // `init`), não uma SystemAccount — o CPI de transfer do System
        // Program EXIGE que a conta de origem seja dona do System Program,
        // senão retorna `ExternalAccountLamportSpend` e a tx reverte sempre.
        // Por isso o pagamento sai por manipulação direta de lamports.
        **ctx.accounts.file_vault.to_account_info().try_borrow_mut_lamports()? -= payout;
        **ctx.accounts.provider.to_account_info().try_borrow_mut_lamports()? += payout;

        let record = &mut ctx.accounts.provider_record;
        record.provider = ctx.accounts.provider.key();
        record.total_shards_proven = record.total_shards_proven.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
        record.last_proof_unix = now;

        emit!(PaidClaim {
            file_vault: ctx.accounts.file_vault.key(),
            shard_index: ctx.accounts.placement.shard_index,
            provider: ctx.accounts.provider.key(),
            epoch,
            payout,
        });
        Ok(())
    }

    
    pub fn withdraw_unused(ctx: Context<WithdrawUnused>) -> Result<()> {
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.file_vault.owner, ErrorCode::Unauthorized);
        require!(ctx.accounts.file_vault.active, ErrorCode::VaultInactive);

        let now = Clock::get()?.unix_timestamp;
        let elapsed = ((now - ctx.accounts.file_vault.created_at_unix) / SECONDS_PER_EPOCH)
            .clamp(0, ctx.accounts.file_vault.days as i64);

        if elapsed >= ctx.accounts.file_vault.days as i64 {
            // Período contratado já correu inteiro: fecha de vez e devolve
            // o que sobrar (inclui épocas passadas que nenhum provider
            // reclamou a tempo).
            let file_vault_key = ctx.accounts.file_vault.key();
            let owner_key = ctx.accounts.owner.key();
            ctx.accounts.file_vault.close(ctx.accounts.owner.to_account_info())?;

            emit!(VaultClosed {
                file_vault: file_vault_key,
                owner: owner_key,
            });
        } else {
            // Ainda dentro do período: só libera a parte referente às
            // épocas futuras (ainda não trabalhadas). O "piso" abaixo é
            // calculado a partir do tempo decorrido, não do saldo atual —
            // isso é o que impede uma segunda chamada de drenar de novo o
            // que já ficou retido pras épocas passadas (double-withdraw).
            let floor = ctx.accounts.file_vault.rate_per_shard_per_epoch
                .checked_mul(ctx.accounts.file_vault.n as u64)
                .and_then(|v| v.checked_mul(elapsed as u64))
                .ok_or(ErrorCode::MathOverflow)?;
            let refundable = ctx.accounts.file_vault.balance_lamports.saturating_sub(floor);
            require!(refundable > 0, ErrorCode::NothingToWithdraw);

            **ctx.accounts.file_vault.to_account_info().try_borrow_mut_lamports()? -= refundable;
            **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += refundable;

            let vault = &mut ctx.accounts.file_vault;
            vault.balance_lamports = vault
                .balance_lamports
                .checked_sub(refundable)
                .ok_or(ErrorCode::MathOverflow)?;

            let file_vault_key = vault.key();
            let remaining_epochs = vault.days as i64 - elapsed;
            emit!(VaultUnusedWithdrawn {
                file_vault: file_vault_key,
                owner: ctx.accounts.owner.key(),
                amount: refundable,
                remaining_epochs,
            });
        }
        Ok(())
    }


    pub fn publish_epoch_root(
        ctx: Context<PublishEpochRoot>,
        epoch_id: u64,
        merkle_root: [u8; 32],
        total_lamports: u64,
    ) -> Result<()> {
        require_keys_eq!(ctx.accounts.admin.key(), ADMIN, ErrorCode::Unauthorized);

        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer { from: ctx.accounts.admin.to_account_info(), to: ctx.accounts.epoch_root.to_account_info() },
        );
        transfer(cpi_context, total_lamports)?;

        let epoch = &mut ctx.accounts.epoch_root;
        epoch.epoch_id = epoch_id;
        epoch.merkle_root = merkle_root;
        epoch.total_lamports = total_lamports;
        epoch.claimed_lamports = 0;
        epoch.published_at_unix = Clock::get()?.unix_timestamp;
        epoch.bump = ctx.bumps.epoch_root;

        emit!(EpochRootPublished { epoch_id, merkle_root, total_lamports });
        Ok(())
    }

    pub fn claim_epoch(
        ctx: Context<ClaimEpoch>,
        epoch_id: u64,
        amount: u64,
        merkle_proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let leaf = keccak::hashv(&[
            ctx.accounts.claimant.key.as_ref(),
            &amount.to_le_bytes(),
            &epoch_id.to_le_bytes(),
        ]).0;
        let computed_root = verify_merkle_proof_sorted(leaf, &merkle_proof);
        require!(computed_root == ctx.accounts.epoch_root.merkle_root, ErrorCode::InvalidProof);

        let epoch = &mut ctx.accounts.epoch_root;
        epoch.claimed_lamports = epoch.claimed_lamports.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
        require!(epoch.claimed_lamports <= epoch.total_lamports, ErrorCode::InsufficientVaultBalance);

        // epoch_root é conta de dados (dono = este programa, criada via
        // `init`), não uma SystemAccount — o mesmo problema do
        // submit_paid_claim: CPI de transfer do System Program reverteria
        // sempre. Pagamento por manipulação direta de lamports.
        **ctx.accounts.epoch_root.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.claimant.to_account_info().try_borrow_mut_lamports()? += amount;

        let receipt = &mut ctx.accounts.claim_receipt;
        receipt.epoch_id = epoch_id;
        receipt.claimant = ctx.accounts.claimant.key();
        receipt.amount = amount;
        receipt.claimed_at_unix = Clock::get()?.unix_timestamp;

        emit!(EpochClaimed { epoch_id, claimant: receipt.claimant, amount });
        Ok(())
    }
}



// Prefixos de domínio (à la RFC 6962 / OpenZeppelin MerkleProof) para
// impedir que um nó interno da árvore seja reapresentado como se fosse
// uma folha (ataque de 2ª pré-imagem em árvores Merkle "ingênuas").
const MERKLE_LEAF_PREFIX: u8 = 0x00;
const MERKLE_NODE_PREFIX: u8 = 0x01;

fn verify_merkle_proof(leaf_index: u32, leaf_hash: [u8; 32], proof: &[[u8; 32]]) -> [u8; 32] {
    assert!(proof.len() <= 32, "Proof too long");
    // A folha é hasheada com prefixo próprio antes de entrar na árvore,
    // então nenhum hash de nó interno (prefixo 0x01) pode colidir com uma
    // folha válida (prefixo 0x00).
    let mut hash = keccak::hashv(&[&[MERKLE_LEAF_PREFIX], &leaf_hash]).0;
    let mut index = leaf_index;
    for sibling in proof {
        hash = if index % 2 == 0 {
            keccak::hashv(&[&[MERKLE_NODE_PREFIX], &hash, sibling]).0
        } else {
            keccak::hashv(&[&[MERKLE_NODE_PREFIX], sibling, &hash]).0
        };
        index /= 2;
    }
    hash
}

// Usada só pro Bloco 2 (epoch payout), cujas folhas (pubkey/amount/epoch_id)
// não têm índice — por isso a combinação é por ordem de hash (menor
// primeiro), igual ao merkle.js do backend (hashPair). NÃO substitui a
// verify_merkle_proof de índice acima, que continua servindo pro Bloco 1
// (prova de chunk de shard, onde o índice é natural).
fn verify_merkle_proof_sorted(leaf: [u8; 32], proof: &[[u8; 32]]) -> [u8; 32] {
    assert!(proof.len() <= 32, "Proof too long");
    let mut hash = keccak::hashv(&[&[MERKLE_LEAF_PREFIX], &leaf]).0;
    for sibling in proof {
        hash = if hash <= *sibling {
            keccak::hashv(&[&[MERKLE_NODE_PREFIX], &hash, sibling]).0
        } else {
            keccak::hashv(&[&[MERKLE_NODE_PREFIX], sibling, &hash]).0
        };
    }
    hash
}


#[event]
pub struct MarketConfigChanged {
    pub admin: Pubkey,
    pub price: u64,
}

#[event]
pub struct VaultCreated {
    pub file_vault: Pubkey,
    pub owner: Pubkey,
    pub file_id: [u8; 32],
    pub total_cost: u64,
    pub days: u32,
}

#[event]
pub struct PlacementRegistered {
    pub file_vault: Pubkey,
    pub shard_index: u8,
    pub provider: Pubkey,
}

#[event]
pub struct PaidClaim {
    pub file_vault: Pubkey,
    pub shard_index: u8,
    pub provider: Pubkey,
    pub epoch: i64,
    pub payout: u64,
}

#[event]
pub struct VaultClosed {
    pub file_vault: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct VaultUnusedWithdrawn {
    pub file_vault: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub remaining_epochs: i64,
}

#[event]
pub struct EpochRootPublished {
    pub epoch_id: u64,
    pub merkle_root: [u8; 32],
    pub total_lamports: u64,
}

#[event]
pub struct EpochClaimed {
    pub epoch_id: u64,
    pub claimant: Pubkey,
    pub amount: u64,
}



#[account]
pub struct MarketConfig {
    pub admin: Pubkey,
    pub price_lamports_per_gb_day: u64,
}

#[account]
pub struct UserAccount {
    pub owner: Pubkey,
    pub bytes_used: u64,
}

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

#[account]
pub struct Placement {
    pub file_vault: Pubkey,
    pub shard_index: u8,
    pub provider: Pubkey,
    pub merkle_root: [u8; 32],
    pub last_claimed_epoch: i64,
    // Nº total de chunks/folhas da árvore Merkle deste shard. Necessário
    // para o servidor (contrato) poder sortear um chunk_index válido no
    // desafio de submit_paid_claim, em vez de confiar no índice que o
    // provider mandaria escolher.
    pub total_chunks: u32,
}

#[account]
pub struct EpochRoot {
    pub epoch_id: u64,
    pub merkle_root: [u8; 32],
    pub total_lamports: u64,
    pub claimed_lamports: u64,
    pub published_at_unix: i64,
    pub bump: u8,
}

#[account]
pub struct ClaimReceipt {
    pub epoch_id: u64,
    pub claimant: Pubkey,
    pub amount: u64,
    pub claimed_at_unix: i64,
}

#[account]
pub struct ProviderRecord {
    pub provider: Pubkey,
    pub total_shards_proven: u64,
    pub last_proof_unix: i64,
}



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
    #[account(init, payer = owner, space = 8 + 32 + 8, seeds = [b"user", owner.key().as_ref()], bump)]
    pub user_account: Account<'info, UserAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(file_id: [u8; 32])]
pub struct CreateFileVault<'info> {
    #[account(
        init, payer = owner,
        space = 8 + 32 + 32 + 8 + 1 + 1 + 4 + 8 + 8 + 8 + 1,
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
        init, payer = owner,
        space = 8 + 32 + 1 + 32 + 32 + 8 + 4,
        seeds = [b"placement", file_vault.key().as_ref(), &[shard_index]], bump
    )]
    pub placement: Account<'info, Placement>,
    #[account(mut, has_one = owner)]
    pub file_vault: Account<'info, FileVault>,
    #[account(mut)]
    pub owner: Signer<'info>,            
    pub provider: Signer<'info>,         
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitPaidClaim<'info> {
    #[account(mut, has_one = provider @ ErrorCode::NotAssignedProvider)]
    pub placement: Account<'info, Placement>,
    #[account(
        mut,
        address = placement.file_vault,
        seeds = [b"vault", file_vault.file_id.as_ref()], // usa o file_id armazenado
        bump
    )]
    pub file_vault: Account<'info, FileVault>,
    #[account(
        init_if_needed,
        payer = provider,
        space = 8 + 32 + 8 + 8,
        seeds = [b"provider_record", provider.key().as_ref()],
        bump
    )]
    pub provider_record: Account<'info, ProviderRecord>,
    #[account(mut)]
    pub provider: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawUnused<'info> {
    #[account(mut, has_one = owner)]
    pub file_vault: Account<'info, FileVault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(epoch_id: u64)]
pub struct PublishEpochRoot<'info> {
    #[account(
        init, payer = admin,
        space = 8 + 8 + 32 + 8 + 8 + 8 + 1,
        seeds = [EPOCH_SEED, &epoch_id.to_le_bytes()], bump
    )]
    pub epoch_root: Account<'info, EpochRoot>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch_id: u64)]
pub struct ClaimEpoch<'info> {
    #[account(mut, seeds = [EPOCH_SEED, &epoch_id.to_le_bytes()], bump = epoch_root.bump)]
    pub epoch_root: Account<'info, EpochRoot>,
    #[account(
        init, payer = claimant,
        space = 8 + 8 + 32 + 8 + 8,
        seeds = [CLAIM_SEED, &epoch_id.to_le_bytes(), claimant.key().as_ref()], bump
        // `init` (não init_if_needed) É a trava de double-claim: a 2ª
        // tentativa da mesma (epoch_id, claimant) falha porque a PDA já existe.
    )]
    pub claim_receipt: Account<'info, ClaimReceipt>,
    #[account(mut)]
    pub claimant: Signer<'info>,
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
    #[msg("essa conta não é o provider designado para esse shard")]
    NotAssignedProvider,
    #[msg("vault inativo (sem fundos ou já sacado)")]
    VaultInactive,
    #[msg("época fora do intervalo do vault")]
    EpochOutOfRange,
    #[msg("essa época já foi reclamada")]
    EpochAlreadyClaimed,
    #[msg("prova de posse inválida (raiz Merkle não confere)")]
    InvalidProof,
    #[msg("saldo insuficiente no vault para pagar essa época")]
    InsufficientVaultBalance,
    #[msg("nada disponível pra sacar ainda (tudo reservado pras épocas já decorridas)")]
    NothingToWithdraw,
    #[msg("total_chunks inválido (precisa ser > 1 para o esquema de desafio Merkle funcionar)")]
    InvalidChunkCount,
    #[msg("domínio inválido (use a-z, 0-9, '.' e '-', 3 a 100 caracteres)")]
    InvalidDomain,
    #[msg("versão do site precisa ser maior que a atual (anti-rollback)")]
    StaleSiteVersion,
}
