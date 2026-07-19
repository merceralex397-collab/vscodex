const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { build } = require('esbuild');

void (async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-json-rpc-test-'));
  const bundlePath = join(tempDirectory, 'json-rpc.cjs');

  try {
    await build({
      entryPoints: ['src/appServer/jsonRpcStdioClient.ts'],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      outfile: bundlePath
    });
    const rpc = require(bundlePath);

    await testFragmentationAndCorrelation(rpc);
    await testDeferredServerRequest(rpc);
    await testServerRequestTimeout(rpc);
    await testRequestTimeoutAndLateResponse(rpc);
    await testCancellationAndStructuredError(rpc);
    await testWriteBackpressure(rpc);
    await testMalformedFrameFailsPendingRequests(rpc);
    await testInputEndFailsPendingRequests(rpc);

    console.log('JSON-RPC stdio client tests passed.');
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function testFragmentationAndCorrelation(rpc) {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const client = new rpc.JsonRpcStdioClient(incoming, outgoing);
  const notifications = [];
  client.onNotification((notification) => notifications.push(notification));

  const sent = nextChunk(outgoing);
  const resultPromise = client.request('model/list', { cursor: null });
  const request = JSON.parse((await sent).toString('utf8'));
  assert.equal(request.method, 'model/list');

  const response = Buffer.from(`${JSON.stringify({ id: request.id, result: { data: '🧠' } })}\n${JSON.stringify({ method: 'account/updated', params: { authMode: 'chatgpt' } })}\n`);
  incoming.write(response.subarray(0, response.length - 3));
  incoming.write(response.subarray(response.length - 3));

  assert.deepEqual(await resultPromise, { data: '🧠' });
  await immediate();
  assert.deepEqual(notifications, [{
    method: 'account/updated',
    params: { authMode: 'chatgpt' }
  }]);
  client.dispose();
}

async function testDeferredServerRequest(rpc) {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const client = new rpc.JsonRpcStdioClient(incoming, outgoing, {
    serverRequestTimeoutMs: 1_000
  });
  let pending;
  client.onServerRequest((request) => {
    pending = request;
  });

  incoming.write(`${JSON.stringify({
    id: 'server-1',
    method: 'item/tool/call',
    params: { callId: 'call-1' }
  })}\n`);
  await immediate();
  assert.equal(pending.method, 'item/tool/call');
  assert.equal(pending.settled, false);

  const responseChunk = nextChunk(outgoing);
  await pending.respond({ success: true, contentItems: [] });
  assert.deepEqual(JSON.parse((await responseChunk).toString('utf8')), {
    id: 'server-1',
    result: { success: true, contentItems: [] }
  });
  assert.equal(pending.settled, true);
  client.dispose();
}

async function testServerRequestTimeout(rpc) {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const client = new rpc.JsonRpcStdioClient(incoming, outgoing, {
    serverRequestTimeoutMs: 20
  });
  client.onServerRequest(() => undefined);

  const responseChunk = nextChunk(outgoing);
  incoming.write('{"id":7,"method":"item/tool/call","params":{}}\n');
  const response = JSON.parse((await responseChunk).toString('utf8'));
  assert.equal(response.id, 7);
  assert.equal(response.error.code, -32000);
  client.dispose();
}

async function testRequestTimeoutAndLateResponse(rpc) {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const client = new rpc.JsonRpcStdioClient(incoming, outgoing, {
    requestTimeoutMs: 20
  });

  let sent = nextChunk(outgoing);
  const timedOut = client.request('slow/method');
  const slowRequest = JSON.parse((await sent).toString('utf8'));
  await assert.rejects(timedOut, (error) => error.name === 'JsonRpcTimeoutError');

  incoming.write(`${JSON.stringify({ id: slowRequest.id, result: 'late' })}\n`);
  sent = nextChunk(outgoing);
  const nextRequestPromise = client.request('fast/method', {}, { timeoutMs: 1_000 });
  const nextRequest = JSON.parse((await sent).toString('utf8'));
  incoming.write(`${JSON.stringify({ id: nextRequest.id, result: 'ok' })}\n`);
  assert.equal(await nextRequestPromise, 'ok');
  assert.equal(client.isClosed, false);
  client.dispose();
}

async function testCancellationAndStructuredError(rpc) {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const client = new rpc.JsonRpcStdioClient(incoming, outgoing);

  let sent = nextChunk(outgoing);
  const failed = client.request('thread/start');
  const failedRequest = JSON.parse((await sent).toString('utf8'));
  incoming.write(`${JSON.stringify({
    id: failedRequest.id,
    error: { code: 42, message: 'structured failure', data: { retry: false } }
  })}\n`);
  await assert.rejects(
    failed,
    (error) => error.name === 'JsonRpcResponseError'
      && error.code === 42
      && error.data.retry === false
  );

  const controller = new AbortController();
  sent = nextChunk(outgoing);
  const cancelled = client.request('turn/start', {}, { signal: controller.signal });
  const cancelledRequest = JSON.parse((await sent).toString('utf8'));
  controller.abort();
  await assert.rejects(cancelled, (error) => error.name === 'JsonRpcRequestCancelledError');
  incoming.write(`${JSON.stringify({ id: cancelledRequest.id, result: 'late' })}\n`);
  await immediate();
  assert.equal(client.isClosed, false);
  client.dispose();
}

async function testWriteBackpressure(rpc) {
  const incoming = new PassThrough();
  const chunks = [];
  const outgoing = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      setTimeout(callback, 10);
    }
  });
  const client = new rpc.JsonRpcStdioClient(incoming, outgoing);
  await client.notify('initialized', {});
  assert.equal(JSON.parse(Buffer.concat(chunks).toString('utf8')).method, 'initialized');
  client.dispose();
}

async function testMalformedFrameFailsPendingRequests(rpc) {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const client = new rpc.JsonRpcStdioClient(incoming, outgoing);

  const sent = nextChunk(outgoing);
  const pending = client.request('thread/start');
  await sent;
  incoming.write('{not-json}\n');
  await assert.rejects(pending, (error) => error.name === 'JsonRpcProtocolError');
  assert.equal(client.isClosed, true);
}

async function testInputEndFailsPendingRequests(rpc) {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const client = new rpc.JsonRpcStdioClient(incoming, outgoing);

  const sent = nextChunk(outgoing);
  const pending = client.request('thread/start');
  await sent;
  incoming.end();
  await assert.rejects(pending, (error) => error.name === 'JsonRpcTransportError');
}

function nextChunk(stream) {
  return new Promise((resolve, reject) => {
    stream.once('data', resolve);
    stream.once('error', reject);
  });
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}
