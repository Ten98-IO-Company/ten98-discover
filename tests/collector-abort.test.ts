import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { test } from 'node:test';
import { H3, serve, type H3Event } from 'nitro/h3';
import { collectorResponse } from '../src/server/collector-alias.ts';
import { InputError, readJson } from '../src/server/validation.ts';

const endpoints = ['/api/collect', '/api/replay/begin', '/api/replay/chunks', '/api/heatmaps/begin', '/api/heatmaps/batches', '/api/heatmaps/backgrounds', '/api/tracking-config'];

test('collector endpoints are answered by the API handler before TanStack Start', async () => {
  const handled: Request[] = [], handle = async (request: Request) => { handled.push(request); return new Response(null, { status: 202 }); };
  for (const path of endpoints) {
    const request = new Request('https://discover.example' + path, { method: 'POST' });
    assert.equal((await collectorResponse(request, '', handle, {}))?.status, 202, path);
    assert.equal(handled.at(-1), request, 'The same Request object keeps its transport peer and headers.');
  }
  for (const path of ['/', '/api/projects', '/api/collect/x', '/api/collectx', '/api/replay', '/api/heatmaps', '/tracker.js']) assert.equal(collectorResponse(new Request('https://discover.example' + path, { method: 'POST' }), '', handle, {}), undefined, path);
  assert.equal(handled.length, endpoints.length);
});

test('a collector request whose client disconnects mid-body is not reported as an unhandled 500', { timeout: 20_000 }, async t => {
  const errors = t.mock.method(console, 'error', () => undefined);
  let entered = () => {}, responded = () => {};
  // Like handleApi: a failed body read is an InputError answered as a client error, and every other outcome is answered too.
  const handle = async (request: Request) => {
    entered();
    try { await readJson(request, 360448); return new Response(null, { status: 202 }); }
    catch (error) { if (error instanceof InputError) return Response.json({ error: error.message }, { status: error.status }); throw error; }
  };
  // Stand-in for the TanStack Start route that otherwise serves /api/*: createStartHandler rethrows the request signal's reason
  // when the client is gone before the response, which h3 logs as an unhandled 500 with a stack trace.
  const start = async (event: H3Event) => {
    const response = await handle(event.req);
    const { signal } = event.req;
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    signal.throwIfAborted();
    return response;
  };
  const statuses: number[] = [];
  const h3 = new H3({ onResponse(response) { statuses.push(response.status); responded(); } });
  h3.use(event => collectorResponse(event.req, '', handle, {}));
  h3.all('/**', start);
  const server = serve(h3, { port: 0, hostname: '127.0.0.1', silent: true, gracefulShutdown: false });
  await server.ready();
  t.after(() => server.close(true));
  const port = Number(new URL(server.url!).port);
  for (const path of endpoints) {
    const handlerEntered = new Promise<void>(resolve => { entered = resolve; });
    const settled = new Promise<void>(resolve => { responded = resolve; });
    const socket = connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    await new Promise<void>(resolve => socket.once('connect', resolve));
    socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: https://site.example\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{"siteKey":`);
    await handlerEntered;
    socket.destroy();
    await settled;
    assert.notEqual(statuses.at(-1), 500, path);
  }
  assert.equal(statuses.length, endpoints.length, 'every aborted request completes on the server');
  assert.equal(errors.mock.callCount(), 0, 'a client disconnect logs no stack trace');
});
