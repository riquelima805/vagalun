'use strict';

/**
 * Tenta mapear a porta do TURN no roteador via UPnP, sem o usuário
 * mexer em nada. Se falhar (sem UPnP, roteador não suporta, etc.),
 * retorna { ok: false } e quem chamou decide o que fazer — aqui a
 * decisão é: nó continua funcionando, só não se anuncia como TURN.
 *
 * @achingbrain/nat-port-mapper é ESM puro; usamos import() dinâmico
 * porque o resto do projeto é CommonJS.
 */
async function tryUpnpMap(port) {
  let client;
  try {
    const { upnpNat } = await import('@achingbrain/nat-port-mapper');
    client = upnpNat();

    const signal = AbortSignal.timeout(8000);
    let mapped = false;
    let externalHost = null;

    for await (const gateway of client.findGateways({ signal })) {
      try {
        for await (const mapping of gateway.mapAll(port, { protocol: 'udp' })) {
          externalHost = mapping.externalHost;
          mapped = true;
          break; // primeiro mapeamento UDP bem-sucedido já basta
        }
        // TURN também aceita TCP em alguns clientes — tenta mapear também,
        // mas UDP é o que importa de verdade pro relay de mídia.
        try {
          for await (const _m of gateway.mapAll(port, { protocol: 'tcp' })) break;
        } catch (_) {}
        if (mapped) break;
      } catch (_) {
        // esse gateway específico não aceitou o mapeamento, tenta o próximo
      }
    }

    return { ok: mapped, externalHost, method: 'upnp' };
  } catch (err) {
    return { ok: false, error: err.message, method: 'upnp' };
  } finally {
    if (client) { try { await client.stop(); } catch (_) {} }
  }
}

module.exports = { tryUpnpMap };
