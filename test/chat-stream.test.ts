import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readChatStream } from '../src/chat-stream.js';

test('CLI consumes node SSE deltas before the final structured result', async () => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let first!: () => void;
  const visible = new Promise<void>(resolve => { first = resolve; });
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { 'content-type': 'text/event-stream' } });
  const deltas: string[] = [];
  const result = readChatStream(response, (text, mode) => { deltas.push(`${mode}:${text}`); first(); });
  controller!.enqueue(new TextEncoder().encode('data: {"object":"chat.completion.chunk","ainize_mode":"patched","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n'));
  await visible;
  assert.deepEqual(deltas, ['patched:hello']);
  controller!.enqueue(new TextEncoder().encode('event: ainize.result\ndata: {"patched":{"content":"hello"}}\n\ndata: [DONE]\n\n'));
  assert.deepEqual(await result, { patched: { content: 'hello' } });
});

test('CLI rejects missing results, interrupted streams and HTTP failures', async () => {
  const sse = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(readChatStream(sse('data: [DONE]\n\n'), () => undefined), /final chat result/);
  await assert.rejects(readChatStream(sse(''), () => undefined), /unexpectedly/);
  await assert.rejects(readChatStream(new Response('denied', { status: 403 }), () => undefined), /403/);
});
