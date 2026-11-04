'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { splitNals, parseH264Sps, parseHevcSps, newParamCache, processAu } = require('../codecs/video');

test('splitNals: separa start codes de 3 y 4 bytes', () => {
  const buf = Buffer.from([0, 0, 0, 1, 0x67, 0xaa, 0, 0, 1, 0x68, 0xbb]);
  const nals = splitNals(buf);
  assert.equal(nals.length, 2);
  assert.deepEqual([...nals[0].payload], [0x67, 0xaa]);
  assert.deepEqual([...nals[1].payload], [0x68, 0xbb]);
});

test('HEVC: el fixture real da un códec hvc1 con perfil y nivel', () => {
  const hevc = fs.readFileSync(path.join(__dirname, 'fixtures', 'test.hevc'));
  const sps = splitNals(hevc).find((n) => ((n.payload[0] >> 1) & 0x3f) === 33);
  assert.ok(sps, 'el fixture debe traer SPS');
  const p = parseHevcSps(sps.payload);
  assert.match(p.codec, /^hvc1\.(A|B|C)?\d+\.[0-9a-f]+\.[LH]\d+(\.[0-9a-f]{2})+$/);
  assert.equal(p.profile, 'Range Extensions'); // el fixture es perfil 4
  assert.equal(p.level, '2.0'); // level_idc 60 leído del SPS
});

test('H.264: SPS High 4.0 se convierte a avc1.640028', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h264-'));
  const out = path.join(dir, 'high.h264');
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=0.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0', '-f', 'h264', out]);
  } catch {
    t.skip('ffmpeg sin libx264');
    return;
  }
  const stream = fs.readFileSync(out);
  fs.rmSync(dir, { recursive: true, force: true });
  const sps = splitNals(stream).find((n) => (n.payload[0] & 0x1f) === 7);
  const p = parseH264Sps(sps.payload);
  assert.equal(p.codec, 'avc1.640028');
  assert.equal(p.profile, 'High');
  assert.equal(p.level, '4.0');
});

test('processAu: keyframe sin SPS/PPS recibe los últimos vistos', () => {
  const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x4d, 0x00, 0x1f, 0xaa]);
  const pps = Buffer.from([0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80]);
  const cache = newParamCache();
  const first = processAu(Buffer.concat([sps, pps, Buffer.from([0, 0, 0, 1, 0x65, 0x01])]), false, cache, true);
  assert.equal(first.config.codec, 'avc1.4d001f');
  assert.equal(first.config.profile, 'Main');

  // Un keyframe posterior sin parámetros: se le anteponen SPS y PPS.
  const idr = Buffer.from([0, 0, 0, 1, 0x65, 0x02]);
  const second = processAu(idr, false, cache, true);
  assert.equal(second.config, null, 'la config no cambió');
  assert.deepEqual(second.data.subarray(0, sps.length), sps);
  assert.deepEqual(second.data.subarray(sps.length, sps.length + pps.length), pps);
  assert.deepEqual(second.data.subarray(sps.length + pps.length), idr);

  // Un delta no se toca.
  const delta = Buffer.from([0, 0, 0, 1, 0x41, 0x03]);
  assert.deepEqual(processAu(delta, false, cache, false).data, delta);
});
