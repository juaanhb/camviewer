'use strict';

// Análisis de video H.264 y H.265 en Annex B.

const H264_PROFILES = {
  66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10',
  122: 'High 4:2:2', 244: 'High 4:4:4 Predictive',
};
const HEVC_PROFILES = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'Range Extensions' };

const NAL_H264_SPS = 7;
const NAL_H264_PPS = 8;
const NAL_HEVC_VPS = 32;
const NAL_HEVC_SPS = 33;
const NAL_HEVC_PPS = 34;

// Separa un bloque Annex B en NAL units. Cada una trae su start code en `bytes`.
function splitNals(buf) {
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) { starts.push({ at: i, sc: 3 }); i += 2; }
      else if (buf[i + 2] === 0 && buf[i + 3] === 1) { starts.push({ at: i, sc: 4 }); i += 3; }
    }
  }
  return starts.map((st, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].at : buf.length;
    return { bytes: buf.subarray(st.at, end), payload: buf.subarray(st.at + st.sc, end) };
  });
}

// Quita los bytes de emulation prevention (00 00 03) para leer campos del RBSP.
function unescapeRbsp(b) {
  const out = [];
  let zeros = 0;
  for (let i = 0; i < b.length; i++) {
    if (zeros >= 2 && b[i] === 3) { zeros = 0; continue; }
    out.push(b[i]);
    zeros = b[i] === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

const hex2 = (n) => n.toString(16).padStart(2, '0');

// SPS de H.264: profile_idc, constraint flags y level_idc (bytes 1..3 del payload).
function parseH264Sps(payload) {
  const r = unescapeRbsp(payload.subarray(1, 4));
  const profileIdc = r[0];
  const constraints = r[1];
  const levelIdc = r[2];
  return {
    codec: `avc1.${hex2(profileIdc)}${hex2(constraints)}${hex2(levelIdc)}`,
    profile: H264_PROFILES[profileIdc] || `perfil ${profileIdc}`,
    level: (levelIdc / 10).toFixed(1),
  };
}

// SPS de H.265: lee profile, tier y level.
function parseHevcSps(payload) {
  const r = unescapeRbsp(payload.subarray(2, 2 + 16));
  const space = r[1] >> 6;
  const tier = (r[1] >> 5) & 1;
  const profileIdc = r[1] & 31;
  const compat = ((r[2] << 24) | (r[3] << 16) | (r[4] << 8) | r[5]) >>> 0;
  let rev = 0; // el código de compatibilidad se escribe con los bits invertidos
  for (let i = 0; i < 32; i++) rev = ((rev << 1) | ((compat >>> i) & 1)) >>> 0;
  const constr = [r[6], r[7], r[8], r[9], r[10], r[11]];
  while (constr.length > 1 && constr[constr.length - 1] === 0) constr.pop();
  const levelIdc = r[12];
  const spacePrefix = ['', 'A', 'B', 'C'][space] || '';
  return {
    codec: `hvc1.${spacePrefix}${profileIdc}.${rev.toString(16)}.${tier ? 'H' : 'L'}${levelIdc}.${constr.map(hex2).join('.')}`,
    profile: HEVC_PROFILES[profileIdc] || `perfil ${profileIdc}`,
    level: (levelIdc / 30).toFixed(1),
  };
}

// Cache de parámetros de una sesión de video.
function newParamCache() {
  return { vps: null, sps: null, pps: null, config: null, configKey: '' };
}

// Procesa una unidad de acceso (AU) de la cámara.
function processAu(data, hevc, cache, keyframe) {
  const nals = splitNals(data);
  let hasVps = false;
  let hasSps = false;
  let hasPps = false;
  let config = null;

  for (const n of nals) {
    const type = hevc ? (n.payload[0] >> 1) & 0x3f : n.payload[0] & 0x1f;
    if (hevc) {
      if (type === NAL_HEVC_VPS) { cache.vps = n.bytes; hasVps = true; }
      else if (type === NAL_HEVC_SPS) {
        cache.sps = n.bytes; hasSps = true;
        const p = parseHevcSps(n.payload);
        config = { codec: p.codec, profile: p.profile, level: p.level, hevc: true };
      } else if (type === NAL_HEVC_PPS) { cache.pps = n.bytes; hasPps = true; }
    } else {
      if (type === NAL_H264_SPS) {
        cache.sps = n.bytes; hasSps = true;
        const p = parseH264Sps(n.payload);
        config = { codec: p.codec, profile: p.profile, level: p.level, hevc: false };
      } else if (type === NAL_H264_PPS) { cache.pps = n.bytes; hasPps = true; }
    }
  }

  let out = data;
  if (keyframe) {
    const pre = [];
    if (hevc && !hasVps && cache.vps) pre.push(cache.vps);
    if (!hasSps && cache.sps) pre.push(cache.sps);
    if (!hasPps && cache.pps) pre.push(cache.pps);
    if (pre.length) out = Buffer.concat([...pre, data]);
  }

  let changed = null;
  if (config) {
    const key = `${config.codec}|${config.profile}|${config.level}`;
    if (key !== cache.configKey) {
      cache.configKey = key;
      cache.config = config;
      changed = config;
    }
  }
  return { data: out, config: changed };
}

module.exports = {
  splitNals,
  parseH264Sps,
  parseHevcSps,
  newParamCache,
  processAu,
};
