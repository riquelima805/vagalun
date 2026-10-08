'use strict';

/**
 * Preço da entrega. Fonte única — gateway, hosting e epochJob importam daqui.
 *
 * O painel do CDN promete: US$ 0,50 por 1.000 minutos, por viewer.
 *   0,50 / 1000 = US$ 0,0005 por viewer-minuto = US$ 0,03 por viewer-hora.
 *
 * O recibo conta BYTES (é o que o player consegue provar), então convertemos
 * minuto -> bytes com um bitrate de referência. Com 2.500 kbps (≈ 720p):
 *   2.500.000 / 8 * 60 = 18.750.000 bytes por minuto
 *   US$ 0,0005 / 18,75 MB ≈ US$ 0,0267 por GB entregue.
 * Vídeo mais pesado que a referência sai mais barato por minuto; mais leve, mais caro.
 * Se quiser cobrar por GB direto, defina USD_PER_DELIVERED_GB e o bitrate vira só informativo.
 */

const USD_PER_VIEWER_MINUTE = Number(process.env.USD_PER_VIEWER_MINUTE || 0.5 / 1000);
const REF_BITRATE_KBPS = Number(process.env.RECEIPT_REF_BITRATE_KBPS || 2500);
const REF_BYTES_PER_MINUTE = (REF_BITRATE_KBPS * 1000 / 8) * 60;

const USD_PER_BYTE = process.env.USD_PER_DELIVERED_GB
  ? Number(process.env.USD_PER_DELIVERED_GB) / 1e9
  : USD_PER_VIEWER_MINUTE / REF_BYTES_PER_MINUTE;

// Parte do que o dono do site paga que vai pro nó que entregou. O resto fica
// com a plataforma (gateway, signaling, auditoria, taxa de pagamento).
const NODE_SHARE = Math.min(1, Math.max(0, Number(process.env.RECEIPT_NODE_SHARE || 0.7)));

const usdForBytes = (bytes) => bytes * USD_PER_BYTE;
const minutesForBytes = (bytes) => bytes / REF_BYTES_PER_MINUTE;

module.exports = {
  USD_PER_VIEWER_MINUTE, REF_BITRATE_KBPS, REF_BYTES_PER_MINUTE, USD_PER_BYTE, NODE_SHARE,
  usdForBytes, minutesForBytes,
};
