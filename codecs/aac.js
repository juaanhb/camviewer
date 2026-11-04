'use strict';

// Decodificador AAC (LC) -> PCM s16le para el audio de la cámara (códec 80 = AAC).

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const SAMPLE_RATE_INDEX = {
  96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5,
  24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11,
};

// Cabecera ADTS de 7 bytes para un frame AAC LC sin CRC.
function adtsHeader(payloadLength, { sampleRate = 8000, channels = 1 } = {}) {
  const sfi = SAMPLE_RATE_INDEX[sampleRate];
  if (sfi === undefined) throw new Error(`frecuencia AAC no soportada: ${sampleRate}`);
  if (channels < 1 || channels > 7) throw new Error(`canales AAC no soportados: ${channels}`);
  const frameLen = payloadLength + 7;
  if (frameLen > 0x1fff) throw new Error(`frame AAC demasiado grande: ${payloadLength}`);
  const h = Buffer.alloc(7);
  h[0] = 0xff;
  h[1] = 0xf1; // sync + MPEG-4 + layer 0 + sin CRC
  h[2] = (1 << 6) | (sfi << 2) | ((channels >> 2) & 1); // profile LC (1 = objeto - 1)
  h[3] = ((channels & 3) << 6) | ((frameLen >> 11) & 3);
  h[4] = (frameLen >> 3) & 0xff;
  h[5] = ((frameLen & 7) << 5) | 0x1f;
  h[6] = 0xfc; // buffer llena, 1 bloque AAC por frame
  return h;
}

class AacDecoder extends EventEmitter {
  constructor({ sampleRate = 8000, channels = 1, ffmpeg = 'ffmpeg' } = {}) {
    super();
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.carry = null; // byte sobrante si ffmpeg entrega un número impar de bytes
    this.proc = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-fflags', 'nobuffer', '-analyzeduration', '0', '-probesize', '32',
      '-f', 'aac', '-i', 'pipe:0',
      '-f', 's16le', '-ar', '8000', '-ac', '1', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdin.on('error', () => {});
    this.proc.stdout.on('data', (chunk) => this._onPcm(chunk));
    this.proc.stderr.on('data', (d) => this.emit('log', d.toString().trim()));
    this.proc.on('close', () => this.emit('close'));
  }

  // Recibe un frame AAC crudo (sin cabecera) y lo manda a ffmpeg.
  write(aacFrame) {
    if (!this.proc.stdin.writable) return;
    const header = adtsHeader(aacFrame.length, { sampleRate: this.sampleRate, channels: this.channels });
    this.proc.stdin.write(Buffer.concat([header, aacFrame]));
  }

  _onPcm(chunk) {
    let buf = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    const even = buf.length - (buf.length % 2);
    this.carry = even < buf.length ? buf.subarray(even) : null;
    if (even > 0) this.emit('pcm', buf.subarray(0, even));
  }

  close() {
    try { this.proc.stdin.end(); } catch {}
    this.proc.kill('SIGKILL');
  }
}

module.exports = { AacDecoder, adtsHeader, SAMPLE_RATE_INDEX };
