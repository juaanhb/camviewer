'use strict';

// Cliente simple para la cámara V360 Pro / CloudBirds.

const net = require('net');
const { EventEmitter } = require('events');
const { pcm16leToG711a } = require('../codecs/g711');

// Claves de inicialización de PPCS (mismas que ppcs_bridge.py), en base64 para no dejarlas en texto plano.
const k64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const INIT_KEY = k64('RUVHREZIQkxLR0pJR0VKQ0VDSElGRkVLSEtOQUhCTkFIQUZKQkVDRkFESkVMT0xERFBBS0NIT0VHQ0xHSlBMREFDTUNLT0RHT0dNTkJIQ0NKRE1I');
const NEW_INIT_KEY = k64('RUlIR0ZPQkNLSUlNR01KQ0VESEpGQUVJR0FOSEhFTk1ITUZBQk1EREFLSkpMSEtEREhBQ0RFUEJHS0xPSU9MSkFLTkFLQURPT0pOSkJNQ0xKR01D');
const NEW_INIT_2_KEY = k64('RUVHREZIQk9LQUlFR0hKTEVJSENGUEVBSEVOT0hOTkhHSkZQQkZDTkFMSkVMREtIREVBQ0NPUEdHSUxQSVBMTUFMTUpLRkROT1BNQUJLQ0pKS05LSkE=');

// Canales PPCS.
const CH_COMMAND = 0;
const CH_TALK = 1;
const CH_LIVE = 2;

// Constantes del protocolo.
const CMD_MAGIC = 0x76768888;
const FLAG_VIDEO = 428216305;
const FLAG_AUDIO = 428216306;
const CODEC_G711A = 82;
const VIDEO_CODEC_H264 = 3;
const VIDEO_CODEC_H265 = 5;
const KEYFRAME_TYPES = new Set([1, 17]); // H.264 I, H.265 I
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const CMD = {
  LIVE_START: 0x0001,
  LIVE_STOP: 0x0003,
  SPEAKER_START: 0x0006,
  SPEAKER_STOP: 0x0007,
  LOGIN: 0x0010,
  PTZ: 0x1001,
  SET_VOLUME: 0x811a,
};

// Dirección PTZ -> código (igual que protocol.Direction).
const DIRECTIONS = {
  stop: 0,
  up: 1,
  down: 2,
  left: 3,
  'up-left': 4,
  'down-left': 5,
  right: 6,
  'up-right': 7,
  'down-right': 8,
};

// Tipos de dispositivo de bajo consumo (usan connect_mode 126 en vez de 1).
const LOW_POWER_DEVICE_TYPES = new Set([
  '09', '18', '19', '24', '32', '39', '49', '51', '53', '55', '60', '61', '62', '63', '64', '65', '68', '69',
  '70', '71', '72', '73', '74', '75', '76', '81', '82', '85', '86', '87', '88', '107', '108', '109', '110',
  '111', '112', '113', '114', '125', '126', '127', '128', '129', '130', '131', '132', '133', '134', '135',
  '136', '137', '138', '139', '140', '141', '148', '149', '150', '159', '160', '161', '162', '163', '164',
  '165', '166', '167', '168', '169', '170', '171', '172', '181', '182',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Construcción de frames (equivalente a protocol.py / client.py)

function commandFrame(cmd, payload) {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(CMD_MAGIC, 0);
  header.writeUInt32LE(payload.length, 4);
  header.writeUInt32LE(cmd, 8);
  return Buffer.concat([header, payload]);
}

function ptzPayload(direction, speed = 0, channel = 0) {
  return Buffer.from([direction, 0x08, 0, 0, 0, speed & 0xff, channel & 0xff, 0]);
}

function loginPayload(password, share = false, userId = 0) {
  const pass = Buffer.from(String(password), 'utf8');
  if (pass.length > 64) throw new Error('password must fit in 64 bytes');
  const out = Buffer.alloc(72);
  pass.copy(out, 0);
  out[64] = share ? 0xef : 0;
  out.writeUInt32LE(userId >>> 0, 68);
  return out;
}

function liveStartPayload(resolution = 1, streamType = 2, channel = 0) {
  const out = Buffer.alloc(20);
  out.writeUInt32LE(resolution, 0);
  out.writeUInt32LE(streamType, 4);
  out.writeUInt32LE(channel, 8);
  return out;
}

function u32Payload(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

function speakerStartPayload() {
  // pack("<III4x", 0, G711A, 320)
  const out = Buffer.alloc(16);
  out.writeUInt32LE(0, 0);
  out.writeUInt32LE(CODEC_G711A, 4);
  out.writeUInt32LE(320, 8);
  return out;
}

function volumePayload(audioIn, audioOut) {
  const out = Buffer.alloc(8);
  out.writeUInt32LE(audioIn >>> 0, 0);
  out.writeUInt32LE(audioOut >>> 0, 4);
  return out;
}

function talkFrame(alaw, pts) {
  // pack("<IIII", AUDIO_FLAG, len, pts, codec) + data
  const header = Buffer.alloc(16);
  header.writeUInt32LE(FLAG_AUDIO, 0);
  header.writeUInt32LE(alaw.length, 4);
  header.writeUInt32LE(pts >>> 0, 8);
  header.writeUInt32LE(CODEC_G711A, 12);
  return Buffer.concat([header, alaw]);
}

function parseLiveHeader(buf) {
  if (buf.length !== 32) throw new Error('live AV header must be 32 bytes');
  return {
    flag: buf.readUInt32LE(0),
    length: buf.readUInt32LE(4),
    pts: buf.readUInt32LE(8),
    frameType: buf.readUInt32LE(12),
    codecId: buf.readUInt32LE(24),
  };
}

function parseLiveStartResponse(payload) {
  if (payload.length < 24) throw new Error('live start response too short');
  const off = payload.length >= 28 ? 4 : 0;
  return {
    videoCodec: payload.readUInt32LE(off),
    width: payload.readUInt32LE(off + 4),
    height: payload.readUInt32LE(off + 8),
    audioCodec: payload.readUInt32LE(off + 12),
    result: payload.readUInt32LE(off + 16),
  };
}

function parseLoginResponse(payload) {
  if (payload.length < 12) throw new Error('login response too short');
  return {
    ret: payload.length >= 16 ? payload.readUInt8(4) : payload.readInt32LE(0),
    token: payload.readUInt32LE(8),
  };
}

function parseDirection(direction) {
  if (typeof direction === 'number') return direction;
  const key = String(direction).trim().toLowerCase().replace(/_/g, '-');
  if (key === 'forward') return DIRECTIONS.up;
  if (key === 'back' || key === 'backward') return DIRECTIONS.down;
  if (key === 'none') return DIRECTIONS.stop;
  if (!(key in DIRECTIONS)) {
    throw new Error(`dirección desconocida "${direction}". Usa: ${Object.keys(DIRECTIONS).join(', ')}`);
  }
  return DIRECTIONS[key];
}

function serverKeyFor(did) {
  return /^(BFEP|CFET|CFMT|CFCD|NFET)/.test(did) ? NEW_INIT_KEY : NEW_INIT_2_KEY;
}

function connectModeFor(deviceType) {
  const type = deviceType == null ? '' : String(deviceType).trim();
  return type === '39' || LOW_POWER_DEVICE_TYPES.has(type) ? 126 : 1;
}

// Transporte: una conexión TCP por petición (igual que ppcs_bridge.py)

class BridgeClient {
  constructor({ host = '127.0.0.1', port = 8766, timeout = 5000 } = {}) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
  }

  request(req, timeoutMs = 0) {
    const socketTimeout = Math.max(this.timeout, timeoutMs ? timeoutMs + 3000 : 0);
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      const chunks = [];
      let done = false;
      const finish = (err, value) => {
        if (done) return;
        done = true;
        sock.destroy();
        if (err) reject(err);
        else resolve(value);
      };

      sock.setTimeout(socketTimeout, () => finish(new Error(`bridge timeout (${req.op})`)));
      sock.on('error', (err) => finish(err));
      sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
      sock.on('data', (chunk) => {
        chunks.push(chunk);
        if (chunk.indexOf(0x0a) < 0) return; // la respuesta termina en '\n'
        const buf = Buffer.concat(chunks);
        let resp;
        try {
          resp = JSON.parse(buf.subarray(0, buf.indexOf(0x0a)).toString('utf8'));
        } catch {
          return finish(new Error('bridge returned invalid JSON'));
        }
        if (!resp.ok) return finish(new Error(resp.error || `bridge ${req.op} failed`));
        finish(null, resp);
      });
      sock.on('close', () => finish(new Error(`bridge closed without response (${req.op})`)));
    });
  }
}

// Cliente de alto nivel

// Eventos del live: 'video', 'audio', 'error' y 'close'.
class CamViewer extends EventEmitter {
  constructor({
    did,
    password = '',
    deviceType = '43',
    userId = 0,
    share = false,
    bridgeHost = '127.0.0.1',
    bridgePort = 8766,
    timeout = 5000,
  }) {
    super();
    if (!did) throw new Error('did es obligatorio');
    this.did = did;
    this.password = password;
    this.deviceType = deviceType;
    this.userId = userId;
    this.share = share;
    this.bridge = new BridgeClient({ host: bridgeHost, port: bridgePort, timeout });

    this.session = null;
    this.videoCodec = null; // 'h264' | 'h265'
    this.live = false;
    this.talking = false;
    this._talkPts = 0;
    this._talkPending = Buffer.alloc(0);
  }

  // Conecta por PPCS y hace login.
  async connect() {
    if (this.session !== null) return this;
    await this.bridge.request({ op: 'init', init_key: INIT_KEY });

    // Mismos modos que el backend Python (_agent_connect_mode_candidates): primario y luego 0.
    const primary = connectModeFor(this.deviceType);
    const modes = [primary, 0];
    let lastError = null;
    for (const mode of modes) {
      try {
        const resp = await this.bridge.request(
          { op: 'connect', did: this.did, connect_mode: mode, server_key: serverKeyFor(this.did) },
          30000,
        );
        if (resp.check_ret != null && Number(resp.check_ret) < 0) {
          throw new Error(`sesión PPCS no válida (check_ret ${resp.check_ret})`);
        }
        this.session = Number(resp.session);
        break;
      } catch (err) {
        lastError = err;
        await sleep(750);
      }
    }
    if (this.session === null) throw lastError;

    // Si el login no responde, se cierra la sesión PPCS.
    await sleep(1500);
    const loginFrame = commandFrame(CMD.LOGIN, loginPayload(this.password, this.share, this.userId));
    try {
      let resp;
      try {
        resp = await this._command(CMD.LOGIN, loginPayload(this.password, this.share, this.userId));
      } catch {
        // un reintento: se reenvía el login y se vuelve a leer la respuesta
        await this._write(CH_COMMAND, loginFrame);
        resp = await this._readCommandResponse(10000);
      }
      this.login = parseLoginResponse(resp.payload);
    } catch (err) {
      await this.close();
      throw new Error(`login sin respuesta de la cámara (${err.message}). Revisa la contraseña y que ninguna otra app esté conectada.`);
    }
    // ret según la app oficial (Connect.java): 0 = OK, 1 = contraseña incorrecta, otro = demasiados clientes.
    if (this.login.ret !== 0) {
      await this.close();
      throw new Error(this.login.ret === 1
        ? 'contraseña incorrecta (la cámara respondió ret 1)'
        : `login rechazado por la cámara (ret ${this.login.ret}): posiblemente demasiados clientes conectados`);
    }
    return this;
  }

  // Inicia el flujo de video y audio. Emite 'video' y 'audio'.
  async startLive({ resolution = 1, streamType = 2, channel = 0 } = {}) {
    this._requireSession();
    const resp = await this._command(CMD.LIVE_START, liveStartPayload(resolution, streamType, channel));
    const info = parseLiveStartResponse(resp.payload);
    this.videoCodec = info.videoCodec === VIDEO_CODEC_H264 ? 'h264' : 'h265';
    if (!this.live) {
      this.live = true;
      this._liveLoop(); // corre en segundo plano
    }
    return {
      videoCodec: this.videoCodec,
      width: info.width,
      height: info.height,
      audioCodec: info.audioCodec,
      result: info.result,
    };
  }

  // Detiene el flujo de video y audio.
  async stopLive() {
    if (!this.live) return;
    this.live = false;
    await this._write(CH_COMMAND, commandFrame(CMD.LIVE_STOP, u32Payload(0)));
  }

  // Envía un comando PTZ continuo (no se detiene solo).
  async ptz(direction, { speed = 0, channel = 0 } = {}) {
    this._requireSession();
    const dir = parseDirection(direction);
    await this._write(CH_COMMAND, commandFrame(CMD.PTZ, ptzPayload(dir, speed, channel)));
  }

  // Mueve en una dirección durante `ms` milisegundos y luego para.
  async move(direction, ms = 300, opts = {}) {
    await this.ptz(direction, opts);
    await sleep(Math.max(0, Math.min(ms, 5000)));
    await this.ptz('stop', { channel: opts.channel || 0 });
  }

  // Ajusta volumen de entrada y salida de la cámara (0-100).
  async setVolume(audioIn, audioOut = audioIn) {
    this._requireSession();
    const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
    await this._write(CH_COMMAND, commandFrame(CMD.SET_VOLUME, volumePayload(clamp(audioIn), clamp(audioOut))));
  }

  // Inicia la transmisión de voz al altavoz de la cámara.
  async beginTalk() {
    this._requireSession();
    if (this.talking) throw new Error('ya hay una transmisión de voz activa');
    await this._write(CH_COMMAND, commandFrame(CMD.SPEAKER_START, speakerStartPayload()));
    this.talking = true;
    this._talkPts = 0;
    this._talkPending = Buffer.alloc(0);
  }

  // Envía un bloque de PCM s16le 8 kHz mono; se parte en frames de 20 ms.
  async talkChunk(pcm) {
    if (!this.talking) throw new Error('no hay transmisión de voz activa');
    this._talkPending = Buffer.concat([this._talkPending, Buffer.from(pcm)]);
    while (this._talkPending.length >= 320) { // 160 muestras = 20 ms
      const frame = this._talkPending.subarray(0, 320);
      this._talkPending = this._talkPending.subarray(320);
      await this._sendTalkFrame(frame);
      await sleep(20);
    }
  }

  // Termina la transmisión: envía lo que quedó y detiene el altavoz.
  async endTalk() {
    if (!this.talking) return;
    try {
      const rest = this._talkPending;
      this._talkPending = Buffer.alloc(0);
      if (rest.length >= 2) await this._sendTalkFrame(rest.subarray(0, rest.length - (rest.length % 2)));
    } finally {
      this.talking = false;
      await this._write(CH_COMMAND, commandFrame(CMD.SPEAKER_STOP, u32Payload(0))).catch(() => {});
    }
  }

  // Transmite un iterable/stream de PCM s16le 8 kHz mono (usado por el CLI y las pruebas).
  async talk(source) {
    await this.beginTalk();
    try {
      for await (const chunk of source) await this.talkChunk(chunk);
    } finally {
      await this.endTalk();
    }
  }

  // Cierra el live, el talk y la sesión PPCS.
  async close() {
    if (this.live) await this.stopLive().catch(() => {});
    this.live = false;
    if (this.session !== null) {
      await this.bridge.request({ op: 'close', session: this.session }).catch(() => {});
      this.session = null;
    }
    this.emit('close');
  }

  // -- internos -------------------------------------------------------------

  _requireSession() {
    if (this.session === null) throw new Error('no conectado: llama connect() primero');
  }

  async _sendTalkFrame(pcm16) {
    const alaw = pcm16leToG711a(pcm16);
    await this._write(CH_TALK, talkFrame(alaw, this._talkPts));
    this._talkPts += Math.round(alaw.length / 8); // ms (8 bytes/ms a 8 kHz)
  }

  async _liveLoop() {
    let failures = 0;
    while (this.live) {
      try {
        const header = parseLiveHeader(await this._read(CH_LIVE, 32, 10000));
        if (header.length > MAX_FRAME_BYTES) throw new Error(`frame demasiado grande: ${header.length}`);
        const data = header.length ? await this._read(CH_LIVE, header.length, 10000) : Buffer.alloc(0);
        failures = 0;
        if (header.flag === FLAG_VIDEO) {
          this.emit('video', {
            codec: this.videoCodec,
            keyframe: KEYFRAME_TYPES.has(header.frameType),
            pts: header.pts,
            data,
          });
        } else if (header.flag === FLAG_AUDIO) {
          // codecId lo manda la cámara en cada frame; hoy asumimos A-law (82), aquí se verifica.
          this.emit('audio', { codec: 'g711a', codecId: header.codecId, pts: header.pts, data });
        }
      } catch (err) {
        if (!this.live) break;
        failures += 1;
        if (failures >= 20) {
          this.live = false;
          this.emit('error', err);
          break;
        }
      }
    }
  }

  async _command(cmd, payload) {
    await this._write(CH_COMMAND, commandFrame(cmd, payload));
    return this._readCommandResponse();
  }

  async _readCommandResponse(timeoutMs = 10000) {
    const header = await this._read(CH_COMMAND, 24, timeoutMs);
    if (header.readUInt32LE(0) !== CMD_MAGIC) throw new Error('magic de comando inesperado');
    const length = header.readUInt32LE(4);
    const payload = length ? await this._read(CH_COMMAND, length, timeoutMs) : Buffer.alloc(0);
    return { cmd: header.readUInt32LE(8), sub: header[16], payload };
  }

  async _write(channel, data) {
    this._requireSession();
    const resp = await this.bridge.request(
      { op: 'write', session: this.session, channel, data: data.toString('base64') },
      10000,
    );
    return Number(resp.written);
  }

  async _read(channel, size, timeoutMs = 10000) {
    this._requireSession();
    const parts = [];
    let have = 0;
    while (have < size) {
      const resp = await this.bridge.request(
        { op: 'read', session: this.session, channel, size: size - have, timeout_ms: timeoutMs },
        timeoutMs,
      );
      const part = Buffer.from(String(resp.data), 'base64');
      if (part.length === 0) throw new Error('lectura vacía del puente');
      parts.push(part);
      have += part.length;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }
}

module.exports = {
  CamViewer,
  BridgeClient,
  DIRECTIONS,
  sleep,
  // Expuestos para pruebas.
  _frames: { commandFrame, ptzPayload, loginPayload, liveStartPayload, speakerStartPayload, talkFrame, volumePayload },
};
