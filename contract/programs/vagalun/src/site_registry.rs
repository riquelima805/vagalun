// site_registry.rs — registro de sites on-chain (domínio -> dono + hash do manifesto).
//
// Troca o "DNS centralizado" (registry.js) por uma conta PDA por domínio que
// QUALQUER cliente consegue ler direto de um RPC e conferir sozinho.
//
// Modelo de confiança (propositalmente simples):
//   - register_site : só o REGISTRAR (ADMIN) cria o nome e define o 1º dono.
//                     É o mesmo papel de um registrador de domínio: pro usuário só-e-mail,
//                     a plataforma registra em nome da chave custodial do site.
//   - update_site   : só o DONO (chave do site) troca hash+versão. O ADMIN NÃO consegue
//                     alterar o conteúdo de um site depois de registrado.
//   - transfer_site : o dono entrega a chave a outra pessoa (é a saída de "custódia":
//                     o usuário pode assumir o próprio domínio quando quiser).
//
// A `version` é estritamente crescente: impede replay de manifesto antigo (rollback).
//
// NÃO COMPILADO no ambiente de análise (sem toolchain Rust/Anchor) — rode `anchor build`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;

use crate::{ErrorCode, ADMIN};

pub const SITE_SEED: &[u8] = b"site";
pub const MAX_DOMAIN_LEN: usize = 100;
pub const MIN_DOMAIN_LEN: usize = 3;

/// Layout (depois dos 8 bytes de discriminator), TUDO de tamanho fixo antes do `domain`
/// pra os clientes (JS/Kotlin) decodificarem sem borsh:
///   0   domain_hash      [u8;32]
///   32  owner            Pubkey
///   64  manifest_hash    [u8;32]
///   96  version          u64 LE
///   104 updated_at_unix  i64 LE
///   112 bump             u8
///   113 domain           String (u32 LE len + bytes)
#[account]
pub struct SiteRecord {
    pub domain_hash: [u8; 32],
    pub owner: Pubkey,
    pub manifest_hash: [u8; 32],
    pub version: u64,
    pub updated_at_unix: i64,
    pub bump: u8,
    pub domain: String,
}

pub const SITE_RECORD_SPACE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 4 + MAX_DOMAIN_LEN;

/// Domínio normalizado: ASCII minúsculo [a-z0-9.-], sem começar/terminar com '.' ou '-',
/// sem ".." — garante 1 PDA por nome (sem variantes de caixa/unicode pra squatting).
fn validate_domain(domain: &str) -> Result<()> {
    let b = domain.as_bytes();
    require!(b.len() >= MIN_DOMAIN_LEN && b.len() <= MAX_DOMAIN_LEN, ErrorCode::InvalidDomain);
    require!(
        b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'.' || *c == b'-'),
        ErrorCode::InvalidDomain
    );
    require!(b[0] != b'.' && b[0] != b'-', ErrorCode::InvalidDomain);
    require!(b[b.len() - 1] != b'.' && b[b.len() - 1] != b'-', ErrorCode::InvalidDomain);
    require!(!domain.contains(".."), ErrorCode::InvalidDomain);
    Ok(())
}

pub fn handle_register_site(ctx: Context<RegisterSite>, domain: String, owner: Pubkey) -> Result<()> {
    require_keys_eq!(ctx.accounts.registrar.key(), ADMIN, ErrorCode::Unauthorized);
    validate_domain(&domain)?;

    let rec = &mut ctx.accounts.site;
    rec.domain_hash = hash(domain.as_bytes()).to_bytes();
    rec.owner = owner;
    rec.manifest_hash = [0u8; 32];
    rec.version = 0;
    rec.updated_at_unix = Clock::get()?.unix_timestamp;
    rec.bump = ctx.bumps.site;
    rec.domain = domain.clone();

    emit!(SiteRegistered { domain, owner });
    Ok(())
}

pub fn handle_update_site(ctx: Context<UpdateSite>, manifest_hash: [u8; 32], version: u64) -> Result<()> {
    let rec = &mut ctx.accounts.site;
    require!(version > rec.version, ErrorCode::StaleSiteVersion);
    rec.manifest_hash = manifest_hash;
    rec.version = version;
    rec.updated_at_unix = Clock::get()?.unix_timestamp;

    emit!(SiteUpdated { domain: rec.domain.clone(), manifest_hash, version });
    Ok(())
}

pub fn handle_transfer_site(ctx: Context<TransferSite>, new_owner: Pubkey) -> Result<()> {
    let rec = &mut ctx.accounts.site;
    let old = rec.owner;
    rec.owner = new_owner;
    emit!(SiteTransferred { domain: rec.domain.clone(), old_owner: old, new_owner });
    Ok(())
}

#[derive(Accounts)]
#[instruction(domain: String)]
pub struct RegisterSite<'info> {
    #[account(
        init, payer = registrar, space = SITE_RECORD_SPACE,
        seeds = [SITE_SEED, hash(domain.as_bytes()).to_bytes().as_ref()], bump
    )]
    pub site: Account<'info, SiteRecord>,
    #[account(mut)]
    pub registrar: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateSite<'info> {
    #[account(
        mut, has_one = owner @ ErrorCode::Unauthorized,
        seeds = [SITE_SEED, site.domain_hash.as_ref()], bump = site.bump
    )]
    pub site: Account<'info, SiteRecord>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct TransferSite<'info> {
    #[account(
        mut, has_one = owner @ ErrorCode::Unauthorized,
        seeds = [SITE_SEED, site.domain_hash.as_ref()], bump = site.bump
    )]
    pub site: Account<'info, SiteRecord>,
    pub owner: Signer<'info>,
}

#[event]
pub struct SiteRegistered { pub domain: String, pub owner: Pubkey }
#[event]
pub struct SiteUpdated { pub domain: String, pub manifest_hash: [u8; 32], pub version: u64 }
#[event]
pub struct SiteTransferred { pub domain: String, pub old_owner: Pubkey, pub new_owner: Pubkey }
