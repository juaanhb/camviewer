'use strict';

// G.711 A-law <-> PCM16 little-endian (8 kHz mono).

// Segmento A-law estándar (bits de la muestra − 8).
function alawSegment(sample) {
  let bits = 0;
  for (let s = sample; s > 0; s >>= 1) bits++;
  return bits - 8;
}

function linearToAlaw(sample) {
  let mask = 0xd5;
  if (sample < 0) {
    mask = 0x55;
    sample = -sample - 1;
  }
  sample = Math.min(sample, 0x7fff);

  let segment;
  let quantized;
  if (sample < 256) {
    segment = 0;
    quantized = sample >> 4;
  } else {
    segment = alawSegment(sample);
    quantized = (sample >> (segment + 3)) & 0x0f;
  }
  return (((segment << 4) | quantized) ^ mask) & 0xff;
}

function alawToLinear(value) {
  value ^= 0x55;
  let sample = (value & 0x0f) << 4;
  const segment = (value & 0x70) >> 4;
  if (segment === 0) {
    sample += 8;
  } else if (segment === 1) {
    sample += 0x108;
  } else {
    sample += 0x108;
    sample <<= segment - 1;
  }
  return value & 0x80 ? sample : -sample;
}

// PCM16LE buffer -> G.711 A-law buffer (1 byte per sample).
function pcm16leToG711a(pcm) {
  if (pcm.length % 2 !== 0) throw new Error('PCM16 input length must be even');
  const out = Buffer.alloc(pcm.length / 2);
  for (let i = 0, o = 0; i < pcm.length; i += 2, o++) {
    out[o] = linearToAlaw(pcm.readInt16LE(i));
  }
  return out;
}

// G.711 A-law buffer -> PCM16LE buffer.
function g711aToPcm16le(alaw) {
  const out = Buffer.alloc(alaw.length * 2);
  for (let i = 0; i < alaw.length; i++) {
    out.writeInt16LE(alawToLinear(alaw[i]), i * 2);
  }
  return out;
}

module.exports = { pcm16leToG711a, g711aToPcm16le };
