/**
 * Checks whether Node 24's built-in env-proxy support (NODE_USE_ENV_PROXY) can
 * carry `fetch` through an HTTP CONNECT proxy, and whether NO_PROXY scoping keeps
 * unrelated hosts off the proxy.
 *
 *   node test-envproxy.mjs
 */

import net from 'node:net';
import { spawn } from 'node:child_process';

const seen = [];

const proxy = net.createServer((client) => {
  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString('latin1');
    if (!buf.includes('\r\n\r\n')) return;
    client.off('data', onData);
    const [requestLine] = buf.split('\r\n');
    seen.push(requestLine);
    const [method, target] = requestLine.split(' ');
    if (method !== 'CONNECT') {
      client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n');
      return;
    }
    const [host, port] = target.split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = buf.slice(buf.indexOf('\r\n\r\n') + 4);
      if (rest) upstream.write(Buffer.from(rest, 'latin1'));
      client.pipe(upstream).pipe(client);
    });
    upstream.on('error', () => client.destroy());
  };
  client.on('data', onData);
  client.on('error', () => {});
});

await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const port = proxy.address().port;
console.log('local CONNECT proxy on', port);

const child = spawn(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `const results = {};
     const grab = async (url) => {
       try { const res = await fetch(url, { signal: AbortSignal.timeout(15000) }); return res.status; }
       catch (error) { return 'ERR ' + (error.cause?.code || error.message); }
     };
     results.proxied = await grab('https://example.com/');
     results.exempt = await grab('https://example.org/');
     console.log(JSON.stringify(results));`
  ],
  {
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: `http://127.0.0.1:${port}`,
      HTTP_PROXY: `http://127.0.0.1:${port}`,
      NO_PROXY: 'example.org,localhost,127.0.0.1'
    },
    stdio: ['ignore', 'inherit', 'inherit']
  }
);
await new Promise((resolve) => child.on('exit', resolve));
proxy.close();

console.log('proxy saw:', seen.length ? seen : '(nothing)');
const proxied = seen.some((line) => line.includes('example.com:443'));
const exempt = seen.some((line) => line.includes('example.org'));
console.log(proxied ? 'PASS  example.com went through the proxy' : 'FAIL  example.com did not use the proxy');
console.log(exempt ? 'FAIL  example.org leaked to the proxy' : 'PASS  example.org stayed direct (NO_PROXY)');