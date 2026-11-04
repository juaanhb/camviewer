'use strict';

const $ = (sel) => document.querySelector(sel);
const els = {
  liveBadge: $('#live-badge'),
  liveText: $('#live-text'),
  video: $('#video'),
  videoEmpty: $('#video-empty'),
  screen: document.querySelector('.screen'),
  audioBtn: $('#audio-btn'),
  fsBtn: $('#fs-btn'),
  talkBtn: $('#talk-btn'),
  connectForm: $('#connect-form'),
  connectBtn: $('#connect-btn'),
  disconnectBtn: $('#disconnect-btn'),
  log: $('#log'),
  camName: $('#cam-name'),
  info: {
    session: $('#i-session'), codec: $('#i-codec'), res: $('#i-res'),
    vframes: $('#i-vframes'), acodec: $('#i-acodec'), aframes: $('#i-aframes'),
  },
};

// Iconos Lucide (offline, vendor/lucide.js). setIcon cambia el icono de un botón.
lucide.createIcons();
function setIcon(el, name) {
  if (!el || el.dataset.icon === name) return;
  el.dataset.icon = name;
  el.innerHTML = `<i data-lucide="${name}"></i>`;
  lucide.createIcons();
}

const ctx2d = els.video.getContext('2d');
const BIN_VIDEO = 0x01;
const BIN_AUDIO = 0x02;
const BIN_AAC = 0x04;      // frame AAC crudo (se decodifica con WebCodecs)
const BIN_VIDEO_AU = 0x05; // unidad de acceso H.264/H.265 (WebCodecs); byte 1 = flags
// Códec de video para Información: familia, perfil y nivel del SPS, y el código de la app.
function videoLabel(s) {
  const fam = s.videoCodec === 'h265' ? 'H.265' : 'H.264';
  const code = s.videoCodec === 'h265' ? 5 : 3;
  return [fam, s.videoProfile, `(${code})`].filter(Boolean).join(' ');
}
const AUDIO_CODEC_NAMES = { 80: 'AAC', 81: 'G.711 μ-law', 82: 'G.711 A-law', 83: 'ADPCM', 84: 'PCM', 85: 'Speex', 86: 'MP3', 87: 'G.726' };
function audioCodecName(c) {
  if (c == null) return '—';
  return `${AUDIO_CODEC_NAMES[c] ?? 'desconocido'} (${c})`;
}
const AAC_CONFIG = { codec: 'mp4a.40.2', sampleRate: 8000, numberOfChannels: 1, description: new Uint8Array([0x15, 0x88]) }; // AudioSpecificConfig: LC, 8 kHz, mono
const BIN_TALK = 0x03;
const AUDIO_RATE = 8000;
const AUDIO_JITTER_S = 0.15; // colchón de audio: suma latencia fija a cambio de sonar continuo
const AUDIO_MAX_LEAD_S = 1.0; // si nos atrasamos más de esto, se reinicia el colchón

let state = {};
let heldDir = null;

// Utilidades

function log(message, kind = '', t = Date.now()) {
  const li = document.createElement('li');
  li.className = kind;
  const d = new Date(t);
  const p2 = (n) => String(n).padStart(2, '0');
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = message;
  li.append(ts, ' $ ', msg);
  els.log.prepend(li);
  while (els.log.children.length > 200) els.log.lastChild.remove();
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// WebSocket: dos conexiones

let ws = null;
let wsReady = false;
let aws = null;          // socket de audio
let awsReady = false;
let wantVideo = true;    // lo que el servidor debe enviar (el video siempre se pide mientras hay live)
let wantAudio = false;
let sentVideo = false;   // lo que ya le pedimos
let sentAudio = false;
let aacOk = false;       // el navegador puede decodificar AAC con WebCodecs
let aacDecoder = null;
let aacTs = 0;           // timestamp (µs) de los frames AAC

function wsSend(obj) {
  if (ws && wsReady) ws.send(JSON.stringify(obj));
}

function audioSend(obj) {
  if (aws && awsReady) aws.send(JSON.stringify(obj));
}

function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}`;
}

let wsDelay = 1000;
let awsDelay = 1000;

function connectWs() {
  ws = new WebSocket(wsUrl('/video'));
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    wsReady = true;
    wsDelay = 1000;
    sentVideo = false;
    log('Canal de video abierto');
    syncStreams();
  };
  ws.onclose = () => {
    wsReady = false;
    sentVideo = false;
    log(`Canal de video cerrado; reintento en ${wsDelay / 1000} s`, 'err');
    setTimeout(connectWs, wsDelay);
    wsDelay = Math.min(wsDelay * 2, 8000);
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      if (msg.type === 'error') log(msg.message, 'err');
      else if (msg.type === 'video_config') onVideoConfig(msg);
      return;
    }
    const bytes = new Uint8Array(e.data);
    if (bytes[0] === BIN_VIDEO) showFrame(bytes.subarray(1));
    else if (bytes[0] === BIN_VIDEO_AU) playVideoAu(bytes[1], bytes.subarray(2));
  };
}

function connectAudioWs() {
  aws = new WebSocket(wsUrl('/audio'));
  aws.binaryType = 'arraybuffer';
  aws.onopen = () => {
    awsReady = true;
    awsDelay = 1000;
    log('Canal de audio abierto');
    sentAudio = false;
    syncStreams();
  };
  aws.onclose = () => {
    awsReady = false;
    log(`Canal de audio cerrado; reintento en ${awsDelay / 1000} s`, 'err');
    sentAudio = false;
    setTimeout(connectAudioWs, awsDelay);
    awsDelay = Math.min(awsDelay * 2, 8000);
  };
  aws.onmessage = (e) => {
    if (typeof e.data === 'string') return;
    const bytes = new Uint8Array(e.data);
    if (bytes[0] === BIN_AUDIO) playAudio(bytes.subarray(1));
    else if (bytes[0] === BIN_AAC) playAacFrame(bytes.subarray(1));
  };
}

// Pide al servidor lo que el estado necesita (video/audio) y deja de pedir lo que ya no.
function syncStreams() {
  const live = !!(state.connected && state.live);
  if (wsReady) {
    if (live && wantVideo && !sentVideo) {
      wsSend({ op: 'video', fps: 8, width: 960, mode: forceJpeg ? 'jpeg' : 'annexb' });
      sentVideo = true;
    } else if ((!live || !wantVideo) && sentVideo) {
      wsSend({ op: 'video_stop' });
      sentVideo = false;
      closeVideoDecoder();
    }
  }
  if (awsReady && live && wantAudio !== sentAudio) {
    audioSend({ op: 'audio', on: wantAudio, mode: aacOk ? 'aac' : 'pcm' });
    sentAudio = wantAudio;
  }
  if (!live) sentAudio = false;
}

// Video: JPEG por WebSocket dibujado en un canvas

let drawing = false;
let pendingFrame = null;

async function showFrame(jpegBytes) {
  if (drawing) {
    pendingFrame = jpegBytes; // solo nos quedamos con el más reciente
    return;
  }
  drawing = true;
  try {
    const bmp = await createImageBitmap(new Blob([jpegBytes], { type: 'image/jpeg' }));
    if (els.video.width !== bmp.width || els.video.height !== bmp.height) {
      els.video.width = bmp.width;
      els.video.height = bmp.height;
    }
    ctx2d.drawImage(bmp, 0, 0);
    bmp.close();
  } catch {
    // frame corrupto: se ignora
  } finally {
    drawing = false;
    if (pendingFrame) {
      const next = pendingFrame;
      pendingFrame = null;
      showFrame(next);
    }
  }
}

// Audio de la cámara: PCM 8 kHz con colchón (Web Audio)

let playCtx = null;
let playTime = 0;

function ensurePlayCtx() {
  if (!playCtx) {
    playCtx = new AudioContext({ sampleRate: AUDIO_RATE });
    playTime = 0;
  }
  if (playCtx.state === 'suspended') playCtx.resume();
  return playCtx;
}

function playAudio(pcmBytes) {
  if (!wantAudio || !playCtx) return;
  const samples = new Int16Array(pcmBytes.buffer.slice(pcmBytes.byteOffset, pcmBytes.byteOffset + pcmBytes.byteLength));
  const floats = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768;
  playFloat(floats);
}

// Video: H.264 / H.265 (Annex B) por WebSocket, decodificado con WebCodecs.

const VIDEO_MAX_QUEUE = 6;   // cuadros en cola antes de descartar y pedir keyframe
const VIDEO_MAX_ERRORS = 3;  // errores seguidos antes de pasar a JPEG
let forceJpeg = !(window.VideoDecoder && window.EncodedVideoChunk);
let vConfig = null;          // VideoDecoderConfig validada por el navegador
let vdec = null;
let vNeedKey = true;         // no decodificamos deltas hasta un keyframe
let vErrors = 0;
let vTs = 0;
let vHevcStream = false; // el stream actual es H.265
let vCfgSeq = 0;             // descarta una configuración que ya no es la más reciente
let vSoftware = true;        // decodificador por software por defecto: la GPU de este equipo falla con el stream
let vLastCfg = null;         // último video_config, para reconfigurar tras un error
let vLastTypes = '';         // tipos de NAL del último AU enviado
let vAuCount = 0;            // AU recibidos
let vFirstFrame = true;
const vHead = (data, n = 12) => Array.from(data.subarray(0, n)).map((b) => b.toString(16).padStart(2, '0')).join(' ');

// Tipos de NAL de un AU (H.264: byte & 0x1f; H.265: (byte >> 1) & 0x3f). Sólo para el registro.
function nalTypes(data, hevc) {
  const out = [];
  for (let i = 0; i + 3 < data.length && out.length < 12; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))) {
      const h = data[i + (data[i + 2] === 1 ? 3 : 4)];
      out.push(hevc ? (h >> 1) & 0x3f : h & 0x1f);
      i += 2;
    }
  }
  return out.join(',');
}

function setForceJpeg(on) {
  forceJpeg = on;
  closeVideoDecoder();
  vConfig = null;
  sentVideo = false;         // reenvía la petición de video con el modo nuevo
  syncStreams();
}

async function onVideoConfig(msg) {
  closeVideoDecoder();
  vLastCfg = msg;
  log(`Video: configuración ${msg.codec}${msg.profile ? ' · ' + msg.profile : ''}${msg.level ? ' ' + msg.level : ''}`, 'ok');
  const seq = ++vCfgSeq;
  const base = {
    codec: msg.codec,
    optimizeForLatency: true,
    hardwareAcceleration: vSoftware ? 'prefer-software' : 'no-preference',
  };
  const config = msg.hevc ? { ...base, hevc: { format: 'annexb' } } : { ...base, avc: { format: 'annexb' } };
  let res;
  try {
    res = await VideoDecoder.isConfigSupported(config);
  } catch {
    res = { supported: false };
  }
  console.info('[video] video_config', msg, 'soportado:', res.supported, 'config aceptada:', res.config,
    'software:', vSoftware);
  if (seq !== vCfgSeq) return; // llegó otra configuración mientras validábamos
  if (!res.supported) {
    log(`Video: este navegador no decodifica ${msg.codec} (${msg.profile} ${msg.level}); se usa JPEG`, 'err');
    setForceJpeg(true);
    return;
  }
  vConfig = res.config;
  vHevcStream = !!msg.hevc;
  vErrors = 0;
  log(`Video: ${msg.profile} ${msg.level} (${msg.codec})${vSoftware ? ' por software' : ''}`, 'ok');
}

function createVideoDecoder() {
  vdec = new VideoDecoder({
    output: (frame) => {
      if (vFirstFrame) {
        vFirstFrame = false;
        console.info('[video] primer frame decodificado', frame.displayWidth + 'x' + frame.displayHeight, 'format', frame.format);
      }
      drawVideoFrame(frame);
    },
    error: (e) => {
      console.error('[video] error del decodificador:', e.name, e.message, {
        estado: vdec && vdec.state, colaDecode: vdec && vdec.decodeQueueSize,
        ultimoAU_NAL: vLastTypes, errores: vErrors + 1, software: vSoftware, codec: vConfig && vConfig.codec,
      });
      log(`Video WebCodecs: ${e.name}: ${e.message} · último AU: NAL [${vLastTypes}]`, 'err');
      vErrors++;
      closeVideoDecoder();
      // Primer error con GPU: reintentamos el mismo stream con decodificador por software.
      if (vErrors === 1 && !vSoftware && vLastCfg) {
        vSoftware = true;
        log('Video: reintento con decodificador por software', 'ok');
        onVideoConfig(vLastCfg);
        return;
      }
      if (vErrors >= VIDEO_MAX_ERRORS) setForceJpeg(true);
      else wsSend({ op: 'video_resync' });
    },
  });
  vdec.configure(vConfig);
  console.info('[video] decodificador creado', vConfig.codec, 'hardwareAcceleration:', vConfig.hardwareAcceleration || 'no-preference');
  vNeedKey = true;
  vTs = 0;
}

function playVideoAu(flags, data) {
  if (!vConfig) return; // aún no llega la configuración del stream
  const key = (flags & 1) === 1;
  if (!vdec) {
    if (!key) return;
    createVideoDecoder();
  }
  if (vdec.state !== 'configured') return;
  if (vNeedKey && !key) return;
  if (vdec.decodeQueueSize > VIDEO_MAX_QUEUE) {
    // Se atrasó: descartamos hasta el siguiente keyframe y pedimos resincronizar.
    if (!vNeedKey) wsSend({ op: 'video_resync' });
    vNeedKey = true;
    return;
  }
  vLastTypes = nalTypes(data, vHevcStream);
  vAuCount++;
  if (vAuCount <= 10 || key || vAuCount % 100 === 0) {
    console.info(`[video] AU #${vAuCount} ${key ? 'KEY' : 'delta'} ${data.length} bytes NAL [${vLastTypes}] inicio: ${vHead(data)}`);
  }
  try {
    vdec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: vTs, data }));
  } catch (e) {
    log(`Video WebCodecs: ${e.message}`, 'err');
    closeVideoDecoder();
    wsSend({ op: 'video_resync' });
    return;
  }
  vNeedKey = false;
  vTs += 40000; // 25 fps nominal: sólo importa el orden
}

function drawVideoFrame(frame) {
  if (els.video.width !== frame.displayWidth || els.video.height !== frame.displayHeight) {
    els.video.width = frame.displayWidth;
    els.video.height = frame.displayHeight;
  }
  ctx2d.drawImage(frame, 0, 0);
  frame.close();
}

function closeVideoDecoder() {
  if (vdec) { try { vdec.close(); } catch {} }
  vdec = null;
  vNeedKey = true;
}

// WebCodecs: decodifica AAC del audio de la cámara en el navegador (sin ffmpeg en el servidor).
function ensureAacDecoder() {
  if (aacDecoder) return aacDecoder;
  aacDecoder = new AudioDecoder({
    output: (ad) => {
      const floats = new Float32Array(ad.numberOfFrames);
      ad.copyTo(floats, { planeIndex: 0, format: 'f32-planar' });
      ad.close();
      playFloat(floats);
    },
    error: (e) => {
      log(`Audio AAC: ${e.message}`, 'err');
      aacDecoder = null;
      aacOk = false;
    },
  });
  aacDecoder.configure(AAC_CONFIG);
  return aacDecoder;
}

function playAacFrame(data) {
  if (!wantAudio || !playCtx) return;
  const dec = ensureAacDecoder();
  if (dec.state !== 'configured') return;
  dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: aacTs, data }));
  aacTs += 128000; // 1024 muestras a 8 kHz
}

// Programa un bloque de muestras float (8 kHz mono) con colchón.
function playFloat(out8k) {
  if (!wantAudio || !playCtx) return;
  const buf = playCtx.createBuffer(1, out8k.length, AUDIO_RATE);
  buf.getChannelData(0).set(out8k);

  const now = playCtx.currentTime;
  if (playTime < now + 0.01) playTime = now + AUDIO_JITTER_S; // se vació: reconstruye el colchón
  if (playTime - now > AUDIO_MAX_LEAD_S) playTime = now + AUDIO_JITTER_S; // se acumuló demasiado: corta

  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playCtx.destination);
  src.start(playTime);
  playTime += buf.duration;
}

function setAudioOn(on) {
  wantAudio = on;
  if (on) ensurePlayCtx();
  else {
    playTime = 0;
    aacTs = 0;
    if (aacDecoder) { try { aacDecoder.close(); } catch {} aacDecoder = null; }
  }
  syncStreams();
  render();
}

// Estado en vivo (SSE)

function render() {
  const s = state;
  const connected = !!s.connected;

  let badge = 'off', text = 'Desconectado';
  if (s.connecting) { badge = 'wait'; text = 'Conectando'; }
  else if (connected && s.live) { badge = 'on'; text = 'En vivo'; }
  else if (connected) { badge = 'wait'; text = 'Sin live'; }
  else if (s.lastError) { badge = 'err'; text = 'Error'; }
  els.liveBadge.className = `live-badge ${badge}`;
  els.liveText.textContent = text;

  els.info.session.textContent = connected && s.session != null ? String(s.session) : '—';
  els.info.codec.textContent = connected && s.videoCodec ? videoLabel(s) : '—';
  els.info.res.textContent = connected && s.width ? `${s.width}×${s.height}` : '—';
  els.info.vframes.textContent = connected ? String(s.videoFrames ?? 0) : '—';
  els.info.acodec.textContent = connected ? audioCodecName(s.audioCodecSeen ?? s.audioCodec) : '—';
  els.info.aframes.textContent = connected ? String(s.audioFrames ?? 0) : '—';
  els.camName.textContent = connected ? (s.did || '') : '';

  els.connectBtn.disabled = connected || s.connecting;
  els.disconnectBtn.disabled = !connected && !s.connecting;
  els.audioBtn.disabled = !connected;
  els.fsBtn.disabled = !connected;
  els.talkBtn.disabled = !connected || (s.talking === true && !talkActive);
  document.querySelectorAll('.dpad button').forEach((b) => {
    if (b.id !== 'talk-btn') b.disabled = !connected;
  });

  // Video: se muestra la capa de "sin señal" cuando no hay live
  const live = connected && s.live;
  els.videoEmpty.hidden = live;
  if (!live) els.video.getContext('2d').clearRect(0, 0, els.video.width, els.video.height);

  setIcon(els.audioBtn, wantAudio ? 'volume-2' : 'volume-x');
  els.audioBtn.title = wantAudio ? 'Silenciar audio' : 'Escuchar audio de la cámara';
  syncStreams();
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    const next = JSON.parse(e.data);
    const was = state;
    state = next;
    if (next.lastError && next.lastError !== was.lastError) log(next.lastError, 'err');
    render();
  };
  es.addEventListener('log', (e) => {
    const { t, level, msg } = JSON.parse(e.data);
    log(msg, level === 'err' ? 'err' : level === 'ok' ? 'ok' : '', t);
  });
  es.onerror = () => log('Conexión con el dashboard perdida; reintentando…', 'err');
}

// Conexión

const pwInput = document.getElementById('password');
const pwToggle = document.getElementById('pw-toggle');
pwToggle.addEventListener('click', () => {
  const show = pwInput.type === 'password';
  pwInput.type = show ? 'text' : 'password';
  pwToggle.title = show ? 'Ocultar contraseña' : 'Mostrar contraseña';
  pwToggle.setAttribute('aria-label', pwToggle.title);
  setIcon(pwToggle, show ? 'eye-off' : 'eye');
});

els.connectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(els.connectForm);
  const body = {
    did: f.get('did').trim(),
    password: f.get('password') || '',
    deviceType: (f.get('deviceType') || '43').trim(),
    userId: Number(f.get('userId') || 0),
    bridgeHost: (f.get('bridgeHost') || '127.0.0.1').trim(),
    bridgePort: Number(f.get('bridgePort') || 8766),
  };
  log(`Solicitud de conexión a ${body.did} vía ${body.bridgeHost}:${body.bridgePort}`);
  try {
    await api('/api/connect', body);
  } catch (err) {
    log(`No se pudo conectar: ${err.message}`, 'err');
  }
});

els.disconnectBtn.addEventListener('click', async () => {
  try {
    await api('/api/disconnect', {});
  } catch (err) {
    log(err.message, 'err');
  }
});

// Audio y pantalla completa (botones del reproductor)

els.audioBtn.addEventListener('click', () => {
  setAudioOn(!wantAudio);
  if (wantAudio) log('Audio de la cámara activado');
});

els.fsBtn.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await els.screen.requestFullscreen();
  } catch (err) {
    log(`Pantalla completa: ${err.message}`, 'err');
  }
});
document.addEventListener('fullscreenchange', () => {
  setIcon(els.fsBtn, document.fullscreenElement ? 'minimize' : 'maximize');
});

// Movimiento: mantener presionado para mover, soltar para parar

async function ptz(direction) {
  try {
    await api('/api/ptz', { direction, speed: 0 });
  } catch (err) {
    log(`PTZ ${direction}: ${err.message}`, 'err');
  }
}

document.querySelectorAll('.dpad .dir').forEach((btn) => {
  const dir = btn.dataset.dir;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    heldDir = dir;
    btn.classList.add('active');
    ptz(dir);
  });
  const release = () => {
    if (heldDir === null) return;
    btn.classList.remove('active');
    heldDir = null;
    ptz('stop');
  };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('lostpointercapture', release);
  btn.addEventListener('pointerleave', release);
});

// Voz: micrófono del navegador -> PCM s16le 8 kHz -> WebSocket -> altavoz

let talkActive = false;
let talkStream = null;
let talkCtx = null;
let talkProcessor = null;
let talkSource = null;
let talkBuf = [];
let talkBufLen = 0;
const TALK_CHUNK_BYTES = 1600; // 100 ms de PCM s16le a 8 kHz
const TALK_MAX_BUFFERED = 32 * 1024; // si el socket va atrasado, se descarta audio en vez de acumularlo

function sendTalkBytes(bytes) {
  if (!awsReady || aws.bufferedAmount > TALK_MAX_BUFFERED) return;
  const frame = new Uint8Array(bytes.length + 1);
  frame[0] = BIN_TALK;
  frame.set(bytes, 1);
  aws.send(frame);
}

function flushTalkBuf() {
  if (talkBufLen === 0) return;
  const out = new Uint8Array(talkBufLen);
  let off = 0;
  for (const part of talkBuf) { out.set(part, off); off += part.length; }
  talkBuf = [];
  talkBufLen = 0;
  sendTalkBytes(out);
}

async function startTalk() {
  if (talkActive || !state.connected) return;
  if (!awsReady) return log('Voz: sin conexión de audio con el dashboard', 'err');
  talkActive = true;
  log('Voz: transmitiendo al altavoz de la cámara');
  els.talkBtn.classList.add('active');
  try {
    audioSend({ op: 'talk_start' });
    talkStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    talkCtx = new AudioContext({ sampleRate: AUDIO_RATE });
    const source = talkCtx.createMediaStreamSource(talkStream);
    const processor = talkCtx.createScriptProcessor(512, 1, 1);
    const sink = talkCtx.createGain();
    sink.gain.value = 0;

    processor.onaudioprocess = (e) => {
      if (!talkActive) return;
      const input = e.inputBuffer.getChannelData(0);
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const bytes = new Uint8Array(out.buffer);
      talkBuf.push(bytes);
      talkBufLen += bytes.length;
      if (talkBufLen >= TALK_CHUNK_BYTES) flushTalkBuf();
    };
    source.connect(processor);
    processor.connect(sink);
    sink.connect(talkCtx.destination);
    talkProcessor = processor;
    talkSource = source;
    setIcon(els.talkBtn, 'circle-dot');
    log('Transmitiendo voz…');
  } catch (err) {
    log(`Voz: ${err.message}`, 'err');
    stopTalk();
  }
}

function stopTalk() {
  if (!talkActive) return;
  talkActive = false;
  log('Voz: transmisión detenida');
  els.talkBtn.classList.remove('active');
  setIcon(els.talkBtn, 'mic');
  if (talkProcessor) talkProcessor.disconnect();
  if (talkSource) talkSource.disconnect();
  if (talkStream) talkStream.getTracks().forEach((t) => t.stop());
  if (talkCtx) talkCtx.close().catch(() => {});
  talkProcessor = talkSource = talkStream = talkCtx = null;
  flushTalkBuf();
  audioSend({ op: 'talk_stop' });
  render();
}

els.talkBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  els.talkBtn.setPointerCapture(e.pointerId);
  startTalk();
});
els.talkBtn.addEventListener('pointerup', stopTalk);
els.talkBtn.addEventListener('pointercancel', stopTalk);
els.talkBtn.addEventListener('lostpointercapture', stopTalk);


// Comprueba si el navegador decodifica AAC (WebCodecs). Si sí, el servidor manda AAC crudo.
if (window.AudioDecoder && window.EncodedAudioChunk) {
  AudioDecoder.isConfigSupported(AAC_CONFIG)
    .then((r) => {
      aacOk = !!r.supported;
      if (aacOk) {
        sentAudio = false; // reenvía la petición de audio con modo 'aac'
        syncStreams();
      }
    })
    .catch(() => {});
}

connectWs();
connectAudioWs();
connectEvents();
api('/api/status').then((s) => { state = s; render(); }).catch(() => render());

// Modales de conexión y registro (barra superior)
{
  const connDlg = document.getElementById('conn-dialog');
  const logDlg = document.getElementById('log-dialog');
  document.getElementById('open-conn').addEventListener('click', () => connDlg.showModal());
  document.getElementById('open-log').addEventListener('click', () => logDlg.showModal());
}

log(`Dashboard listo · WebCodecs video ${window.VideoDecoder ? 'sí' : 'no'} · AudioDecoder ${window.AudioDecoder ? 'sí' : 'no'}`);
