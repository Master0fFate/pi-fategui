import net from 'node:net';

const host = '127.0.0.1';
const port = 5173;
const socket = net.createConnection({ host, port });

const finish = (code, message) => {
  socket.destroy();
  if (message) console.error(message);
  process.exit(code);
};

socket.setTimeout(1_000);
socket.once('connect', () => finish(1, [
  `Fate UI cannot start because ${host}:${port} is already in use.`,
  'An older development stack may still be running. Close its Fate UI window or stop that terminal, then run pnpm dev again.',
].join('\n')));
socket.once('timeout', () => finish(0));
socket.once('error', (error) => {
  if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH') finish(0);
  else finish(1, `Fate UI could not check development port ${port}: ${error.message}`);
});
