/**
 * A tiny RFC 6455 WebSocket server, just enough for the fixture site to accept
 * a connection and exchange a couple of small text frames. Dependencies stay at
 * zero on purpose — api-recon only needs a browser to open a real socket, so the
 * server never has to be feature-complete, and the tool's own capture layer is
 * what is under test.
 */

import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WebSocketHandlers {
  /** Called once the handshake is complete; use `send` to push a frame. */
  onOpen: (send: (text: string) => void, close: () => void) => void;
  /** Called for each text frame the client sends. */
  onMessage: (text: string, send: (text: string) => void, close: () => void) => void;
}

export function attachWebSocketServer(server: Server, handlers: WebSocketHandlers): void {
  server.on('upgrade', (req, socket: Duplex) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }

    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const send = (text: string): void => {
      if (!socket.writable) return;
      socket.write(encodeFrame(text));
    };
    const close = (): void => {
      if (!socket.writable) return;
      try {
        socket.write(encodeFrame('', 0x8));
      } catch {
        /* the client may already be gone */
      }
      socket.end();
    };

    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = frame.rest;
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        if (frame.opcode === 0x1) handlers.onMessage(frame.payload.toString('utf8'), send, close);
      }
    });
    socket.on('error', () => {
      /* a client may drop mid-frame; nothing to clean up */
    });

    handlers.onOpen(send, close);
  });
}

function encodeFrame(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

interface DecodedFrame {
  opcode: number;
  payload: Buffer;
  rest: Buffer;
}

/** Decode one client frame, or return null when the buffer holds only part of one. */
function decodeFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  let mask: Buffer | null = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
  }
  return { opcode, payload, rest: buffer.subarray(offset + length) };
}
