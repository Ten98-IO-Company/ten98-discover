import assert from 'node:assert/strict';
import test from 'node:test';
import { readExploreJson } from '../src/lib/explorer-combination.ts';

const json = { 'content-type': 'application/json' };
async function read(body: BodyInit | null, init: ResponseInit, signal = new AbortController().signal) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, init);
  try { return await readExploreJson<unknown>('/api/projects/p/explore', signal); }
  finally { globalThis.fetch = original; }
}
const rejects = (promise: Promise<unknown>, status: number, message: string) => assert.rejects(promise, (error: Error & { status?: number }) => error.message === message && error.status === status);

test('explorer combination reader returns strict JSON within the success ceiling', async () => {
  assert.deepEqual(await read('{"totals":{}}', { status: 200, headers: json }), { totals: {} });
  assert.deepEqual(await read('﻿{"a":1}', { status: 200, headers: json }), { a: 1 }, 'A UTF-8 byte order mark is ignored as before');
});

test('explorer combination reader maps size, encoding, status and media failures to its messages', async () => {
  await rejects(read(`"${'x'.repeat(2097152)}"`, { status: 200, headers: json }), 200, 'The complete combination response is too large. Narrow the filters.');
  await rejects(read(`{"error":"${'x'.repeat(8192)}"}`, { status: 400, headers: json }), 400, 'The complete combination response is too large. Narrow the filters.');
  await rejects(read(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200, headers: json }), 200, 'The combination response was incomplete or malformed.');
  await rejects(read('{"totals":', { status: 200, headers: json }), 200, 'The combination response was incomplete or malformed.');
  await rejects(read('{"error":"Explicit synthetic refusal"}', { status: 400, headers: json }), 400, 'Explicit synthetic refusal');
  await rejects(read('{}', { status: 500, headers: json }), 500, 'The combination report could not be loaded.');
  await rejects(read('{}', { status: 401, headers: json }), 401, 'Your session has expired. Sign in again.');
  await rejects(read('{}', { status: 404, headers: json }), 404, 'This project is unavailable.');
  await rejects(read('{}', { status: 206, headers: json }), 206, 'The combination response status could not be verified.');
  await rejects(read('{}', { status: 200, headers: { 'content-type': 'text/plain' } }), 200, 'The combination response could not be verified. Refresh the applied report.');
});

test('explorer combination reader lets an abort propagate unchanged', async () => {
  // A real aborted fetch errors its body stream with AbortError; the reader must not relabel it as malformed.
  const controller = new AbortController();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(stream) { body = stream; stream.enqueue(new TextEncoder().encode('{"a":')); } });
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => { init?.signal?.addEventListener('abort', () => body.error(new DOMException('Aborted', 'AbortError'))); return new Response(stream, { status: 200, headers: json }); };
  try {
    const pending = readExploreJson('/api/projects/p/explore', controller.signal);
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
  } finally { globalThis.fetch = original; }
});
