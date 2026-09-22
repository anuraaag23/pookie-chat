import { createServer } from 'node:http';
import { attachWebSocketServer } from './mini-ws.mjs';

const server = createServer();
attachWebSocketServer(server, (ws) => {
  ws.on('message', (msg) => ws.send(`echo:${msg}`));
});

server.listen(0, async () => {
  const port = server.address().port;
  const ws = new WebSocket(`ws://localhost:${port}`);
  const results = [];
  ws.addEventListener('open', () => {
    ws.send('hello');
    ws.send(JSON.stringify({ big: 'x'.repeat(70000) })); // forces the 2-byte extended length path
  });
  ws.addEventListener('message', (event) => {
    results.push(typeof event.data === 'string' ? event.data.length : event.data.byteLength);
    if (results.length === 2) {
      console.log('Received', results.length, 'echoes. Lengths:', results);
      console.log(results[0] === 'echo:hello'.length && results[1] > 70000 ? 'PASS' : 'FAIL');
      ws.close();
      server.close();
    }
  });
  ws.addEventListener('error', (e) => console.log('WS ERROR', e.message || e));
});
