import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { Script } from 'node:vm';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import jquery from 'jquery';
import { createBridge } from '../lib/bridge.mjs';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
function fixture(t, { host = true, storage = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    ${host ? '<div id="extensions_settings2"></div>' : ''}
    <select id="main_api"><option value="kobold">Kobold</option><option value="openai">Chat Completion</option></select>
    <select id="chat_completion_source"><option value="openai">OpenAI</option><option value="custom">Custom</option></select>
    <input id="custom_api_url_text"><input id="custom_model_id"><input id="stream_toggle" type="checkbox">
  </body></html>`, { url: 'http://tavern.test/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const win = dom.window;
  let saved = 0;
  const context = {
    mainApi: 'kobold', extensionSettings: storage,
    chatCompletionSettings: { chat_completion_source: 'openai', custom_url: 'https://old.example', custom_model: 'old-model', temperature: 0.7 },
    saveSettingsDebounced: () => { saved++; }, getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-csrf' }),
  };
  win.SillyTavern = { getContext: () => context };
  win.fetch = () => { throw new Error('加载面板时不应产生网络请求'); };
  win.document.querySelector('#main_api').addEventListener('change', (e) => { context.mainApi = e.target.value; });
  win.eval(source);
  return { win, context, api: win.GeminiWebBridge, get saved() { return saved; } };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await sleep(10); }
  assert.fail('等待面板动作超时');
}

test('manifest 指向可直接解析的前端脚本、样式和一致版本', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.js, 'index.js');
  assert.equal(manifest.css, 'style.css');
  for (const name of [manifest.js, manifest.css, 'settings.html']) assert.ok(existsSync(new URL('../' + name, import.meta.url)));
  assert.doesNotThrow(() => new Script(source)); // 经典脚本不能含 import/export。
  assert.ok(!source.includes('/*__GWB_'));
  assert.match(source, /gwb_settings/);
  assert.ok(!source.includes('node:'));
});

test('前端经典脚本加载、延迟宿主挂载、重复加载与目录改名', async (t) => {
  const f = fixture(t, { host: false });
  const activation = f.api.activate();
  const host = f.win.document.createElement('div');
  host.id = 'extensions_settings';
  f.win.document.body.appendChild(host);
  assert.equal(await activation, true);
  assert.match(host.textContent, /Gemini 网页桥接/);
  // 无资源路径依赖；任意仓库/安装目录名均使用嵌入的静态模板。
  assert.ok(!source.includes('/scripts/extensions/third-party/'));
  await f.api.activate();
  f.win.eval(source);
  await f.win.GeminiWebBridge.activate();
  assert.equal(f.win.document.querySelectorAll('#gwb_settings').length, 1);
  assert.equal(f.context.chatCompletionSettings.custom_model, 'old-model');
});

test('面板设置保存到宿主，并在重新加载后恢复', async (t) => {
  const storage = {};
  const f = fixture(t, { storage });
  await f.api.activate();
  const input = f.win.document.querySelector('#gwb_base_url');
  input.value = 'http://localhost:9338';
  input.dispatchEvent(new f.win.Event('change', { bubbles: true }));
  assert.equal(storage['gemini-web-bridge'].baseUrl, 'http://localhost:9338/v1');
  assert.ok(f.saved > 0);
  const second = fixture(t, { storage });
  await second.api.activate();
  assert.equal(second.win.document.querySelector('#gwb_base_url').value, 'http://localhost:9338/v1');
  assert.equal(second.context.chatCompletionSettings.custom_model, 'old-model');
});

test('应用连接会同步真实 DOM、宿主设置和变更事件，不在挂载时改动 API', async (t) => {
  const f = fixture(t);
  await f.api.activate();
  assert.equal(f.context.mainApi, 'kobold');
  let changed;
  f.win.document.querySelector('#chat_completion_source').addEventListener('change', () => { changed = { ...f.context.chatCompletionSettings }; });
  const result = f.api.applyConnection({ baseUrl: 'http://127.0.0.1:8788', model: 'gemini-web', stream: true });
  assert.equal(result.baseUrl, 'http://127.0.0.1:8788/v1');
  assert.equal(f.context.mainApi, 'openai');
  assert.equal(f.context.chatCompletionSettings.chat_completion_source, 'custom');
  assert.equal(f.context.chatCompletionSettings.custom_url, result.baseUrl);
  assert.equal(f.context.chatCompletionSettings.custom_model, 'gemini-web');
  assert.equal(f.context.chatCompletionSettings.temperature, 0.7);
  assert.equal(f.win.document.querySelector('#custom_api_url_text').value, result.baseUrl);
  assert.equal(f.win.document.querySelector('#stream_toggle').checked, true);
  assert.equal(changed.custom_url, result.baseUrl);
  assert.equal(changed.custom_model, 'gemini-web');
});

test('兼容酒馆的 jQuery 事件处理器', async (t) => {
  const f = fixture(t);
  const $ = jquery(f.win);
  f.win.jQuery = $;
  let changes = 0;
  $('#custom_api_url_text').on('input', () => { changes++; });
  await f.api.activate();
  f.api.applyConnection({ baseUrl: 'http://localhost:8788/v1', model: 'another-model', stream: false });
  assert.equal(changes, 1);
  assert.equal($('#chat_completion_source').val(), 'custom');
  assert.equal($('#custom_model_id').val(), 'another-model');
  assert.equal(f.context.chatCompletionSettings.stream_openai, false);
});

test('宿主接口缺失或来源不兼容时明确拒绝，避免修改一半', async (t) => {
  const f = fixture(t);
  await f.api.activate();
  const before = JSON.stringify(f.context.chatCompletionSettings);
  f.win.document.querySelector('#chat_completion_source option[value="custom"]').remove();
  assert.throws(() => f.api.applyConnection({ baseUrl: 'http://127.0.0.1:8788', model: 'gemini-web' }), /不支持 custom/);
  assert.equal(JSON.stringify(f.context.chatCompletionSettings), before);
  delete f.context.chatCompletionSettings;
  assert.throws(() => f.api.applyConnection({ baseUrl: 'http://127.0.0.1:8788', model: 'gemini-web' }), /手动填写/);
});

test('连接检测对接真实 HTTP 后端，仅请求健康和模型，不触发生成', async (t) => {
  let generations = 0;
  const bridge = createBridge({ config: {}, backendName: 'echo', backend: { ask: async () => { generations++; return 'unused'; } }, log: () => {} });
  const server = http.createServer(bridge.handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await bridge.close(); await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); });
  const f = fixture(t);
  // fetch 和 AbortController 在真实浏览器里来自同一个环境；Node fetch 不接受 jsdom 的信号。
  f.win.AbortController = globalThis.AbortController;
  f.win.fetch = globalThis.fetch;
  await f.api.activate();
  f.win.document.querySelector('#gwb_base_url').value = 'http://127.0.0.1:' + server.address().port;
  f.win.document.querySelector('#gwb_check').click();
  await until(() => ['success', 'error'].includes(f.win.document.querySelector('#gwb_status').dataset.level));
  assert.equal(f.win.document.querySelector('#gwb_status').dataset.level, 'success', f.win.document.querySelector('#gwb_status').textContent);
  assert.equal(f.win.document.querySelector('#gwb_model').value, 'gemini-web');
  assert.match(f.win.document.querySelector('#gwb_status').textContent, /echo 自测后端/);
  assert.equal(f.win.document.querySelector('#gwb_check').disabled, false);
  assert.equal(generations, 0);
});

test('读取服务端插件地址使用宿主请求头，并可修正原先的无效输入', async (t) => {
  const f = fixture(t);
  let observed;
  f.win.fetch = async (url, options) => {
    observed = { url, options };
    return { ok: true, json: async () => ({ ok: true, apiBaseUrl: 'http://localhost:9888/v1', model: 'custom-gemini' }) };
  };
  await f.api.activate();
  f.win.document.querySelector('#gwb_base_url').value = 'bad address';
  f.win.document.querySelector('#gwb_discover').click();
  await until(() => f.win.document.querySelector('#gwb_status').dataset.level === 'success');
  assert.equal(observed.url, '/api/plugins/gemini-web-bridge/status');
  assert.equal(observed.options.headers['X-CSRF-Token'], 'test-csrf');
  assert.equal(observed.options.credentials, 'same-origin');
  assert.equal(f.win.document.querySelector('#gwb_base_url').value, 'http://localhost:9888/v1');
});

test('无后端与错误响应会在面板显示错误，并恢复按钮', async (t) => {
  const f = fixture(t);
  f.win.fetch = async () => { throw new Error('Failed to fetch'); };
  await f.api.activate();
  f.win.document.querySelector('#gwb_check').click();
  await until(() => f.win.document.querySelector('#gwb_status').dataset.level === 'error');
  assert.match(f.win.document.querySelector('#gwb_status').textContent, /start-bridge-gemini\.bat/);
  assert.equal(f.win.document.querySelector('#gwb_check').disabled, false);
  assert.equal(f.context.chatCompletionSettings.custom_model, 'old-model');
  f.win.fetch = async () => ({ ok: true, json: async () => ({ ok: true, backend: 'unknown' }) });
  await assert.rejects(f.api.checkConnection('http://localhost:8788'), /未返回 Gemini/);
});

test('桥接 URL 规范化与外部地址拒绝', async (t) => {
  const f = fixture(t);
  await f.api.activate();
  assert.equal(f.api.normalizeBaseUrl('http://localhost:8788/v1/chat/completions'), 'http://localhost:8788/v1');
  assert.equal(f.api.normalizeBaseUrl('http://[::1]:8788/'), 'http://[::1]:8788/v1');
  for (const url of ['https://gemini.google.com/app', 'javascript:alert(1)', 'http://localhost:8788/?key=secret', 'http://u:p@localhost:8788/']) {
    assert.throws(() => f.api.normalizeBaseUrl(url), /桥接地址/);
  }
});
