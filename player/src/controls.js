// Monta a barra de controles custom (não usa os controles nativos do <video>,
// pra ter cara consistente em qualquer site e caber a UI de qualidade/ads).

function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function icon(name) {
  const paths = {
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
    volume: '<path d="M4 9v6h4l5 5V4L8 9H4z"/>',
    mute: '<path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M19 8l-4 4m0-4l4 4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    exitFullscreen: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    pip: '<path d="M4 5h16v14H4zM12 12h6v5h-6z" fill="none" stroke="currentColor" stroke-width="2"/>',
    settings: '<path d="M12 8a4 4 0 100 8 4 4 0 000-8zm8.4 4a7.4 7.4 0 01-.1 1.2l2 1.6-2 3.4-2.4-1a7.5 7.5 0 01-2 1.2l-.4 2.6h-4l-.4-2.6a7.5 7.5 0 01-2-1.2l-2.4 1-2-3.4 2-1.6A7.4 7.4 0 013.6 12c0-.4 0-.8.1-1.2l-2-1.6 2-3.4 2.4 1a7.5 7.5 0 012-1.2L8.5 2h4l.4 2.6a7.5 7.5 0 012 1.2l2.4-1 2 3.4-2 1.6c.1.4.1.8.1 1.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'
  };
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">${paths[name] || ''}</svg>`;
}

export function buildControls({ root, video, engine, playerId }) {
  const wrap = document.createElement('div');
  wrap.className = 'vgl-controls';

  const progressWrap = document.createElement('div');
  progressWrap.className = 'vgl-progress';
  progressWrap.setAttribute('role', 'slider');
  progressWrap.setAttribute('aria-label', 'Progresso do vídeo');
  progressWrap.tabIndex = 0;

  const bufferedBar = document.createElement('div');
  bufferedBar.className = 'vgl-progress-buffered';
  const playedBar = document.createElement('div');
  playedBar.className = 'vgl-progress-played';
  const scrubber = document.createElement('div');
  scrubber.className = 'vgl-progress-scrubber';
  progressWrap.append(bufferedBar, playedBar, scrubber);

  const row = document.createElement('div');
  row.className = 'vgl-controls-row';

  const playBtn = document.createElement('button');
  playBtn.className = 'vgl-btn vgl-play';
  playBtn.type = 'button';
  playBtn.setAttribute('aria-label', 'Reproduzir');
  playBtn.innerHTML = icon('play');

  const volumeBtn = document.createElement('button');
  volumeBtn.className = 'vgl-btn vgl-volume-btn';
  volumeBtn.type = 'button';
  volumeBtn.setAttribute('aria-label', 'Volume');
  volumeBtn.innerHTML = icon('volume');

  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range';
  volumeSlider.min = '0';
  volumeSlider.max = '1';
  volumeSlider.step = '0.05';
  volumeSlider.value = '1';
  volumeSlider.className = 'vgl-volume-slider';
  volumeSlider.setAttribute('aria-label', 'Nível de volume');

  const time = document.createElement('div');
  time.className = 'vgl-time';
  time.textContent = '0:00 / 0:00';

  const spacer = document.createElement('div');
  spacer.className = 'vgl-spacer';

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'vgl-btn vgl-settings-btn';
  settingsBtn.type = 'button';
  settingsBtn.setAttribute('aria-label', 'Configurações');
  settingsBtn.innerHTML = icon('settings');

  const settingsMenu = document.createElement('div');
  settingsMenu.className = 'vgl-settings-menu';
  settingsMenu.hidden = true;

  const pipBtn = document.createElement('button');
  pipBtn.className = 'vgl-btn vgl-pip-btn';
  pipBtn.type = 'button';
  pipBtn.setAttribute('aria-label', 'Picture-in-picture');
  pipBtn.innerHTML = icon('pip');
  if (!document.pictureInPictureEnabled) pipBtn.style.display = 'none';

  const fsBtn = document.createElement('button');
  fsBtn.className = 'vgl-btn vgl-fs-btn';
  fsBtn.type = 'button';
  fsBtn.setAttribute('aria-label', 'Tela cheia');
  fsBtn.innerHTML = icon('fullscreen');

  row.append(playBtn, volumeBtn, volumeSlider, time, spacer, settingsBtn, pipBtn, fsBtn);
  wrap.append(progressWrap, row, settingsMenu);
  root.appendChild(wrap);

  const spinner = document.createElement('div');
  spinner.className = 'vgl-spinner';
  spinner.hidden = true;
  root.appendChild(spinner);

  const bigPlay = document.createElement('button');
  bigPlay.className = 'vgl-big-play';
  bigPlay.type = 'button';
  bigPlay.setAttribute('aria-label', 'Reproduzir vídeo');
  bigPlay.innerHTML = '<svg viewBox="0 0 68 48" width="68" height="48"><path d="M66.5 7.7c-.8-2.9-2.6-5.2-5-6C56.9 0 34 0 34 0S11.1 0 6.5 1.7c-2.4.8-4.2 3.1-5 6C0 12.4 0 24 0 24s0 11.6 1.5 16.3c.8 2.9 2.6 5.1 5 6C11.1 48 34 48 34 48s22.9 0 27.5-1.7c2.4-.9 4.2-3.1 5-6C68 35.6 68 24 68 24s0-11.6-1.5-16.3z" fill="rgba(0,0,0,.55)"/><path d="M27 14l19 10-19 10V14z" fill="#fff"/></svg>';
  root.appendChild(bigPlay);

  const errorBox = document.createElement('div');
  errorBox.className = 'vgl-error';
  errorBox.hidden = true;
  root.appendChild(errorBox);

  // ---- estado / helpers ----
  const storageKey = (suffix) => `vgl:${playerId || 'default'}:${suffix}`;

  function setPlayingIcon(playing) {
    playBtn.innerHTML = icon(playing ? 'pause' : 'play');
    playBtn.setAttribute('aria-label', playing ? 'Pausar' : 'Reproduzir');
    bigPlay.hidden = playing;
  }

  function updateProgress() {
    if (!video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    playedBar.style.width = `${pct}%`;
    scrubber.style.left = `${pct}%`;
    time.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
    if (video.buffered.length) {
      const end = video.buffered.end(video.buffered.length - 1);
      bufferedBar.style.width = `${Math.min(100, (end / video.duration) * 100)}%`;
    }
  }

  function seekToClientX(clientX) {
    const rect = progressWrap.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (video.duration) video.currentTime = pct * video.duration;
  }

  let scrubbing = false;
  progressWrap.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    seekToClientX(e.clientX);
  });
  window.addEventListener('pointermove', (e) => {
    if (scrubbing) seekToClientX(e.clientX);
  });
  window.addEventListener('pointerup', () => { scrubbing = false; });
  progressWrap.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
    if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5);
  });

  function togglePlay() {
    if (video.paused) video.play().catch(() => {}); else video.pause();
  }
  playBtn.addEventListener('click', togglePlay);
  bigPlay.addEventListener('click', togglePlay);
  video.addEventListener('click', togglePlay);
  video.addEventListener('play', () => setPlayingIcon(true));
  video.addEventListener('pause', () => setPlayingIcon(false));
  video.addEventListener('timeupdate', updateProgress);
  video.addEventListener('loadedmetadata', updateProgress);
  video.addEventListener('progress', updateProgress);

  // volume
  const savedVol = localStorage.getItem(storageKey('volume'));
  if (savedVol !== null) video.volume = parseFloat(savedVol);
  const savedMuted = localStorage.getItem(storageKey('muted'));
  if (savedMuted === '1') video.muted = true;
  volumeSlider.value = String(video.volume);

  function updateVolumeIcon() {
    volumeBtn.innerHTML = icon(video.muted || video.volume === 0 ? 'mute' : 'volume');
  }
  updateVolumeIcon();
  volumeBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    localStorage.setItem(storageKey('muted'), video.muted ? '1' : '0');
    updateVolumeIcon();
  });
  volumeSlider.addEventListener('input', () => {
    video.volume = parseFloat(volumeSlider.value);
    video.muted = video.volume === 0;
    localStorage.setItem(storageKey('volume'), volumeSlider.value);
    localStorage.setItem(storageKey('muted'), video.muted ? '1' : '0');
    updateVolumeIcon();
  });

  // buffering spinner
  video.addEventListener('waiting', () => { spinner.hidden = false; });
  video.addEventListener('playing', () => { spinner.hidden = true; });
  video.addEventListener('canplay', () => { spinner.hidden = true; });

  // settings menu: qualidade + velocidade
  let qualityLevels = [];
  let currentQuality = -1; // auto
  const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];

  function renderSettingsMenu() {
    settingsMenu.innerHTML = '';

    if (qualityLevels.length > 1) {
      const qHeader = document.createElement('div');
      qHeader.className = 'vgl-settings-header';
      qHeader.textContent = 'Qualidade';
      settingsMenu.appendChild(qHeader);

      const autoItem = document.createElement('button');
      autoItem.type = 'button';
      autoItem.className = 'vgl-settings-item' + (currentQuality === -1 ? ' active' : '');
      autoItem.textContent = 'Automática';
      autoItem.addEventListener('click', () => {
        currentQuality = -1;
        engine.setQualityLevel(-1);
        localStorage.setItem(storageKey('quality'), '-1');
        renderSettingsMenu();
      });
      settingsMenu.appendChild(autoItem);

      qualityLevels.slice().sort((a, b) => (b.height || 0) - (a.height || 0)).forEach((lvl) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'vgl-settings-item' + (currentQuality === lvl.index ? ' active' : '');
        item.textContent = lvl.label;
        item.addEventListener('click', () => {
          currentQuality = lvl.index;
          engine.setQualityLevel(lvl.index);
          localStorage.setItem(storageKey('quality'), String(lvl.index));
          renderSettingsMenu();
        });
        settingsMenu.appendChild(item);
      });
    }

    const sHeader = document.createElement('div');
    sHeader.className = 'vgl-settings-header';
    sHeader.textContent = 'Velocidade';
    settingsMenu.appendChild(sHeader);
    speeds.forEach((sp) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'vgl-settings-item' + (video.playbackRate === sp ? ' active' : '');
      item.textContent = sp === 1 ? 'Normal' : `${sp}x`;
      item.addEventListener('click', () => {
        video.playbackRate = sp;
        renderSettingsMenu();
      });
      settingsMenu.appendChild(item);
    });
  }
  renderSettingsMenu();

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsMenu.hidden = !settingsMenu.hidden;
  });
  document.addEventListener('click', () => { settingsMenu.hidden = true; });

  // pip
  pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {}
  });

  // fullscreen
  function isFullscreen() {
    return document.fullscreenElement === root || document.webkitFullscreenElement === root;
  }
  fsBtn.addEventListener('click', async () => {
    try {
      if (isFullscreen()) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } else if (root.requestFullscreen) {
        await root.requestFullscreen();
      } else if (root.webkitRequestFullscreen) {
        root.webkitRequestFullscreen();
      } else if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen(); // iOS Safari
      }
    } catch {}
  });
  document.addEventListener('fullscreenchange', () => {
    fsBtn.innerHTML = icon(isFullscreen() ? 'exitFullscreen' : 'fullscreen');
    root.classList.toggle('vgl-fullscreen', isFullscreen());
  });

  // esconder controles quando ocioso, durante reprodução
  let idleTimer = null;
  function showControls() {
    root.classList.remove('vgl-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!video.paused) root.classList.add('vgl-idle');
    }, 2600);
  }
  ['mousemove', 'pointerdown', 'keydown', 'touchstart'].forEach((ev) => root.addEventListener(ev, showControls));
  showControls();

  // atalhos de teclado
  root.tabIndex = root.tabIndex || 0;
  root.addEventListener('keydown', (e) => {
    if (['INPUT', 'BUTTON'].includes(document.activeElement?.tagName)) return;
    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); togglePlay(); break;
      case 'm': video.muted = !video.muted; updateVolumeIcon(); break;
      case 'f': fsBtn.click(); break;
      case 'ArrowRight': video.currentTime = Math.min(video.duration || 0, video.currentTime + 5); break;
      case 'ArrowLeft': video.currentTime = Math.max(0, video.currentTime - 5); break;
      case 'ArrowUp': e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); volumeSlider.value = String(video.volume); break;
      case 'ArrowDown': e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); volumeSlider.value = String(video.volume); break;
      default: break;
    }
  });

  return {
    setQualityLevels(levels) {
      qualityLevels = levels || [];
      const saved = localStorage.getItem(storageKey('quality'));
      if (saved !== null && qualityLevels.some((l) => String(l.index) === saved)) {
        currentQuality = parseInt(saved, 10);
        engine.setQualityLevel(currentQuality);
      }
      renderSettingsMenu();
    },
    showError(message, onRetry) {
      errorBox.innerHTML = '';
      const msg = document.createElement('p');
      msg.textContent = message || 'Não foi possível carregar o vídeo.';
      errorBox.appendChild(msg);
      if (onRetry) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Tentar novamente';
        btn.className = 'vgl-btn vgl-error-retry';
        btn.addEventListener('click', onRetry);
        errorBox.appendChild(btn);
      }
      errorBox.hidden = false;
    },
    hideError() { errorBox.hidden = true; },
    setPlayingIcon,
    elements: { wrap, playBtn, bigPlay, spinner, errorBox, settingsMenu }
  };
}
