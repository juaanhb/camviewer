#!/usr/bin/env node
'use strict';

// Uso: node bridge/cli.js <comando> [args] (ver README).

const { spawn } = require('child_process');
const { CamViewer, DIRECTIONS } = require('./camviewer');
const { load: loadConfig } = require('../config');

function configFromFile() {
  const { camera, bridge } = loadConfig();
  return {
    did: camera.did,
    password: camera.password,
    deviceType: camera.deviceType,
    userId: Number(camera.userId),
    bridgeHost: bridge.host,
    bridgePort: Number(bridge.port),
  };
}

function usage(message) {
  if (message) console.error(message);
  console.error(`Uso: node bridge/cli.js <view|move|ptz|stop|talk> [args]
Direcciones: ${Object.keys(DIRECTIONS).join(', ')}`);
  process.exit(1);
}

async function view(cam) {
  let video = null;
  let audio = null;
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (video) video.kill();
    if (audio) audio.kill();
    await cam.close();
    process.exit(0);
  };

  // Los handlers se registran antes de startLive para no perder frames.
  cam.on('error', (err) => {
    console.error('Live detenido:', err.message);
    shutdown();
  });

  const info = await cam.startLive();
  console.error(`Live: ${info.videoCodec} ${info.width}x${info.height}`);

  const videoOpts = [
    '-loglevel', 'error', '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-f', info.videoCodec === 'h264' ? 'h264' : 'hevc', '-window_title', 'CamViewer', '-i', 'pipe:0',
  ];
  const audioOpts = [
    '-nodisp', '-loglevel', 'error', '-fflags', 'nobuffer',
    '-f', 'alaw', '-ar', '8000', '-ac', '1', '-i', 'pipe:0',
  ];

  video = spawn('ffplay', videoOpts, { stdio: ['pipe', 'ignore', 'inherit'] });
  audio = spawn('ffplay', audioOpts, { stdio: ['pipe', 'ignore', 'inherit'] });
  for (const proc of [video, audio]) {
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => {
      console.error(`No se pudo ejecutar ffplay: ${err.message}`);
      shutdown();
    });
    proc.on('exit', shutdown); // cerrar la ventana termina el programa
  }

  cam.on('video', (frame) => video.stdin.write(frame.data));
  cam.on('audio', (frame) => audio.stdin.write(frame.data));

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function talk(cam, file) {
  if (file === '-') return cam.talk(process.stdin);

  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-ar', '8000', '-ac', '1', '-f', 's16le', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  return cam.talk(ffmpeg.stdout).finally(() => ffmpeg.kill());
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();

  const config = configFromFile();
  if (!config.did) usage('Falta CAMCAR_DID');

  const cam = new CamViewer(config);
  await cam.connect();

  try {
    switch (command) {
      case 'view':
        await view(cam);
        return; // se queda corriendo hasta Ctrl+C o cierre de ventana
      case 'move':
        if (!args[0]) usage('Falta dirección');
        await cam.move(args[0], Number(args[1] || 300));
        break;
      case 'ptz':
        if (!args[0]) usage('Falta dirección');
        await cam.ptz(args[0]);
        break;
      case 'stop':
        await cam.ptz('stop');
        break;
      case 'talk':
        if (!args[0]) usage('Falta archivo o "-"');
        await talk(cam, args[0]);
        break;
      default:
        usage(`Comando desconocido: ${command}`);
    }
  } finally {
    if (command !== 'view') await cam.close();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
