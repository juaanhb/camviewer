'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { AacDecoder, adtsHeader } = require('../codecs/aac');

// Separa un flujo ADTS en frames crudos (sin cabecera), como los manda la cámara.
function splitAdts(buf) {
  const frames = [];
  let i = 0;
  while (i + 7 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xf0) !== 0xf0) throw new Error('sync ADTS no encontrado');
    const len = ((buf[i + 3] & 3) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
    frames.push(buf.subarray(i + 7, i + len));
    i += len;
  }
  return frames;
}

test('adtsHeader: campos correctos para 8 kHz mono AAC LC', () => {
  const h = adtsHeader(100);
  assert.equal(h[0], 0xff);
  assert.equal(h[1], 0xf1);
  assert.equal(h[2] >> 6, 1); // LC
  assert.equal((h[2] >> 2) & 0x0f, 11); // 8000 Hz
  assert.equal(((h[2] & 1) << 2) | (h[3] >> 6), 1); // 1 canal
  const len = ((h[3] & 3) << 11) | (h[4] << 3) | (h[5] >> 5);
  assert.equal(len, 107);
});

test('AacDecoder: decodifica frames AAC crudos a PCM de la duración correcta', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aac-'));
  const src = path.join(dir, 'tone.aac');
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-ar', '8000', '-ac', '1', '-c:a', 'aac', '-b:a', '32k', '-f', 'adts', src]);
  } catch {
    t.skip('ffmpeg no disponible');
    return;
  }
  const frames = splitAdts(fs.readFileSync(src));
  assert.ok(frames.length >= 8, `frames: ${frames.length}`); // 1024 muestras por frame a 8 kHz

  const dec = new AacDecoder();
  let pcmBytes = 0;
  dec.on('pcm', (pcm) => { pcmBytes += pcm.length; });
  for (const f of frames) dec.write(Buffer.from(f));
  await new Promise((r) => setTimeout(r, 1200));
  dec.close();
  fs.rmSync(dir, { recursive: true, force: true });

  // 1 s a 8 kHz mono PCM16 = 16000 bytes; los frames AAC añaden relleno (~9 frames de 1024 muestras).
  assert.ok(pcmBytes > 14000 && pcmBytes < 19000, `bytes PCM: ${pcmBytes}`);
});
