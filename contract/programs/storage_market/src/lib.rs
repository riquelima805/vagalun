use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_lang::solana_program::pubkey;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("11111111111111111111111111111111111111111"); 

pub const FREE_TIER_BYTES: u64 = 500 * 1024 * 1024; 
pub const MAX_TIER_BYTES: u64 = 10 * 1024 * 1024 * 1024; 
pub const SECONDS_PER_EPOCH: i64 = 86_400; 
pub const BYTES_PER_GB: u64 = 1024 * 1024 * 1024;


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

 

    pub fn init_account(ctx: Context<InitAccount>) -> Result<()> {
        let account = &mut ctx.accounts.user_account;
        account.owner = ctx.accounts.owner.key();
        account.tier_bytes = FREE_TIER_BYTES;
        account.bytes_used = 0;
        Ok(())
    }

    
    pub fn purchase_tier(ctx: Context<PurchaseTier>, extra_gb: u64) -> Result<()> {
        let config = &ctx.accounts.market_config;
        let cost = config
            .price_lamports_per_gb_day
            .checked_mul(30)
            .and_then(|v| v.checked_mul(extra_gb))
            .ok_or(ErrorCode::MathOverflow)?;

        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
        );
        transfer(cpi_context, cost)?;

        let account = &mut ctx.accounts.user_account;
        let add_bytes = extra_gb.checked_mul(BYTES_PER_GB).ok_or(ErrorCode::MathOverflow)?;
        account.tier_bytes = account
            .tier_bytes
            .checked_add(add_bytes)
            .ok_or(ErrorCode::MathOverflow)?;
        // Aplica limite máximo
        if account.tier_bytes > MAX_TIER_BYTES {
            account.tier_bytes = MAX_TIER_BYTES;
        }
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

  
    pub fn register_placement(ctx: Context<RegisterPlacement>, shard_index: u8, merkle_root: [u8; 32]) -> Result<()> {
        require!((shard_index as u8) < ctx.accounts.file_vault.n, ErrorCode::InvalidRedundancyParams);
        let placement = &mut ctx.accounts.placement;
        placement.file_vault = ctx.accounts.file_vault.key();
        placement.shard_index = shard_index;
        placement.provider = ctx.accounts.provider.key();
        placement.merkle_root = merkle_root;
        placement.last_claimed_epoch = -1;
        emit!(PlacementRegistered {
            file_vault: placement.file_vault,
            shard_index,
            provider: placement.provider,
        });
        Ok(())
    }

   
    pub fn submit_paid_claim(
        ctx: Context<SubmitPaidClaim>,
        chunk_index: u32,
        chunk_hash: [u8; 32],
        merkle_proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        

        
        let payout = ctx.accounts.file_vault.rate_per_shard_per_epoch;

        
        let seeds = &[
            b"vault",
            ctx.accounts.file_vault.file_id.as_ref(),
            &[ctx.bumps.file_vault], 
        ];
        let signer = &[&seeds[..]];

        let cpi_context = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.file_vault.to_account_info(),
                to: ctx.accounts.provider.to_account_info(),
            },
            signer,
        );
        
        transfer(cpi_context, payout)?;

        
        Ok(())
    }

    
    pub fn withdraw_unused(ctx: Context<WithdrawUnused>) -> Result<()> {
        require_keys_eq!(ctx.accounts.owner.key(), ctx.accounts.file_vault.owner, ErrorCode::Unauthorized);
        require!(ctx.accounts.file_vault.active, ErrorCode::VaultInactive);

        
        let vault = &mut ctx.accounts.file_vault;
        vault.active = false; // marca como inativo antes de fechar
        emit!(VaultClosed {
            file_vault: vault.key(),
            owner: ctx.accounts.owner.key(),
        });
        Ok(())
    }

    

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
        emit!(FreeContributionRegistered {
            provider: contribution.provider,
            content_id,
            shard_index,
        });
        Ok(())
    }

   
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

        let computed_root = verify_merkle_proof(chunk_index, chunk_hash, &merkle_proof);
        require!(computed_root == ctx.accounts.contribution.merkle_root, ErrorCode::InvalidProof);

        let shard_size_bytes = ctx.accounts.contribution.shard_size_bytes;

        // Atualiza contribution
        let contribution = &mut ctx.accounts.contribution;
        contribution.last_claimed_epoch = epoch;

        // Credita tier_bytes com limite máximo
        let user_account = &mut ctx.accounts.provider_user_account;
        let new_tier = user_account
            .tier_bytes
            .checked_add(shard_size_bytes)
            .ok_or(ErrorCode::MathOverflow)?;
        user_account.tier_bytes = new_tier.min(MAX_TIER_BYTES);

        let record = &mut ctx.accounts.provider_record;
        record.provider = ctx.accounts.provider.key();
        record.total_shards_proven = record.total_shards_proven.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
        record.last_proof_unix = now;

        emit!(FreeTierProof {
            provider: record.provider,
            content_id: contribution.content_id,
            epoch,
            tier_bytes: user_account.tier_bytes,
        });
        Ok(())
    }
}



fn verify_merkle_proof(leaf_index: u32, leaf_hash: [u8; 32], proof: &[[u8; 32]]) -> [u8; 32] {
   
    assert!(proof.len() <= 32, "Proof too long");
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
pub struct FreeContributionRegistered {
    pub provider: Pubkey,
    pub content_id: [u8; 32],
    pub shard_index: u8,
}

#[event]
pub struct FreeTierProof {
    pub provider: Pubkey,
    pub content_id: [u8; 32],
    pub epoch: i64,
    pub tier_bytes: u64,
}



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
}

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
    
   
    #[account(
        mut, 
        address = market_config.admin @ ErrorCode::Unauthorized
    )]
    pub treasury: SystemAccount<'info>,
    
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
        space = 8 + 32 + 1 + 32 + 32 + 8,
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
    #[account(mut)]
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
    #[account(
        mut,
        close = owner,  // Ao fechar, envia todos os lamports para owner
        has_one = owner
    )]
    pub file_vault: Account<'info, FileVault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(content_id: [u8; 32], shard_index: u8)]
pub struct RegisterFreeContribution<'info> {
    #[account(
        init, payer = owner,
        space = 8 + 32 + 32 + 1 + 8 + 32 + 8 + 8,
        seeds = [b"free", provider.key().as_ref(), content_id.as_ref(), &[shard_index]], bump
    )]
    pub contribution: Account<'info, FreeContribution>,
    #[account(mut)]
    pub owner: Signer<'info>,            // dono do conteúdo
    pub provider: Signer<'info>,         // provider também assina
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReportFreeTierProof<'info> {
    #[account(mut)]
    pub contribution: Account<'info, FreeContribution>,
    #[account(mut, seeds = [b"user", provider.key().as_ref()], bump)]
    pub provider_user_account: Account<'info, UserAccount>,
    #[account(
        init_if_needed, payer = provider,
        space = 8 + 32 + 8 + 8,
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
}
