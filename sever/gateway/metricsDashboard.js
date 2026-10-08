// Painel simples (HTML estático) que lê GET /metrics/public a cada 5 s.
function dashboardHtml() {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vagalun CDN — painel</title>
<style>
  body{font:14px system-ui,sans-serif;margin:0;padding:20px;background:#0f1218;color:#e6e9ef}
  h1{font-size:20px;margin:0 0 16px} h2{font-size:15px;margin:24px 0 8px;color:#9aa4b5}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
  .card{background:#181d27;border-radius:10px;padding:12px}.card b{display:block;font-size:22px;margin-top:4px}
  table{width:100%;border-collapse:collapse;background:#181d27;border-radius:10px;overflow:hidden}
  th,td{padding:7px 10px;text-align:left;border-bottom:1px solid #232a38;font-size:13px}th{color:#9aa4b5;font-weight:600}
  .wrap{overflow-x:auto}.muted{color:#9aa4b5}
</style></head><body>
<h1>Vagalun CDN <span class="muted" id="up"></span></h1>
<div class="cards" id="cards"></div>
<h2>Latência por região do visitante</h2><div class="wrap"><table id="regions"></table></div>
<h2>Celulares (apelido, sem ID real)</h2><div class="wrap"><table id="nodes"></table></div>
<h2>Réplicas de borda ativas</h2><div class="wrap"><table id="edge"></table></div>
<script>
const fmtB=n=>{n=n||0;const u=['B','KB','MB','GB','TB'];let i=0;while(n>=1024&&i<4){n/=1024;i++}return n.toFixed(i?1:0)+' '+u[i]};
const pct=v=>v==null?'—':(v*100).toFixed(1)+'%';
const esc=s=>String(s==null?'—':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const tbl=(el,head,rows)=>{document.getElementById(el).innerHTML='<tr>'+head.map(h=>'<th>'+h+'</th>').join('')+'</tr>'+(rows.length?rows.map(r=>'<tr>'+r.map(c=>'<td>'+esc(c)+'</td>').join('')+'</tr>').join(''):'<tr><td class="muted" colspan="'+head.length+'">sem dados ainda</td></tr>')};
async function tick(){try{
  const m=await (await fetch('/metrics/public')).json();
  document.getElementById('up').textContent='· no ar há '+Math.floor(m.uptimeSec/60)+' min';
  const c=[['Servido por P2P',pct(m.traffic.p2pShare)],['Taxa de cache',pct(m.cache.hitRate)],['Celulares online',m.presence.known?m.presence.onlineNodes:'?'],
    ['Bytes via gateway',fmtB(m.traffic.bytesServedByGateway)],['Bytes direto P2P',fmtB(m.traffic.bytesDirectP2P)],['Réplicas de borda',m.edge.activeReplicas]];
  document.getElementById('cards').innerHTML=c.map(x=>'<div class="card">'+x[0]+'<b>'+esc(x[1])+'</b></div>').join('');
  tbl('regions',['Região','Pedidos','Sessões P2P','Cache hit','TTFB p50','TTFB p95'],m.regions.map(r=>[r.region,r.requests,r.p2pSessions,pct(r.cacheHitRate),r.ttfbP50Ms==null?'—':r.ttfbP50Ms+' ms',r.ttfbP95Ms==null?'—':r.ttfbP95Ms+' ms']));
  tbl('nodes',['Nó','Região','Borda','Via gateway','Direto P2P','Pedidos'],m.nodes.map(n=>[n.node,n.region,n.edge?'sim':'não',fmtB(n.bytesViaGateway),fmtB(n.bytesDirectP2P),n.requests]));
  tbl('edge',['Arquivo','Nó','Região','Online','Idade','Ocioso'],m.edge.replicas.map(r=>[r.fileId,r.node,r.region,r.online==null?'?':(r.online?'sim':'não'),r.ageSec+' s',r.idleSec+' s']));
}catch(e){}}
tick();setInterval(tick,5000);
</script></body></html>`;
}
module.exports = { dashboardHtml };
