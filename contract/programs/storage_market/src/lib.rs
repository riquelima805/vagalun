// Esqueleto de smart contract Anchor pro "mercado de armazenamento":
// tier free vs pago, compra de espaço, recompensa por participar guardando shards.
//
// ATENÇÃO — ISSO É UM PONTO DE PARTIDA, NÃO PRODUÇÃO:
//   - Não foi compilado/testado neste ambiente (sem toolchain Solana/Anchor disponível aqui)
//   - Não foi auditado. Contratos Solana em produção movimentando dinheiro real
//     PRECISAM de auditoria de segurança antes de deploy em mainnet.
//   - A parte mais difícil de um sistema desses (provar on-chain que um peer
//     realmente guardou os bytes por um período — "Proof of Storage/Spacetime")
//     está deixada como TODO: é o mesmo problema em aberto que o Filecoin levou
//     anos pra resolver com um protocolo complexo. Aqui o placement/challenge
//     continua sendo verificado off-chain (no app), e o contrato só cuida do
//     dinheiro (compra de tier, pagamento a quem armazena).

use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111111111111"); // troque pelo Program ID real após `anchor deploy`

pub const FREE_TIER_BYTES: u64 = 500 * 1024 * 1024; // 500MB, igual ao combinado na conversa

#[program]
pub mod storage_market {
    use super::*;

    /// Cria a conta de "assinatura" do usuário, começando no tier free.
    pub fn init_account(ctx: Context<InitAccount>) -> Result<()> {
        let account = &mut ctx.accounts.user_account;
        account.owner = ctx.accounts.owner.key();
        account.tier_bytes = FREE_TIER_BYTES;
        account.paid_until_unix = 0;
        account.bytes_used = 0;
        Ok(())
    }

    /// Usuário paga em SOL por mais capacidade (upgrade de tier).
    /// price_lamports_per_gb_month deve vir de uma conta de config (não hardcoded),
    /// pra poder ajustar o preço sem precisar de novo deploy do programa inteiro.
    pub fn purchase_tier(ctx: Context<PurchaseTier>, extra_gb: u64, months: u64) -> Result<()> {
        let config = &ctx.accounts.market_config;
        let cost = config
            .price_lamports_per_gb_month
            .checked_mul(extra_gb)
            .and_then(|v| v.checked_mul(months))
            .ok_or(ErrorCode::MathOverflow)?;

        // transferência de lamports do usuário pro tesouro do protocolo
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
            .checked_add(extra_gb.checked_mul(1024 * 1024 * 1024).ok_or(ErrorCode::MathOverflow)?)
            .ok_or(ErrorCode::MathOverflow)?;
        Ok(())
    }

    /// Registra que um peer forneceu prova de armazenamento válida num período
    /// (a verificação da prova em si acontece off-chain, no app/coordenador local —
    /// aqui só criamos o registro de "trabalho feito" pra depois calcular recompensa).
    /// TODO: substituir por verificação criptográfica on-chain quando/se existir
    /// um esquema de Proof-of-Storage viável em custo de computação on-chain.
    pub fn report_storage_proof(ctx: Context<ReportProof>, shard_count: u64) -> Result<()> {
        let record = &mut ctx.accounts.provider_record;
        record.provider = ctx.accounts.provider.key();
        record.total_shards_proven = record
            .total_shards_proven
            .checked_add(shard_count)
            .ok_or(ErrorCode::MathOverflow)?;
        record.last_proof_unix = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Paga a recompensa acumulada a um provider a partir do tesouro do protocolo.
    pub fn claim_reward(ctx: Context<ClaimReward>, lamports: u64) -> Result<()> {
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.treasury.to_account_info(),
                to: ctx.accounts.provider.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, lamports)?;
        Ok(())
    }
}

#[account]
pub struct UserAccount {
    pub owner: Pubkey,
    pub tier_bytes: u64,
    pub bytes_used: u64,
    pub paid_until_unix: i64,
}

#[account]
pub struct MarketConfig {
    pub price_lamports_per_gb_month: u64,
    pub admin: Pubkey,
}

#[account]
pub struct ProviderRecord {
    pub provider: Pubkey,
    pub total_shards_proven: u64,
    pub last_proof_unix: i64,
}

#[derive(Accounts)]
pub struct InitAccount<'info> {
    #[account(init, payer = owner, space = 8 + 32 + 8 + 8 + 8)]
    pub user_account: Account<'info, UserAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PurchaseTier<'info> {
    #[account(mut, has_one = owner)]
    pub user_account: Account<'info, UserAccount>,
    pub market_config: Account<'info, MarketConfig>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: conta simples do tesouro do protocolo, só recebe lamports
    #[account(mut)]
    pub treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReportProof<'info> {
    #[account(init_if_needed, payer = provider, space = 8 + 32 + 8 + 8)]
    pub provider_record: Account<'info, ProviderRecord>,
    #[account(mut)]
    pub provider: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimReward<'info> {
    #[account(mut)]
    pub provider: SystemAccount<'info>,
    /// CHECK: tesouro do protocolo
    #[account(mut)]
    pub treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("overflow numérico")]
    MathOverflow,
}
