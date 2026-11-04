'use strict';

// WebSocket mínimo (RFC 6455) para el servidor del dashboard. Sin dependencias.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// Valida la petición de upgrade y responde 101. Devuelve la conexión o null.
function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (!key || upgrade !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new WebSocketConn(socket);
}

class WebSocketConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.open = true;
    this._buf = Buffer.alloc(0);
    this._fragOp = null;
    this._frags = [];
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    // http.Server usa allowHalfOpen; hay que cerrar el lado propio al recibir FIN.
    socket.on('end', () => { this._finish(); socket.end(); });
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
  }

  // Bytes pendientes de salida; sirve para descartar frames si el cliente va lento.
  get bufferedAmount() {
    return this.socket.writableLength;
  }

  sendBinary(buf) {
    if (this.open) this.socket.write(frame(OP_BINARY, buf));
  }

  sendText(text) {
    if (this.open) this.socket.write(frame(OP_TEXT, Buffer.from(text, 'utf8')));
  }

  close() {
    if (!this.open) return;
    try {
      this.socket.write(frame(OP_CLOSE, Buffer.alloc(0)));
    } catch {}
    this._finish();
    this.socket.end();
  }

  _finish() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
    this.socket.destroy();
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      const msg = this._readFrame();
      if (!msg) return;
      if (msg.op === OP_CLOSE) return this.close();
      if (msg.op === OP_PING) {
        if (this.open) this.socket.write(frame(OP_PONG, msg.payload));
        continue;
      }
      if (msg.op === OP_PONG) continue;

      if (msg.op !== OP_CONT) {
        if (!msg.fin) {
          this._fragOp = msg.op;
          this._frags = [msg.payload];
          continue;
        }
        this._emitMessage(msg.op, msg.payload);
      } else if (this._fragOp !== null) {
        this._frags.push(msg.payload);
        if (msg.fin) {
          const op = this._fragOp;
          const payload = Buffer.concat(this._frags);
          this._fragOp = null;
          this._frags = [];
          this._emitMessage(op, payload);
        }
      }
    }
  }

  _emitMessage(op, payload) {
    if (op === OP_TEXT) this.emit('message', payload.toString('utf8'));
    else if (op === OP_BINARY) this.emit('message', payload);
  }

  // Lee un frame completo del buffer; devuelve null si aún no llega entero.
  _readFrame() {
    const b = this._buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      len = Number(b.readBigUInt64BE(off));
      off += 8;
    }
    if (len > MAX_MESSAGE) {
      this.close();
      return null;
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this._buf = b.subarray(off + len);
    return { fin, op, payload };
  }
}

// Frame del servidor: sin máscara.
function frame(op, payload) {
  const n = payload.length;
  let header;
  if (n < 126) {
    header = Buffer.from([0x80 | op, n]);
  } else if (n < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | op;
    header[1] = 126;
    header.writeUInt16BE(n, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | op;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([header, payload]);
}

module.exports = { acceptUpgrade, WebSocketConn };
