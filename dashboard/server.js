'use strict';

// Dashboard web para la cámara. Sin dependencias: http nativo + ffmpeg + WebSocket propio.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { CamViewer } = require('../bridge/camviewer');
const { g711aToPcm16le } = require('../codecs/g711');
const { AacDecoder } = require('../codecs/aac');
const { processAu, newParamCache } = require('../codecs/video');

const AUDIO_CODEC_AAC = 80; // P2PKIT_CODEC_AUDIO_AAC (AVFrame en la app)
const AUDIO_CODEC_G711A = 82;
let vcache = newParamCache(); // SPS/PPS/VPS y configuración del video de la sesión actual
let aacDec = null;         // decodificador AAC de la sesión actual (ffmpeg)
const { acceptUpgrade } = require('./ws');

const { load: loadConfig } = require('../config');
const CONFIG = loadConfig();
const HOST = CONFIG.dashboard.host;
const PORT = Number(CONFIG.dashboard.port);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

// Tipos de mensaje binario
const BIN_VIDEO = 0x01;
const BIN_VIDEO_AU = 0x05; // unidad de acceso H.264/H.265 (Annex B); byte 1 = flags: bit0 keyframe, bit1 hevc
const BIN_AUDIO = 0x02;
const BIN_AAC = 0x04;      // frame AAC crudo: el navegador lo decodifica con WebCodecs
const BIN_TALK = 0x03;

// Límites de contrapresión: si el cliente va atrasado se descarta, no se acumula latencia.
const VIDEO_MAX_BUFFERED = 512 * 1024;
const AUDIO_MAX_BUFFERED = 128 * 1024;
const TALK_MAX_BACKLOG = 3;

// Estado

let cam = null;
let talkOwner = null; // conexión WS que tiene la voz; solo una a la vez
let state = freshState();
const sseClients = new Set();
const wsClients = new Set(); // { ws, ff, audioOn, talkBacklog, talkQ }

function freshState() {
  return {
    connected: false,
    connecting: false,
    live: false,
    talking: false,
    did: null,
    session: null,
    videoCodec: null,
    videoProfile: null,      // p. ej. 'Main 3.1' (del SPS)
    audioCodec: null,        // códec de audio que reporta la cámara en live-start
    audioCodecSeen: null,    // codecId de los frames de audio (primer frame)
    width: 0,
    height: 0,
    videoFrames: 0,
    audioFrames: 0,
    viewers: 0,
    lastError: null,
    since: null,
  };
}

function snapshot() {
  return { ...state, viewers: wsClients.size, talking: talkOwner !== null };
}

function setState(patch) {
  state = { ...state, ...patch };
  broadcast();
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// Registro del dashboard: se envía a los clientes como evento "log" (SSE) y también a la consola.
function emitLog(level, msg) {
  const payload = `event: log\ndata: ${JSON.stringify({ t: Date.now(), level, msg })}\n\n`;
  for (const res of sseClients) res.write(payload);
  console.log(`[${level}] ${msg}`);
}

let statsPrev = { v: 0, a: 0, t: Date.now() };
setInterval(() => {
  if (!state.connected) return;
  const now = Date.now();
  const dt = Math.max(0.001, (now - statsPrev.t) / 1000);
  const dv = Math.max(0, state.videoFrames - statsPrev.v);
  const da = Math.max(0, state.audioFrames - statsPrev.a);
  emitLog('info', `Stream: video ${(dv / dt).toFixed(1)} fps · audio ${(da / dt).toFixed(1)} paquetes/s · visores ${wsClients.size}`);
  statsPrev = { v: state.videoFrames, a: state.audioFrames, t: now };
}, 5000).unref();

// Contadores cambian muchas veces por segundo; se publican cada segundo.
setInterval(() => {
  if (state.connected) broadcast();
}, 1000).unref();

// Conexión con la cámara

async function connectCamera(config) {
  if (cam) await disconnectCamera();
  setState({ connecting: true, lastError: null, did: config.did });
  emitLog('info', `Conectando a ${config.bridgeHost}:${config.bridgePort} · DID ${config.did} · tipo ${config.deviceType} · usuario ${config.userId}`);
  statsPrev = { v: 0, a: 0, t: Date.now() };
  vcache = newParamCache();

  const client = new CamViewer(config);
  try {
    await client.connect();
    emitLog('ok', `Login correcto · sesión ${client.session}`);
    // Los listeners se registran antes de startLive para no perder frames.
    client.on('video', (frame) => {
      state.videoFrames++;
      const hevc = frame.codec === 'h265';
      const keyframe = !!frame.keyframe;
      // Parámetros (SPS/PPS/VPS) y configuración del stream; sólo se procesa una vez por frame.
      const au = processAu(frame.data, hevc, vcache, keyframe);
      if (au.config) setState({ videoProfile: `${au.config.profile} ${au.config.level}` });
      const flags = (keyframe ? 1 : 0) | (hevc ? 2 : 0);
      for (const conn of wsClients) {
        if (conn.videoMode === 'annexb') {
          if (conn.waitKey) {
            if (!keyframe) continue;
            conn.waitKey = false;
          }
          if (conn.ws.bufferedAmount > VIDEO_MAX_BUFFERED) {
            conn.waitKey = true; // se atrasó: descarta hasta el siguiente keyframe
            continue;
          }
          if (conn.cfgKey !== vcache.configKey) sendVideoConfig(conn);
          if (conn.cfgKey !== vcache.configKey) continue; // aún no hay configuración
          conn.ws.sendBinary(Buffer.concat([Buffer.from([BIN_VIDEO_AU, flags]), au.data]));
        } else if (conn.ff && conn.ff.stdin.writable && conn.ff.stdin.writableLength < VIDEO_MAX_BUFFERED) {
          conn.ff.stdin.write(frame.data);
        }
      }
    });
    client.on('audio', (frame) => {
      state.audioFrames++;
      if (state.audioCodecSeen !== frame.codecId) {
        state.audioCodecSeen = frame.codecId;
        broadcast();
      }
      if (frame.codecId === AUDIO_CODEC_AAC) {
        let needPcm = false;
        for (const conn of wsClients) {
          if (!conn.audioOn) continue;
          if (conn.audioMode === 'aac') {
            if (conn.ws.bufferedAmount <= AUDIO_MAX_BUFFERED) {
              conn.ws.sendBinary(Buffer.concat([Buffer.from([BIN_AAC]), frame.data]));
            }
          } else {
            needPcm = true;
          }
        }
        // Sólo decodificamos con ffmpeg si hay clientes que no pueden decodificar AAC.
        if (needPcm) {
          if (!aacDec) {
            aacDec = new AacDecoder();
            aacDec.on('pcm', (pcm) => sendAudioPcm(pcm, { pcmOnly: true }));
            aacDec.on('log', (msg) => console.error(`[aac] ${msg}`));
          }
          aacDec.write(frame.data);
        }
      } else {
        // G.711 A-law (82). Otros códecs aún no se decodifican: se tratan como A-law.
        sendAudioPcm(g711aToPcm16le(frame.data));
      }
    });
    client.on('error', (err) => {
      console.error(`[live] ERROR ${new Date().toLocaleTimeString()}: ${err.message}`);
      emitLog('err', `Live detenido: ${err.message}`);
      closeStreams();
      setState({ live: false, lastError: `Live detenido: ${err.message}` });
    });

    let info;
    try {
      info = await client.startLive();
    } catch (err) {
      throw new Error(`login OK, pero live-start sin respuesta de la cámara (${err.message})`);
    }
    cam = client;
    setState({
      connected: true,
      connecting: false,
      live: true,
      session: client.session,
      videoCodec: info.videoCodec,
      audioCodec: info.audioCodec,
      width: info.width,
      height: info.height,
      videoFrames: 0,
      audioFrames: 0,
      since: new Date().toISOString(),
    });
    emitLog('ok', `Live activo · ${info.videoCodec} ${info.width}×${info.height} · audio códec ${info.audioCodec}`);
    return info;
  } catch (err) {
    await client.close().catch(() => {});
    setState({ connecting: false, connected: false, live: false, lastError: err.message });
    throw err;
  }
}

// Detiene video (ffmpeg) y audio de todos los clientes WS y la voz. La conexión WS sigue abierta.
function sendVideoConfig(conn) {
  const c = vcache.config;
  if (!c) return;
  conn.cfgKey = vcache.configKey;
  conn.ws.sendText(JSON.stringify({ type: 'video_config', codec: c.codec, hevc: c.hevc, profile: c.profile, level: c.level }));
}

function sendAudioPcm(pcm, { pcmOnly = false } = {}) {
  for (const conn of wsClients) {
    if (!conn.audioOn || (pcmOnly && conn.audioMode === 'aac')) continue;
    if (conn.ws.bufferedAmount > AUDIO_MAX_BUFFERED) continue;
    conn.ws.sendBinary(Buffer.concat([Buffer.from([BIN_AUDIO]), pcm]));
  }
}

function closeStreams() {
  for (const conn of wsClients) {
    stopVideo(conn);
    conn.audioOn = false;
  }
  if (aacDec) { aacDec.close(); aacDec = null; }
  talkOwner = null;
}

async function disconnectCamera() {
  const client = cam;
  cam = null;
  if (client) emitLog('info', 'Desconectando de la cámara…');
  closeStreams();
  if (client) await client.close().catch(() => {});
  setState({ ...freshState(), lastError: state.lastError });
  if (client) emitLog('info', 'Desconectado');
}

function requireCamera() {
  if (!cam || !state.connected) {
    const err = new Error('no conectado a la cámara');
    err.status = 409;
    throw err;
  }
  return cam;
}

// WebSocket: un cliente = { ws, ff, audioOn, talkBacklog, talkQ }

function onWsConnection(ws) {
  const conn = { ws, ff: null, audioOn: false, talkBacklog: 0, talkQ: Promise.resolve() };
  wsClients.add(conn);
  emitLog('info', `Canal WS abierto · ${wsClients.size} activo(s)`);
  broadcast();

  ws.on('message', (msg) => {
    handleWsMessage(conn, msg).catch((err) => sendWsError(conn, err.message));
  });
  ws.on('close', () => {
    emitLog('info', `Canal WS cerrado · ${Math.max(0, wsClients.size - 1)} activo(s)`);
    stopVideo(conn);
    if (talkOwner === conn) {
      talkOwner = null;
      if (cam) cam.endTalk().catch(() => {});
    }
    wsClients.delete(conn);
    broadcast();
  });
}

function sendWsError(conn, message) {
  conn.ws.sendText(JSON.stringify({ type: 'error', message }));
}

async function handleWsMessage(conn, msg) {
  if (typeof msg === 'string') {
    let req;
    try {
      req = JSON.parse(msg);
    } catch {
      throw new Error('mensaje JSON inválido');
    }
    return handleWsOp(conn, req);
  }

  // binario: solo voz
  if (msg[0] !== BIN_TALK) throw new Error('tipo de mensaje binario desconocido');
  if (talkOwner !== conn) throw new Error('la voz no está iniciada en esta conexión');
  if (conn.talkBacklog >= TALK_MAX_BACKLOG) return; // atrasado: se descarta este bloque
  const pcm = msg.subarray(1);
  conn.talkBacklog++;
  conn.talkQ = conn.talkQ
    .then(() => cam && cam.talkChunk(pcm))
    .catch((err) => sendWsError(conn, `voz: ${err.message}`))
    .finally(() => {
      conn.talkBacklog--;
    });
}

async function handleWsOp(conn, req) {
  switch (req.op) {
    case 'video': {
      requireCamera();
      stopVideo(conn);
      emitLog('info', req.mode === 'annexb'
        ? 'Video: WebCodecs (Annex B) solicitado por un visor'
        : `Video: JPEG ${clamp(Number(req.fps || 8), 1, 15)} fps solicitado por un visor`);
      if (req.mode === 'annexb') {
        // El navegador decodifica con WebCodecs: unidades H.264/H.265 (Annex B) sin ffmpeg.
        conn.videoMode = 'annexb';
        conn.cfgKey = null;
        conn.waitKey = true; // no mandamos deltas hasta el primer keyframe
      } else {
        startVideo(conn, clamp(Number(req.fps || 8), 1, 15), clamp(Number(req.width || 960), 160, 1920));
      }
      return;
    }
    case 'video_resync':
      // El navegador perdió la secuencia: espera el siguiente keyframe.
      if (conn.videoMode === 'annexb') conn.waitKey = true;
      return;
    case 'video_stop':
      stopVideo(conn);
      return;
    case 'audio':
      conn.audioOn = !!req.on;
      conn.audioMode = req.mode === 'aac' ? 'aac' : 'pcm'; // 'aac' = el navegador decodifica
      emitLog('info', `Audio ${conn.audioOn ? 'activado' : 'desactivado'} · modo ${conn.audioMode}`);
      return;
    case 'talk_start': {
      const client = requireCamera();
      if (talkOwner && talkOwner !== conn) throw new Error('ya hay una transmisión de voz activa');
      if (talkOwner !== conn) {
        await client.beginTalk();
        talkOwner = conn;
        setState({ talking: true });
        emitLog('info', 'Voz: transmisión iniciada desde el navegador');
      }
      return;
    }
    case 'talk_stop': {
      if (talkOwner !== conn) return;
      await conn.talkQ; // espera a que salgan los chunks pendientes
      if (cam) await cam.endTalk().catch(() => {});
      talkOwner = null;
      setState({ talking: false });
      emitLog('info', 'Voz: transmisión detenida');
      return;
    }
    default:
      throw new Error(`operación desconocida: ${req.op}`);
  }
}

// Video: H.265/H.264 -> JPEG por cliente (ffmpeg), enviado como binario

function startVideo(conn, fps, width) {
  const codec = state.videoCodec === 'h264' ? 'h264' : 'hevc';
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    // sin probing: un stream en vivo no debe esperar 5 s de análisis antes del primer frame
    '-analyzeduration', '0', '-probesize', '32',
    '-f', codec, '-i', 'pipe:0',
    '-vf', `fps=${fps},scale=${width}:-1`,
    '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  ff.stdin.on('error', () => {});
  conn.ff = ff;

  const split = jpegSplitter((jpeg) => {
    if (conn.ff !== ff || conn.ws.bufferedAmount > VIDEO_MAX_BUFFERED) return; // descarta si va atrasado
    conn.ws.sendBinary(Buffer.concat([Buffer.from([BIN_VIDEO]), jpeg]));
  });
  ff.stdout.on('data', split);
  ff.on('exit', () => {
    if (conn.ff === ff) conn.ff = null;
  });
}

function stopVideo(conn) {
  conn.videoMode = null;
  conn.waitKey = false;
  if (!conn.ff) return;
  killFfmpeg(conn.ff);
  conn.ff = null;
}

// Mata ffmpeg y cierra sus pipes; si no, el proceso y sus sockets siguen vivos.
function killFfmpeg(ff) {
  ff.stdin.destroy();
  ff.stdout.destroy();
  if (ff.exitCode === null && ff.signalCode === null) ff.kill('SIGKILL');
}

// Separa el flujo de JPEG pegados (FFD8 ... FFD9) y entrega cada imagen completa.
function jpegSplitter(onJpeg) {
  const SOI = Buffer.from([0xff, 0xd8]);
  const EOI = Buffer.from([0xff, 0xd9]);
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const start = buf.indexOf(SOI);
      if (start < 0) {
        // conserva un 0xFF final que podría ser el inicio de un SOI
        buf = buf.length && buf[buf.length - 1] === 0xff ? buf.subarray(buf.length - 1) : Buffer.alloc(0);
        return;
      }
      if (start > 0) buf = buf.subarray(start);
      const end = buf.indexOf(EOI, 2);
      if (end < 0) return;
      onJpeg(buf.subarray(0, end + 2));
      buf = buf.subarray(end + 2);
    }
  };
}

// API JSON

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('cuerpo demasiado grande'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON inválido'), { status: 400 });
  }
}

function defaultConfig(body) {
  const cam = CONFIG.camera;
  return {
    did: body.did || cam.did,
    password: body.password ?? cam.password,
    deviceType: body.deviceType || cam.deviceType,
    userId: Number(body.userId ?? cam.userId),
    bridgeHost: body.bridgeHost || CONFIG.bridge.host,
    bridgePort: Number(body.bridgePort || CONFIG.bridge.port),
  };
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/status') return sendJson(res, 200, snapshot());

  if (route === 'GET /api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  const body = await readJson(req);

  if (route === 'POST /api/connect') {
    const config = defaultConfig(body);
    if (!config.did) return sendError(res, 400, 'falta el DID');
    const info = await connectCamera(config);
    return sendJson(res, 200, { ok: true, ...info });
  }

  if (route === 'POST /api/disconnect') {
    await disconnectCamera();
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/ptz') {
    emitLog('info', `PTZ: ${body.direction}`);
    await requireCamera().ptz(body.direction, { speed: clamp(Number(body.speed || 0), 0, 255) });
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/move') {
    emitLog('info', `Mover: ${body.direction} · ${clamp(Number(body.ms || 300), 0, 5000)} ms`);
    await requireCamera().move(body.direction, clamp(Number(body.ms || 300), 0, 5000));
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'POST /api/volume') {
    emitLog('info', `Volumen: entrada ${Number(body.in ?? 80)} · salida ${Number(body.out ?? 80)}`);
    await requireCamera().setVolume(Number(body.in ?? 80), Number(body.out ?? 80));
    return sendJson(res, 200, { ok: true });
  }

  return sendError(res, 404, 'ruta no encontrada');
}

// HTTP

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  if (res.headersSent) return res.end();
  sendJson(res, status, { ok: false, error: message });
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function serveStatic(res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return sendError(res, 403, 'prohibido');
  fs.readFile(full, (err, data) => {
    if (err) return sendError(res, 404, 'no encontrado');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method === 'GET') return serveStatic(res, url.pathname);
    return sendError(res, 405, 'método no permitido');
  } catch (err) {
    sendError(res, err.status || 500, err.message);
  }
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  // /video: control y video. /audio: audio de la cámara y voz.
  if (url.pathname !== '/video' && url.pathname !== '/audio') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  const conn = acceptUpgrade(req, socket);
  if (conn) onWsConnection(conn);
});

function start(port = PORT, host = HOST) {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const lan = Object.values(require('os').networkInterfaces()).flat()
        .find((i) => i && i.family === 'IPv4' && !i.internal);
      console.log(`camviewer v${require('../package.json').version}`);
      console.log(`Dashboard: http://${HOST === '0.0.0.0' && lan ? lan.address : 'localhost'}:${addr.port}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  start();
  const shutdown = async () => {
    await disconnectCamera();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { start, server, jpegSplitter };
