// A minimal RFC 6455 WebSocket server: the handshake (HTTP Upgrade +
// Sec-WebSocket-Accept computation) and text-frame framing/unmasking.
// This exists because this sandbox cannot `npm install ws` or
// `socket.io` (no network access) — it is NOT the production realtime
// layer. The real one is apps/backend/src/realtime/*, built on NestJS's
// WebSocket gateway + socket.io per docs/00-ARCHITECTURE.md, and can't be
// executed here for the same reason. This module exists purely so the
// actual message-delivery *logic* (ack, ordering, offline sync, typing,
// receipts) can be run and proven end-to-end somewhere real, rather than
// only asserted.
//
// Deliberately out of scope, since the harness doesn't need them:
// fragmented frames, permessage-deflate, ping/pong keepalive beyond a
// bare pong reply. A production 'ws'/socket.io-backed server handles all
// of that; this does not need to reimplement it to prove the application
// logic on top is correct.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKeyFor(clientKey) {
  return createHash('sha1').update(clientKey + WS_MAGIC).digest('base64');
}

export class MiniWebSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this._buffer = Buffer.alloc(0);
    this.isOpen = true;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => {
      this.isOpen = false;
      this.emit('close');
    });
    socket.on('error', (err) => this.emit('error', err));
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    let frame;
    while ((frame = this._tryParseFrame())) {
      const { opcode, payload } = frame;
      if (opcode === 0x1) {
        this.emit('message', payload.toString('utf8'));
      } else if (opcode === 0x8) {
        this.close();
      } else if (opcode === 0x9) {
        this._sendFrame(0xa, payload);
      }
    }
  }

  _tryParseFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return null;
    const firstByte = buf[0];
    const secondByte = buf[1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buf.length < offset + 2) return null;
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buf.length < offset + 8) return null;
      payloadLen = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + payloadLen) return null; // incomplete frame — wait for more bytes

    let payload = buf.subarray(offset, offset + payloadLen);
    if (masked) {
      const unmasked = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }

    this._buffer = buf.subarray(offset + payloadLen);
    return { opcode, payload: Buffer.from(payload) };
  }

  _sendFrame(opcode, payload) {
    const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const len = payloadBuf.length;
    let header;
    if (len <= 125) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payloadBuf]));
  }

  send(data) {
    if (!this.isOpen) return;
    this._sendFrame(0x1, typeof data === 'string' ? data : JSON.stringify(data));
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    try {
      this._sendFrame(0x8, Buffer.alloc(0));
    } catch {
      /* socket already gone */
    }
    this.socket.end();
  }
}

export function attachWebSocketServer(httpServer, onConnection) {
  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers['upgrade'] || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKeyFor(key)}\r\n\r\n`,
    );
    const ws = new MiniWebSocket(socket);
    onConnection(ws, req);
  });
}
