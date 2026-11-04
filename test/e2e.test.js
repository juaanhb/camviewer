'use strict';

// Prueba de punta a punta contra un puente simulado (sin cámara real).

const test = require('node:test');
const assert = require('node:assert/strict');
const { CamViewer } = require('../bridge/camviewer');
const { startMockBridge } = require('./mock-bridge');

const PORT = 18766;

test('connect, login, live (video+audio), PTZ, talk y close', async () => {
  const bridge = await startMockBridge(PORT);
  const cam = new CamViewer({ did: 'TEST-DID', password: 'pw123', userId: 7, bridgePort: PORT, timeout: 2000 });
  try {
    await cam.connect();
    assert.equal(cam.login.token, 1234);
    assert.deepEqual(bridge.log.other[0], { cmd: 0x0010, password: 'pw123', userId: 7 });

    const videos = [];
    const audios = [];
    const info = await new Promise(async (resolve, reject) => {
      cam.on('video', (f) => videos.push(f));
      cam.on('audio', (f) => audios.push(f));
      cam.on('error', (err) => {
        // Al agotarse los frames simulados el live debe reportar error.
        if (videos.length + audios.length === 20) resolve(null);
        else reject(err);
      });
      const i = await cam.startLive();
      resolve(i);
    });
    assert.equal(info.videoCodec, 'h265');
    assert.equal(info.width, 1280);
    assert.equal(info.height, 720);

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(videos.length, 10);
    assert.equal(audios.length, 10);
    assert.equal(videos[0].keyframe, true);
    assert.equal(videos[1].keyframe, false);
    assert.equal(videos[0].codec, 'h265');
    assert.equal(videos[0].data.length, 100);
    assert.equal(audios[0].codec, 'g711a');
    assert.equal(audios[0].data.length, 160);

    await cam.move('left', 30);
    await cam.ptz('up-right');
    await cam.ptz('stop');
    assert.deepEqual(bridge.log.ptz, [3, 0, 7, 0]);

    const pcm = Buffer.alloc(1600); // 800 muestras = 5 frames de 20 ms
    await cam.talk([pcm]);
    assert.equal(bridge.log.talk.length, 5);
    assert.ok(bridge.log.talk.every((t) => t.flag === 428216306 && t.len === 160 && t.ok && t.codec === 82));
    assert.deepEqual(bridge.log.talk.map((t) => t.pts), [0, 20, 40, 60, 80]);
    assert.deepEqual(bridge.log.speaker, ['start', 'stop']);

    await cam.close();
    assert.equal(cam.session, null);
  } finally {
    cam.live = false;
    await bridge.close();
  }
});
