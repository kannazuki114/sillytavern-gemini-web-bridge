import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import * as plugin from '../index.mjs';
import { createBridge } from '../lib/bridge.mjs';
import * as echo from '../backends/echo.mjs';
import { startService } from '../lib/service.mjs';

async function listen(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return 'http://127.0.0.1:' + server.address().port;
}

test('SillyTavern 插件导出、Express 路由、自动监听和退出契约', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gemini-plugin-test-'));
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ host: '127.0.0.1', port: 0, backend: 'echo' }));
  const previous = process.env.GEMINI_BRIDGE_CONFIG;
  process.env.GEMINI_BRIDGE_CONFIG = configPath;
  t.after(async () => {
    await plugin.exit();
    if (previous === undefined) delete process.env.GEMINI_BRIDGE_CONFIG;
    else process.env.GEMINI_BRIDGE_CONFIG = previous;
    await unlink(configPath);
    await rmdir(dir);
  });
  const signals = ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name));
  assert.match(plugin.info.id, /^[a-z0-9_-]+$/);
  for (const field of ['id', 'name', 'description']) assert.equal(typeof plugin.info[field], 'string');
  const app = express();
  app.use(express.json());
  // 模拟酒馆对自身路由的 CSRF 校验；模型端点无需使用酒馆 Cookie。
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.get('X-CSRF-Token') !== 'session-token') return res.sendStatus(403);
    next();
  });
  const router = express.Router();
  await plugin.init(router);
  assert.ok(router.stack.length > 0);
  app.use('/api/plugins/' + plugin.info.id, router);
  const host = await listen(t, app);
  const status = await (await fetch(host + '/api/plugins/gemini-web-bridge/status')).json();
  assert.equal(status.ok, true);
  assert.equal(status.backend, 'echo');
  assert.match(status.apiBaseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  const r = await fetch(status.apiBaseUrl + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'plugin test' }], stream: false }),
  });
  assert.equal(r.status, 200);
  assert.match((await r.json()).choices[0].message.content, /plugin test/);
  assert.equal((await fetch(host + '/api/plugins/gemini-web-bridge/v1/chat/completions', { method: 'POST' })).status, 403);
  assert.deepEqual(['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name)), signals);
  await assert.rejects(plugin.init(express.Router()), /已经加载/);
  await plugin.exit();
  await plugin.exit(); // exit 幂等，不能结束酒馆进程。
  await assert.rejects(fetch(status.apiBaseUrl + '/models', { signal: AbortSignal.timeout(1000) }));
  assert.equal((await (await fetch(host + '/api/plugins/gemini-web-bridge/status')).json()).ok, false);
});

test('共享 handler 可处理已被 Express JSON 中间件消费的请求体', async (t) => {
  const bridge = createBridge({ config: {}, backend: echo, backendName: 'echo', log: () => {} });
  t.after(() => bridge.close());
  const app = express();
  app.use(express.json());
  app.use('/mounted', bridge.handle);
  const origin = await listen(t, app);
  const r = await fetch(origin + '/mounted/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'parsed by Express' }] }),
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(r.status, 200);
  assert.match((await r.json()).choices[0].message.content, /parsed by Express/);
});

test('端口冲突只让插件初始化失败，不影响宿主；监听地址限于本机', async (t) => {
  const origin = await listen(t, (_req, res) => res.end('host still alive'));
  const port = Number(new URL(origin).port);
  await assert.rejects(startService({ host: '127.0.0.1', port, backend: 'echo' }), /已占用/);
  assert.equal(await (await fetch(origin)).text(), 'host still alive');
  await assert.rejects(startService({ host: '0.0.0.0', port: 0, backend: 'echo' }), /回环地址/);
});
