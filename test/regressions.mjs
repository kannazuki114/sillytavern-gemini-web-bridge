import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { renderMessages } from '../lib/render.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function start(t, backend = 'echo', env = {}) {
  // 同时回归 --name=value 的解析；端口 0 交给 OS 分配，避免端口冲突。
  const child = spawn(process.execPath, ['server.mjs', '--backend=' + backend, '--port=0'], {
    cwd: root, env: { ...process.env, BRIDGE_HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let logs = '';
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  child.stdout.on('data', (b) => {
    logs += b;
    const match = logs.match(/监听 (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) resolveReady(match[1]);
  });
  child.stderr.on('data', (b) => { logs += b; });
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
  const base = await Promise.race([
    ready,
    exited.then(() => { throw new Error('服务提前退出: ' + logs); }),
    sleep(5000, null, { ref: false }).then(() => { throw new Error('启动超时: ' + logs); }),
  ]);
  return { base, child };
}
function post(base, route, body, options = {}) {
  return fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(5000), ...options,
  });
}
async function events(file) {
  try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(20); }
  assert.fail('等待测试事件超时');
}

test('lastUser 按 role 选择具名用户，空上下文不生成固定模板', () => {
  assert.equal(renderMessages([
    { role: 'user', name: 'Alice', content: [{ type: 'text', text: 'new question' }] },
    { role: 'assistant', content: 'old assistant answer' },
  ], { contextMode: 'lastUser' }), 'new question');
  assert.equal(renderMessages([{ role: 'assistant', content: 'answer' }], { contextMode: 'lastUser' }), '');
  assert.equal(renderMessages([]), '');
  assert.equal(renderMessages([{ role: 'user', content: '  ' }]), '');
});

test('HTTP 启动、原有 smoke、自检与异常输入', { timeout: 15000 }, async (t) => {
  const { base, child } = await start(t);
  const smoke = spawn(process.execPath, ['test/smoke.mjs'], {
    cwd: root, env: { ...process.env, BASE: base }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  smoke.stdout.on('data', (b) => { output += b; });
  smoke.stderr.on('data', (b) => { output += b; });
  assert.equal((await once(smoke, 'exit'))[0], 0, output);
  for (const route of ['/v1/chat/completions', '/v1/completions']) {
    for (const body of ['null', '[]', '{bad json', '{}']) {
      const r = await post(base, route, body);
      assert.equal(r.status, 400, route + ' ' + body);
      assert.equal((await r.json()).error.type, 'invalid_request_error');
    }
  }
  for (const messages of [[], {}, [null], [{ role: 'user', content: ' ' }], [{ role: 'user', content: { text: 'x' } }]]) {
    assert.equal((await post(base, '/v1/chat/completions', { messages })).status, 400);
  }
  assert.equal((await post(base, '/v1/completions', { prompt: ' ' })).status, 400);
  assert.equal((await post(base, '/v1/completions', { prompt: ['x'] })).status, 400);
  assert.equal((await post(base, '/v1/completions', { prompt: 'x', stream: 'true' })).status, 400);
  for (const [route, body] of [
    ['/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }] }],
    ['/v1/completions', { prompt: 'hello' }],
  ]) {
    const r = await post(base, route, body);
    assert.match(r.headers.get('content-type'), /application\/json/);
    const json = await r.json();
    const sse = await (await post(base, route, { ...body, stream: true })).text();
    assert.ok(sse.endsWith('data: [DONE]\n\n'));
    const frames = sse.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
    const text = frames.map((f) => f.choices[0].delta?.content ?? f.choices[0].text ?? '').join('');
    assert.equal(text, json.choices[0].message?.content ?? json.choices[0].text);
  }
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/health', { headers: { Host: '[' } }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); }).on('error', reject);
  });
  assert.equal(hostStatus, 200);
  assert.equal(child.exitCode, null);
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/v1/chat/completions')).status, 405);
  assert.equal((await post(base, '/v1/models', {})).status, 405);
  assert.equal((await post(base, '/v1/completions', JSON.stringify({ prompt: 'x'.repeat(10 * 1024 * 1024) }))).status, 413);
});

test('取消活动请求、跳过取消的排队任务、清理后继续；覆盖两种接口与传输模式', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gemini-bridge-test-'));
  const file = path.join(dir, 'events.jsonl');
  t.after(async () => {
    try { await unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await rmdir(dir);
  });
  const { base } = await start(t, '../test/fixtures/slow', { BRIDGE_TEST_LOG: file });
  let index = 0;
  for (const route of ['/v1/chat/completions', '/v1/completions']) {
    for (const stream of [false, true]) {
      const prefix = String(index++);
      const active = new AbortController();
      const queued = new AbortController();
      const payload = (suffix, delayMs) => ({
        messages: [{ role: 'user', content: 'test' }], prompt: 'test', stream, testId: prefix + suffix, delayMs,
      });
      const request = post(base, route, payload('active', 3000), { signal: active.signal }).then((r) => r.text()).catch(() => {});
      await until(async () => (await events(file)).some((e) => e.id === prefix + 'active' && e.event === 'started'));
      // SSE 的首帧可确认第二个请求已进入服务器；非流式等待一小段时间让其排队。
      const queuedRequest = post(base, route, payload('queued', 10), { signal: queued.signal });
      const queuedDone = queuedRequest.then((r) => r.text()).catch(() => {});
      if (stream) await queuedRequest; else await sleep(50);
      queued.abort();
      await sleep(30);
      active.abort();
      await Promise.all([request, queuedDone]);
      const next = await post(base, route, { ...payload('next', 1), stream: false });
      assert.equal(next.status, 200);
      await next.json();
      const recorded = await events(file);
      assert.ok(recorded.some((e) => e.id === prefix + 'active' && e.event === 'aborted'));
      assert.ok(!recorded.some((e) => e.id === prefix + 'queued' && e.event === 'started'));
      const cleaned = recorded.findIndex((e) => e.id === prefix + 'active' && e.event === 'cleaned');
      const started = recorded.findIndex((e) => e.id === prefix + 'next' && e.event === 'started');
      assert.ok(cleaned !== -1 && started > cleaned);
    }
  }
  for (const route of ['/v1/chat/completions', '/v1/completions']) {
    const body = { messages: [{ role: 'user', content: 'test' }], prompt: 'test', testId: 'failure', delayMs: 1, fail: true };
    const r = await post(base, route, body);
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error.code, 'upstream_timeout');
    const sse = await (await post(base, route, { ...body, stream: true })).text();
    assert.match(sse, /"error":/);
    assert.ok(!sse.includes('"finish_reason":"stop"'));
    assert.ok(!sse.includes('[错误]'));
    assert.ok(sse.endsWith('data: [DONE]\n\n'));
  }
});
