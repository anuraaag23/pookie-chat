'use client';

import { io, Socket } from 'socket.io-client';
import { getTokens } from '../api/client';

let socket: Socket | null = null;

export async function connectSocket(): Promise<Socket> {
  if (socket?.connected) return socket;
  const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
  // `auth` as a callback, not a plain object: socket.io-client only
  // evaluates a plain object's fields once, at construction — every
  // automatic reconnection attempt (socket.io reconnects on its own
  // after a transient drop, with no application code involved) would
  // keep resending that same original snapshot forever. Access tokens
  // expire after 15 minutes, so any real session outlasting one dropped
  // connection would otherwise start failing every reconnect attempt
  // with a token the server correctly rejects as expired — silently,
  // with nothing in the UI to explain why messages stopped arriving. A
  // callback is re-invoked on every single (re)connection attempt,
  // re-reading whatever the current token actually is at that moment —
  // this is socket.io-client's documented mechanism for exactly this
  // problem, not a workaround.
  socket = io(base, {
    auth: async (cb) => {
      const tokens = await getTokens();
      cb({ token: tokens?.accessToken });
    },
    transports: ['websocket'],
  });
  return new Promise((resolve, reject) => {
    socket!.on('connect', () => resolve(socket!));
    socket!.on('connect_error', (err) => reject(err));
  });
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
