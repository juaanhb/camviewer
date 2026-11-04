'use strict';

// Verifica que los frames coincidan con la implementación Python de referencia.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { _frames: f } = require('../bridge/camviewer');
const { pcm16leToG711a, g711aToPcm16le } = require('../codecs/g711');

const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors.json'), 'utf8'));
const hex = (buf) => buf.toString('hex');

test('PTZ up/stop/up-left frames match Python', () => {
  assert.equal(hex(f.commandFrame(0x1001, f.ptzPayload(1, 0, 0))), v.ptz_up);
  assert.equal(hex(f.commandFrame(0x1001, f.ptzPayload(0))), v.ptz_stop);
  assert.equal(hex(f.commandFrame(0x1001, f.ptzPayload(4, 5))), v.ptz_upleft_s5);
});

test('login frames match Python', () => {
  assert.equal(hex(f.commandFrame(0x0010, f.loginPayload('abc12', false, 7))), v.login);
  assert.equal(hex(f.commandFrame(0x0010, f.loginPayload('x', true, 0))), v.login_share);
});

test('live start/stop match Python', () => {
  assert.equal(hex(f.commandFrame(0x0001, f.liveStartPayload(1, 2, 0))), v.live_start);
  assert.equal(hex(f.commandFrame(0x0003, Buffer.alloc(4))), v.live_stop);
});

test('speaker start/stop and volume match Python', () => {
  assert.equal(hex(f.commandFrame(0x0006, f.speakerStartPayload())), v.speaker_start);
  assert.equal(hex(f.commandFrame(0x0007, Buffer.alloc(4))), v.speaker_stop);
  assert.equal(hex(f.commandFrame(0x811a, f.volumePayload(60, 80))), v.volume);
});

test('talk audio frame matches Python', () => {
  const data = Buffer.from(Array.from({ length: 160 }, (_, i) => i));
  assert.equal(hex(f.talkFrame(data, 20)), v.talk_pts20);
});

test('PCM16 -> G.711A matches Python for samples below 256 (segment 0 is identical)', () => {
  const vals = [0, 1, 7, 16, 100, -100, 255, -255];
  const pcm = Buffer.alloc(vals.length * 2);
  vals.forEach((x, i) => pcm.writeInt16LE(x, i * 2));
  // Referencia generada con audio.py: pcm16le_to_g711a(pcm) para estos valores.
  const expected = v.alaw_small;
  assert.equal(hex(pcm16leToG711a(pcm)), expected);
});

test('known A-law codes', () => {
  // 1000 -> segmento 2, mantisa 15 -> 0xFA (estándar)
  assert.equal(pcm16leToG711a(Buffer.from([0xe8, 0x03]))[0], 0xfa);
  assert.equal(g711aToPcm16le(Buffer.from([0xfa])).readInt16LE(0), 1008);
});

test('G.711A round trip stays close to the original (quantization error only)', () => {
  const pcm = Buffer.from(v.pcm_in, 'hex');
  const back = g711aToPcm16le(pcm16leToG711a(pcm));
  let maxErr = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    maxErr = Math.max(maxErr, Math.abs(pcm.readInt16LE(i) - back.readInt16LE(i)));
  }
  assert.ok(maxErr <= 1024, `error máximo ${maxErr}`);
});
