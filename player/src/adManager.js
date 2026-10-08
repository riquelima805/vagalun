// Sistema de anúncios do player.
//
// Regra de ouro (o pedido explícito): NUNCA cobrir o vídeo com pop-up.
//  - Pre-roll/mid-roll: um anúncio em vídeo de verdade, tela cheia do player,
//    igual qualquer plataforma grande — mas com botão de pular e sem travar
//    o carregamento do conteúdo principal (ele já vem pronto por trás).
//  - Overlay: um banner PEQUENO, ancorado embaixo, que nunca fica sobre os
//    controles nem sobre o centro do vídeo, com botão de fechar sempre visível,
//    e que some sozinho depois de alguns segundos.
//
// Contabilização: toda impressão/clique é registrada via sendBeacon (não
// bloqueia navegação, sobrevive a troca de página) com fallback pra fetch
// keepalive. Além disso emite eventos locais (`onEvent('ad:*', ...)`) pra
// quem incorporou o player plugar GA4/Ad Manager/o que quiser. Suporta tags
// VAST (Google Ad Manager, qualquer ad server compatível com IAB VAST 2/3/4,
// só lineares) como alternativa a configurar o anúncio manualmente.

function track(url) {
  if (!url) return;
  const final = url.replace(/\[CACHEBUSTER\]/g, String(Date.now())).replace(/\[TIMESTAMP\]/g, new Date().toISOString());
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(final);
      return;
    }
  } catch {}
  try {
    fetch(final, { method: 'GET', mode: 'no-cors', keepalive: true });
  } catch {}
}

function trackAll(urls) {
  (Array.isArray(urls) ? urls : urls ? [urls] : []).forEach(track);
}

async function fetchVast(url, depth = 0) {
  if (depth > 3) throw new Error('cadeia de VAST Wrapper longa demais');
  const res = await fetch(url);
  const xmlText = await res.text();
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');

  const wrapperUri = doc.querySelector('Wrapper > VASTAdTagURI')?.textContent?.trim();
  if (wrapperUri) {
    return fetchVast(wrapperUri, depth + 1);
  }

  const linear = doc.querySelector('Linear');
  if (!linear) throw new Error('VAST sem creative Linear (só anúncios lineares são suportados)');

  const mediaFiles = [...doc.querySelectorAll('MediaFile')]
    .map((el) => ({ url: el.textContent.trim(), type: el.getAttribute('type') || '' }))
    .filter((m) => m.url);
  const mp4 = mediaFiles.find((m) => m.type.includes('mp4')) || mediaFiles[0];
  if (!mp4) throw new Error('VAST sem MediaFile utilizável');

  const clickThrough = doc.querySelector('ClickThrough')?.textContent?.trim();
  const clickTracking = [...doc.querySelectorAll('ClickTracking')].map((el) => el.textContent.trim());
  const impressions = [...doc.querySelectorAll('Impression')].map((el) => el.textContent.trim());
  const skipOffset = linear.getAttribute('skipoffset'); // ex: "00:00:05"
  let skipAfter = 5;
  if (skipOffset && /^\d\d:\d\d:\d\d$/.test(skipOffset)) {
    const [h, m, s] = skipOffset.split(':').map(Number);
    skipAfter = h * 3600 + m * 60 + s;
  }

  const trackingEvents = {};
  doc.querySelectorAll('TrackingEvents > Tracking').forEach((el) => {
    const ev = el.getAttribute('event');
    if (!ev) return;
    (trackingEvents[ev] ||= []).push(el.textContent.trim());
  });

  return {
    videoUrl: mp4.url,
    clickUrl: clickThrough,
    skipAfter,
    tracking: {
      impression: impressions,
      click: clickTracking,
      start: trackingEvents.start,
      complete: trackingEvents.complete,
      firstQuartile: trackingEvents.firstQuartile,
      midpoint: trackingEvents.midpoint,
      thirdQuartile: trackingEvents.thirdQuartile,
      skip: trackingEvents.skip
    }
  };
}

export class AdManager {
  constructor({ root, onEvent }) {
    this.root = root; // container do player (pra montar overlay/creative de ad)
    this.onEvent = onEvent || (() => {});
    this.midrollsFired = new Set();
    this._overlayTimer = null;
  }

  emit(name, data) {
    this.onEvent(name, data);
  }

  /**
   * Toca um "ad break" (pre-roll ou mid-roll) em vídeo, ocupando o player
   * inteiro, e retorna uma Promise que resolve quando o anúncio termina ou é
   * pulado — o chamador então retoma o conteúdo principal.
   */
  playVideoAd(adConfig) {
    return new Promise((resolve) => {
      if (!adConfig || !adConfig.videoUrl) { resolve(); return; }

      const overlay = document.createElement('div');
      overlay.className = 'vgl-ad-break';

      const adVideo = document.createElement('video');
      adVideo.className = 'vgl-ad-video';
      adVideo.src = adConfig.videoUrl;
      adVideo.autoplay = true;
      adVideo.playsInline = true;
      adVideo.muted = false;

      const badge = document.createElement('div');
      badge.className = 'vgl-ad-badge';
      badge.textContent = 'Anúncio';

      const skipBtn = document.createElement('button');
      skipBtn.className = 'vgl-ad-skip';
      skipBtn.type = 'button';
      skipBtn.disabled = true;
      const skipAfter = adConfig.skipAfter ?? 5;
      skipBtn.textContent = skipAfter > 0 ? `Pular em ${skipAfter}s` : 'Pular anúncio';

      overlay.append(adVideo, badge, skipBtn);
      this.root.appendChild(overlay);

      let finished = false;
      let quartilesFired = { first: false, mid: false, third: false };

      const cleanup = (skipped) => {
        if (finished) return;
        finished = true;
        clearInterval(countdown);
        if (skipped) trackAll(adConfig.tracking?.skip);
        else trackAll(adConfig.tracking?.complete);
        overlay.remove();
        resolve();
      };

      const openClick = () => {
        if (!adConfig.clickUrl) return;
        trackAll(adConfig.tracking?.click);
        this.emit('ad:click', { videoUrl: adConfig.videoUrl, clickUrl: adConfig.clickUrl });
        window.open(adConfig.clickUrl, '_blank', 'noopener');
      };
      adVideo.addEventListener('click', openClick);

      adVideo.addEventListener('timeupdate', () => {
        if (!adVideo.duration) return;
        const pct = adVideo.currentTime / adVideo.duration;
        if (pct >= 0.25 && !quartilesFired.first) { quartilesFired.first = true; trackAll(adConfig.tracking?.firstQuartile); }
        if (pct >= 0.5 && !quartilesFired.mid) { quartilesFired.mid = true; trackAll(adConfig.tracking?.midpoint); }
        if (pct >= 0.75 && !quartilesFired.third) { quartilesFired.third = true; trackAll(adConfig.tracking?.thirdQuartile); }
      });

      adVideo.addEventListener('ended', () => cleanup(false));
      adVideo.addEventListener('error', () => cleanup(true)); // não trava: se o ad falhar, segue pro conteúdo

      let remaining = skipAfter;
      const countdown = setInterval(() => {
        remaining -= 1;
        if (remaining > 0) {
          skipBtn.textContent = `Pular em ${remaining}s`;
        } else {
          skipBtn.disabled = false;
          skipBtn.textContent = 'Pular anúncio ▸';
          clearInterval(countdown);
        }
      }, 1000);
      if (skipAfter <= 0) { skipBtn.disabled = false; skipBtn.textContent = 'Pular anúncio ▸'; clearInterval(countdown); }

      skipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!skipBtn.disabled) cleanup(true);
      });

      adVideo.addEventListener('playing', () => {
        trackAll(adConfig.tracking?.impression);
        trackAll(adConfig.tracking?.start);
        this.emit('ad:impression', { videoUrl: adConfig.videoUrl });
      }, { once: true });
    });
  }

  async playFromVast(vastUrl) {
    try {
      const config = await fetchVast(vastUrl);
      await this.playVideoAd(config);
    } catch (e) {
      this.emit('ad:error', { reason: e.message });
      // falhou o VAST -> não trava nada, conteúdo segue normalmente.
    }
  }

  /**
   * Banner pequeno e não-bloqueante, ancorado no canto — nunca cobre o vídeo
   * inteiro nem a barra de controles. Some sozinho depois de `showFor`.
   */
  showOverlay(adConfig) {
    if (!adConfig || (!adConfig.imageUrl && !adConfig.html)) return;
    this.hideOverlay();

    const box = document.createElement('div');
    box.className = 'vgl-ad-overlay';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'vgl-ad-overlay-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Fechar anúncio');
    closeBtn.textContent = '✕';

    const content = document.createElement('a');
    content.className = 'vgl-ad-overlay-content';
    content.href = adConfig.clickUrl || '#';
    content.target = '_blank';
    content.rel = 'noopener';
    if (adConfig.imageUrl) {
      const img = document.createElement('img');
      img.src = adConfig.imageUrl;
      img.alt = adConfig.alt || 'Anúncio';
      content.appendChild(img);
    } else if (adConfig.html) {
      content.innerHTML = adConfig.html;
    }
    const label = document.createElement('span');
    label.className = 'vgl-ad-overlay-label';
    label.textContent = 'Publicidade';
    content.appendChild(label);

    content.addEventListener('click', (e) => {
      if (!adConfig.clickUrl) { e.preventDefault(); return; }
      trackAll(adConfig.tracking?.click);
      this.emit('ad:click', { overlay: true, clickUrl: adConfig.clickUrl });
    });

    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideOverlay();
    });

    box.append(content, closeBtn);
    this.root.appendChild(box);
    this._overlayEl = box;

    trackAll(adConfig.tracking?.impression);
    this.emit('ad:impression', { overlay: true });

    const showFor = adConfig.showFor ?? 8;
    if (showFor > 0) {
      this._overlayTimer = setTimeout(() => this.hideOverlay(), showFor * 1000);
      box.addEventListener('mouseenter', () => clearTimeout(this._overlayTimer));
      box.addEventListener('mouseleave', () => {
        this._overlayTimer = setTimeout(() => this.hideOverlay(), showFor * 1000);
      });
    }
  }

  hideOverlay() {
    clearTimeout(this._overlayTimer);
    if (this._overlayEl) {
      this._overlayEl.remove();
      this._overlayEl = null;
    }
  }

  destroy() {
    this.hideOverlay();
  }
}
