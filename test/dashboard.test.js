'use strict';

// Prueba de punta a punta del dashboard con el puente simulado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { start } = require('../dashboard/server');
const { startMockBridge } = require('./mock-bridge');

const BRIDGE_PORT = 18767;
const DASH_PORT = 18081;
const base = `http://127.0.0.1:${DASH_PORT}`;
const hevc = fs.readFileSync(path.join(__dirname, 'fixtures', 'test.hevc'));

async function post(p, body) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function openWs(path = '/video') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${DASH_PORT}${path}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('no se pudo abrir el WebSocket'));
  });
}

// Recoge los mensajes binarios de un tipo durante `ms` milisegundos.
function collect(ws, ms, kind) {
  return new Promise((resolve) => {
    const out = [];
    const onMessage = (e) => {
      if (typeof e.data === 'string') return;
      const b = Buffer.from(e.data);
      if (b[0] === kind) out.push(b.subarray(1));
    };
    ws.addEventListener('message', onMessage);
    setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      resolve(out);
    }, ms);
  });
}

// Espera el siguiente mensaje de texto (errores del servidor).
function nextText(ws, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sin mensaje de texto')), ms);
    ws.addEventListener('message', function onMessage(e) {
      if (typeof e.data !== 'string') return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      resolve(JSON.parse(e.data));
    });
  });
}

test('dashboard: ws de video, audio y voz, PTZ y desconexión', async () => {
  let bridge = await startMockBridge(BRIDGE_PORT, { videoBytes: hevc, videoRepeat: 20, framePaceMs: 40 });
  const server = await start(DASH_PORT, '127.0.0.1');
  const ws = await openWs('/video');
  const aws = await openWs('/audio');
  try {
    // Sin cámara conectada, el WS responde con error.
    ws.send(JSON.stringify({ op: 'video', fps: 8, width: 320 }));
    const err0 = await nextText(ws);
    assert.equal(err0.type, 'error');
    assert.match(err0.message, /no conectado/);

    // Conectar por HTTP.
    const conn = await post('/api/connect', { did: 'TEST-DASH', password: 'pw', bridgePort: BRIDGE_PORT });
    assert.equal(conn.status, 200, JSON.stringify(conn.data));
    assert.equal(conn.data.videoCodec, 'h265');
    assert.equal(conn.data.width, 1280);

    const status = await (await fetch(base + '/api/status')).json();
    assert.equal(status.connected, true);
    assert.equal(status.live, true);
    assert.equal(typeof status.session, 'number');

    // Video: JPEG binarios (tipo 0x01) durante ~2.5 s.
    ws.send(JSON.stringify({ op: 'video', fps: 8, width: 320 }));
    const frames = await collect(ws, 2500, 0x01);
    assert.ok(frames.length >= 3, `se esperaban >=3 frames JPEG, llegaron ${frames.length}`);
    for (const jpeg of frames) {
      assert.equal(jpeg[0], 0xff, 'cada frame empieza con SOI');
      assert.equal(jpeg[1], 0xd8);
      assert.equal(jpeg[jpeg.length - 2], 0xff, 'y termina con EOI');
      assert.equal(jpeg[jpeg.length - 1], 0xd9);
    }
    ws.send(JSON.stringify({ op: 'video_stop' }));

    // El puente simulado sirve su video una sola vez por proceso: la fase WebCodecs usa un puente nuevo.
    assert.equal((await post('/api/disconnect', {})).status, 200);
    await bridge.close();
    bridge = await startMockBridge(BRIDGE_PORT + 1, { videoBytes: hevc, videoRepeat: 20, framePaceMs: 40 });
    const re = await post('/api/connect', { did: 'TEST-DASH', password: 'pw', bridgePort: BRIDGE_PORT + 1 });
    assert.equal(re.status, 200, JSON.stringify(re.data));
    // Video WebCodecs: unidades de acceso (tipo 0x05); el primer frame debe ser keyframe.
    const cfgMsgs = [];
    const onCfg = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      if (m.type === 'video_config') cfgMsgs.push(m);
    };
    ws.addEventListener('message', onCfg);
    ws.send(JSON.stringify({ op: 'video', mode: 'annexb' }));
    const aus = await collect(ws, 2500, 0x05);
    ws.removeEventListener('message', onCfg);
    assert.ok(cfgMsgs.length >= 1, 'llega video_config antes de las unidades');
    assert.equal(cfgMsgs[0].hevc, true);
    assert.match(cfgMsgs[0].codec, /^hvc1\./);
    assert.equal(cfgMsgs[0].profile, 'Range Extensions');
    assert.ok(aus.length >= 3, `se esperaban >=3 unidades de acceso, llegaron ${aus.length}`);
    assert.equal(aus[0][0] & 1, 1, 'primer frame es keyframe');
    const d = aus[0].subarray(1);
    const annexB = (d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 1) || (d[0] === 0 && d[1] === 0 && d[2] === 1);
    assert.ok(annexB, 'las unidades llevan código de inicio Annex B');
    ws.send(JSON.stringify({ op: 'video_stop' }));

    // Audio: PCM binario (tipo 0x02) cuando está activado.
    aws.send(JSON.stringify({ op: 'audio', on: true }));
    const audio = await collect(aws, 1500, 0x02);
    const total = audio.reduce((n, b) => n + b.length, 0);
    assert.ok(total >= 640, `se esperaban >=640 bytes de audio, llegaron ${total}`);
    assert.ok(audio.every((b) => b.length % 2 === 0), 'PCM16: longitud par');
    aws.send(JSON.stringify({ op: 'audio', on: false }));

    // Voz: start -> dos bloques binarios de 100 ms -> stop.
    const before = bridge.log.talk.length;
    aws.send(JSON.stringify({ op: 'talk_start' }));
    await new Promise((r) => setTimeout(r, 100));
    const block = Buffer.alloc(1601);
    block[0] = 0x03; // tipo voz
    aws.send(block);
    aws.send(block);
    aws.send(JSON.stringify({ op: 'talk_stop' }));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(bridge.log.talk.length - before, 10, '2 bloques de 1600 bytes = 10 frames de 20 ms');
    assert.deepEqual(bridge.log.speaker.slice(-2), ['start', 'stop']);

    // Control por HTTP sigue funcionando.
    assert.equal((await post('/api/ptz', { direction: 'up-right', speed: 3 })).status, 200);
    assert.equal((await post('/api/ptz', { direction: 'stop' })).status, 200);
    assert.equal((await post('/api/move', { direction: 'left', ms: 30 })).status, 200);
    // move(left) manda la dirección izquierda (código 3) y luego stop (0).
    assert.deepEqual(bridge.log.ptz.slice(-2), [3, 0]);
    assert.equal((await post('/api/volume', { in: 40, out: 90 })).status, 200);

    // Desconectar: el WS sigue abierto, pero ya no hay video.
    assert.equal((await post('/api/disconnect', {})).status, 200);
    const after = await (await fetch(base + '/api/status')).json();
    assert.equal(after.connected, false);
    ws.send(JSON.stringify({ op: 'video', fps: 8, width: 320 }));
    const err1 = await nextText(ws);
    assert.match(err1.message, /no conectado/);
  } finally {
    ws.close();
    aws.close();
    await post('/api/disconnect', {}).catch(() => {});
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await bridge.close();
  }
});
