// 前端源文件。运行 npm run build 生成根目录 index.js（兼容经典脚本和模块加载）。
(function (root) {
  'use strict';
  const VERSION = /*__GWB_VERSION__*/"";
  const TEMPLATE = /*__GWB_TEMPLATE__*/"";
  const KEY = 'gemini-web-bridge';
  const DEFAULTS = { baseUrl: 'http://127.0.0.1:8788/v1', model: 'gemini-web', stream: true };
  const doc = root.document;
  if (root.GeminiWebBridge && root.GeminiWebBridge.version === VERSION) {
    root.GeminiWebBridge.activate().catch((e) => console.error('[Gemini Web Bridge]', e));
    return;
  }
  let mounting = null;
  let activePanel = null;

  function context() { return root.SillyTavern?.getContext?.() || {}; }
  function settings() {
    const store = context().extensionSettings;
    return Object.assign({}, DEFAULTS, store?.[KEY]);
  }
  function save(value) {
    const c = context();
    if (!c.extensionSettings) throw new Error('宿主未提供扩展设置存储，请等待酒馆加载完成后重试');
    const persist = c.saveSettingsDebounced || c.saveSettings;
    if (typeof persist !== 'function') throw new Error('宿主未提供保存设置接口，请手动配置 API 连接');
    c.extensionSettings[KEY] = { ...settings(), ...value };
    const pending = persist.call(c);
    if (pending && typeof pending.catch === 'function') pending.catch((e) => {
      console.error('[Gemini Web Bridge] 保存失败', e);
      if (activePanel) status(activePanel, '保存设置失败: ' + (e.message || String(e)), 'error');
    });
    return c.extensionSettings[KEY];
  }
  function normalizeBaseUrl(value) {
    let url;
    try { url = new URL(String(value).trim()); } catch { throw new Error('请填写有效的本机桥接地址，例如 http://127.0.0.1:8788/v1'); }
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
      throw new Error('桥接地址只支持本机回环 HTTP/HTTPS 地址，不接受账号、查询参数或外部网站地址');
    }
    const pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|completions|models|health)$/, '');
    if (pathname !== '' && pathname !== '/v1') throw new Error('桥接地址路径应为空或 /v1');
    return url.origin + '/v1';
  }
  async function jsonRequest(url, options = {}) {
    const controller = new root.AbortController();
    const timer = root.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await root.fetch(url, { cache: 'no-store', ...options, signal: controller.signal });
      let data;
      try { data = await response.json(); } catch { throw new Error('返回的不是 JSON，请确认该地址是 Gemini 桥接服务'); }
      if (!response.ok) throw new Error(data?.error?.message || 'HTTP ' + response.status);
      return data;
    } catch (e) {
      if (controller.signal.aborted) throw new Error('连接超时，请确认本机桥接服务正在运行');
      throw e;
    } finally { root.clearTimeout(timer); }
  }
  async function checkConnection(value) {
    const baseUrl = normalizeBaseUrl(value);
    const health = await jsonRequest(new URL('/health', baseUrl).href);
    if (health?.ok !== true || !['echo', 'gemini-cdp'].includes(health.backend)) throw new Error('该地址未返回 Gemini 桥接服务状态');
    const models = await jsonRequest(baseUrl + '/models');
    if (!Array.isArray(models?.data) || !models.data.every((model) => typeof model?.id === 'string')) throw new Error('模型列表格式不正确');
    if (!models.data.length) throw new Error('后端未提供任何模型');
    return { baseUrl, health, models: models.data.map((model) => model.id) };
  }
  async function discoverBackend() {
    const c = context();
    const data = await jsonRequest('/api/plugins/gemini-web-bridge/status', {
      credentials: 'same-origin', headers: typeof c.getRequestHeaders === 'function' ? c.getRequestHeaders() : {},
    });
    if (data?.ok !== true) throw new Error('酒馆服务端插件未运行；可直接填写本机桥接地址');
    return { baseUrl: normalizeBaseUrl(data.apiBaseUrl), model: String(data.model || DEFAULTS.model) };
  }
  function setControl(element, value, event) {
    if (!element) return;
    const jq = root.jQuery;
    if (typeof jq === 'function' && jq.fn?.jquery) {
      const control = jq(element);
      if (typeof value === 'boolean') control.prop('checked', value); else control.val(value);
      control.trigger(event);
    } else {
      if (typeof value === 'boolean') element.checked = value; else element.value = value;
      element.dispatchEvent(new root.Event(event, { bubbles: true }));
    }
  }
  function applyConnection(value) {
    const baseUrl = normalizeBaseUrl(value.baseUrl);
    const model = String(value.model || '').trim();
    if (!model || model.length > 200 || /[\r\n]/.test(model)) throw new Error('请填写有效模型 ID');
    const c = context();
    if (!c.chatCompletionSettings || typeof c.chatCompletionSettings !== 'object') throw new Error('宿主未提供聊天补全设置接口，请在 API 页面手动填写地址和模型');
    const persist = c.saveSettingsDebounced || c.saveSettings;
    if (!c.extensionSettings || typeof persist !== 'function') throw new Error('宿主未提供保存设置接口，未修改当前 API 设置');
    const main = doc?.querySelector('#main_api');
    const source = doc?.querySelector('#chat_completion_source');
    if (main && !Array.from(main.options).some((option) => option.value === 'openai')) throw new Error('当前宿主的 API 选择器不支持聊天补全，请手动设置');
    if (!main && c.mainApi !== 'openai') throw new Error('请先在 API 页面切换到“聊天补全”，然后再次应用');
    if (source && !Array.from(source.options).some((option) => option.value === 'custom')) throw new Error('当前宿主的聊天补全来源不支持 custom，请手动配置自定义 API');
    Object.assign(c.chatCompletionSettings, { chat_completion_source: 'custom', custom_url: baseUrl, custom_model: model, stream_openai: value.stream === true });
    // 所有设置先更新，再触发宿主事件；避免切换来源时仍使用旧的地址。
    setControl(doc?.querySelector('#custom_api_url_text'), baseUrl, 'input');
    setControl(doc?.querySelector('#custom_model_id'), model, 'input');
    setControl(doc?.querySelector('#stream_toggle'), value.stream === true, 'change');
    setControl(main, 'openai', 'change');
    setControl(source, 'custom', 'change');
    save({ baseUrl, model, stream: value.stream === true });
    return { baseUrl, model, stream: value.stream === true };
  }
  function status(panel, text, level = '') {
    const node = panel.querySelector('#gwb_status');
    if (node) { node.textContent = text; node.dataset.level = level; }
  }
  function readPanel(panel) {
    return {
      baseUrl: normalizeBaseUrl(panel.querySelector('#gwb_base_url').value),
      model: panel.querySelector('#gwb_model').value.trim(),
      stream: panel.querySelector('#gwb_stream').checked,
    };
  }
  function fillPanel(panel, value) {
    panel.querySelector('#gwb_base_url').value = value.baseUrl;
    panel.querySelector('#gwb_model').value = value.model;
    panel.querySelector('#gwb_stream').checked = value.stream;
  }
  function bindPanel(panel) {
    panel.querySelector('[data-gwb="version"]').textContent = 'v' + VERSION;
    fillPanel(panel, settings());
    for (const id of ['#gwb_base_url', '#gwb_model', '#gwb_stream']) {
      panel.querySelector(id).addEventListener('change', () => {
        try { save(readPanel(panel)); status(panel, '扩展设置已保存，尚未修改 API 连接。'); }
        catch (e) { status(panel, e.message, 'error'); }
      });
    }
    function button(id, action, hint = '') {
      panel.querySelector(id).addEventListener('click', async () => {
        const buttons = Array.from(panel.querySelectorAll('button'));
        buttons.forEach((node) => { node.disabled = true; });
        status(panel, '正在处理…');
        try { await action(); }
        catch (e) { status(panel, (e.message || String(e)) + (hint ? '\n' + hint : ''), 'error'); }
        finally { buttons.forEach((node) => { node.disabled = false; }); }
      });
    }
    button('#gwb_check', async () => {
      const result = await checkConnection(panel.querySelector('#gwb_base_url').value);
      const current = readPanel(panel);
      current.model = result.models.includes(current.model) ? current.model : result.models[0];
      current.baseUrl = result.baseUrl;
      const list = panel.querySelector('#gwb_models');
      list.replaceChildren();
      for (const id of result.models) { const option = doc.createElement('option'); option.value = id; list.appendChild(option); }
      fillPanel(panel, current);
      save(current);
      status(panel, '桥接服务已连接 · 后端: ' + result.health.backend + ' · 模型: ' + result.models.join(', ') +
        (result.health.backend === 'echo' ? '\n当前为 echo 自测后端，不会调用 Gemini。' : '\n此检测只确认桥接接口存活，Google 登录与实际生成需发送消息验证。'), 'success');
    }, '请先启动完整后端包中的 start-bridge-gemini.bat；如已启动，请检查地址、CORS 或本机网络访问权限。');
    button('#gwb_discover', async () => {
      const found = await discoverBackend();
      const value = { ...settings(), ...found, stream: panel.querySelector('#gwb_stream').checked };
      fillPanel(panel, value);
      save(value);
      status(panel, '已读取酒馆服务端插件地址，接下来点击“检测连接与模型”。', 'success');
    }, '此功能需要酒馆服务端插件。使用 TauriTavern 或独立桥接时，请直接填写本机桥接地址。');
    button('#gwb_apply', async () => {
      const value = applyConnection(readPanel(panel));
      status(panel, 'API 已设为 聊天补全 → 自定义\n地址: ' + value.baseUrl + '\n模型: ' + value.model + '\n请在 API 页面点击连接并发送测试消息。', 'success');
    });
  }
  function waitHost() {
    const get = () => doc.querySelector('#extensions_settings2') || doc.querySelector('#extensions_settings');
    const existing = get();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      let observer;
      const finish = (node) => { observer?.disconnect(); root.clearTimeout(timer); resolve(node); };
      const timer = root.setTimeout(() => finish(null), 15000);
      observer = new root.MutationObserver(() => { const node = get(); if (node) finish(node); });
      observer.observe(doc.documentElement, { childList: true, subtree: true });
    });
  }
  function activate() {
    if (!doc) return Promise.resolve(false);
    if (doc.getElementById('gwb_settings')) return Promise.resolve(true);
    if (mounting) return mounting;
    mounting = (async () => {
      const host = await waitHost();
      if (!host) return false;
      const holder = doc.createElement('div');
      holder.innerHTML = TEMPLATE;
      const panel = holder.querySelector('#gwb_settings');
      if (!panel) throw new Error('设置模板缺少 gwb_settings');
      bindPanel(panel);
      host.appendChild(panel);
      activePanel = panel;
      return true;
    })().finally(() => { mounting = null; });
    return mounting;
  }
  root.GeminiWebBridge = { version: VERSION, activate, settings, normalizeBaseUrl, checkConnection, discoverBackend, applyConnection };
  if (doc) {
    const boot = () => activate().catch((e) => { console.error('[Gemini Web Bridge]', e); if (activePanel) status(activePanel, e.message, 'error'); });
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
  }
})(globalThis);
