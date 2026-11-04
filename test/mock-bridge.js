'use strict';

// Puente simulado: protocolo JSON por línea en el puerto 8766.

const net = require('net');

function startMockBridge(port, opts = {}) {
  const videoBytes = opts.videoBytes || null; // H.265 real para pruebas de MJPEG
  const videoRepeat = opts.videoRepeat || 1;
  const framePaceMs = opts.framePaceMs || 0; // ritmo de llegada de video, como una cámara real
  const queues = { 0: [], 1: [], 2: [] }; // bytes pendientes por canal (lectura)
  const log = { ptz: [], speaker: [], talk: [], live: [], other: [] };

  const pushBytes = (ch, buf) => queues[ch].push(buf);
  const cmdHeader = (cmd, len) => {
    const h = Buffer.alloc(24);
    h.writeUInt32LE(0x76768888, 0);
    h.writeUInt32LE(len, 4);
    h.writeUInt32LE(cmd, 8);
    return h;
  };

  function handleWrite(ch, buf) {
    if (ch === 1) {
      const flag = buf.readUInt32LE(0);
      const len = buf.readUInt32LE(4);
      log.talk.push({ flag, len, pts: buf.readUInt32LE(8), codec: buf.readUInt32LE(12), ok: buf.length === 16 + len });
      return;
    }
    if (ch !== 0) return;
    const magic = buf.readUInt32LE(0);
    if (magic !== 0x76768888) throw new Error('magic inválido en comando');
    const len = buf.readUInt32LE(4);
    const cmd = buf.readUInt32LE(8);
    const payload = buf.subarray(24, 24 + len);
    if (cmd === 0x0010) {
      const p = Buffer.alloc(16);
      p.writeUInt32LE(1234, 8);
      if (!opts.silentLogin) pushBytes(0, Buffer.concat([cmdHeader(0x0010, p.length), p]));
      log.other.push({ cmd, password: payload.subarray(0, 64).toString('utf8').replace(/\0+$/, ''), userId: payload.readUInt32LE(68) });
    } else if (cmd === 0x0001) {
      const p = Buffer.alloc(28);
      p.writeUInt32LE(5, 4); // H.265
      p.writeUInt32LE(1280, 8);
      p.writeUInt32LE(720, 12);
      p.writeUInt32LE(82, 16);
      pushBytes(0, Buffer.concat([cmdHeader(0x0001, p.length), p]));
      log.live.push('start');
      if (videoBytes) {
        const CH = 4096;
        let n = 0;
        for (let r = 0; r < videoRepeat; r++) {
          for (let off = 0; off < videoBytes.length; off += CH) {
            const body = videoBytes.subarray(off, Math.min(off + CH, videoBytes.length));
            const h = Buffer.alloc(32);
            h.writeUInt32LE(428216305, 0);
            h.writeUInt32LE(body.length, 4);
            h.writeUInt32LE(n * 40, 8);
            h.writeUInt32LE(n === 0 ? 17 : 18, 12);
            pushBytes(2, Buffer.concat([h, body]));
            // audio intercalado, como en una cámara real
            const abody = Buffer.alloc(160, 0xd5);
            const ah = Buffer.alloc(32);
            ah.writeUInt32LE(428216306, 0);
            ah.writeUInt32LE(abody.length, 4);
            ah.writeUInt32LE(n * 40, 8);
            pushBytes(2, Buffer.concat([ah, abody]));
            n++;
          }
        }
      }
      for (let i = 0; i < 20; i++) {
        if (i % 2 === 0 && !videoBytes) {
          const body = Buffer.alloc(100, i & 0xff);
          const h = Buffer.alloc(32);
          h.writeUInt32LE(428216305, 0);
          h.writeUInt32LE(body.length, 4);
          h.writeUInt32LE(i * 40, 8);
          h.writeUInt32LE(i % 10 === 0 ? 17 : 18, 12); // I/P H.265
          pushBytes(2, Buffer.concat([h, body]));
        } else {
          const body = Buffer.alloc(160, 0xd5);
          const h = Buffer.alloc(32);
          h.writeUInt32LE(428216306, 0);
          h.writeUInt32LE(body.length, 4);
          h.writeUInt32LE(i * 40, 8);
          pushBytes(2, Buffer.concat([h, body]));
        }
      }
    } else if (cmd === 0x0003) {
      log.live.push('stop');
    } else if (cmd === 0x1001) {
      log.ptz.push(payload[0]);
    } else if (cmd === 0x0006 || cmd === 0x0007) {
      log.speaker.push(cmd === 0x0006 ? 'start' : 'stop');
    } else {
      log.other.push({ cmd });
    }
  }

  function handleRequest(req) {
    switch (req.op) {
      case 'init': return { ok: true, ret: 0 };
      case 'connect': return { ok: true, session: 1, check_ret: 0 };
      case 'close': return { ok: true, ret: 0 };
      case 'write': {
        handleWrite(req.channel, Buffer.from(req.data, 'base64'));
        return { ok: true, written: Buffer.from(req.data, 'base64').length };
      }
      default:
        return { ok: false, error: `op desconocida: ${req.op}` };
    }
  }

  // read es asíncrono: espera datos hasta timeout_ms y luego falla como PPCS_Read.
  async function handleRead(req) {
    if (framePaceMs && req.channel === 2 && req.size === 32) {
      await new Promise((r) => setTimeout(r, framePaceMs));
    }
    const deadline = Date.now() + Math.min(req.timeout_ms || 1000, 200) + (framePaceMs && req.channel === 2 ? framePaceMs : 0);
    const q = queues[req.channel];
    while (Date.now() < deadline) {
      if (q.length) {
        let buf = Buffer.concat(q.splice(0, q.length));
        const out = buf.subarray(0, req.size);
        if (buf.length > req.size) q.unshift(buf.subarray(req.size));
        return { ok: true, ret: 0, data: out.toString('base64') };
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    return { ok: false, error: 'PPCS_Read failed: -3 (timeout)' };
  }

  const server = net.createServer((sock) => {
    let acc = Buffer.alloc(0);
    sock.on('data', async (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      const i = acc.indexOf(0x0a);
      if (i < 0) return;
      const req = JSON.parse(acc.subarray(0, i).toString('utf8'));
      let resp;
      try {
        resp = req.op === 'read' ? await handleRead(req) : handleRequest(req);
      } catch (err) {
        resp = { ok: false, error: err.message };
      }
      sock.end(JSON.stringify(resp) + '\n');
    });
    sock.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, log, close: () => new Promise((r) => server.close(r)) }));
  });
}

module.exports = { startMockBridge };
