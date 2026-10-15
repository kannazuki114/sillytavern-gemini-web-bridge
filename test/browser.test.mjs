import test from 'node:test';
import assert from 'node:assert/strict';
import { CDP } from '../lib/cdp.mjs';
import { ask, close, configure, __pageScripts } from '../backends/gemini-cdp.mjs';

class Socket extends EventTarget {
  static instances = [];
  static handler = () => ({});
  static open = true;
  constructor() {
    super();
    this.readyState = 0;
    Socket.instances.push(this);
    if (Socket.open) queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  send(raw) {
    const msg = JSON.parse(raw);
    queueMicrotask(async () => {
      try {
        const result = await Socket.handler(msg, this);
        if (result !== undefined) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: msg.id, result }) }));
      } catch (e) {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: msg.id, error: { message: e.message } }) }));
      }
    });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}
function sockets(t) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  Socket.instances = [];
  Socket.handler = () => ({});
  Socket.open = true;
  t.after(async () => { await close(); globalThis.WebSocket = original; });
}
const status = (extra = {}) => ({
  hasEditor: true, generating: false, text: '', url: 'https://gemini.google.com/app',
  readyState: 'complete', documentId: 1, responseCount: 0, responseId: null, loginWall: false, ...extra,
});
function browser(t, { baseline = status(), afterSend, beforeSend, navigate, targetType = 'page', onNewChat } = {}) {
  sockets(t);
  let submitted = false;
  let polls = 0;
  let stopCalls = 0;
  let targetCalls = 0;
  const commands = [];
  t.mock.method(globalThis, 'fetch', async () => {
    targetCalls++;
    return { ok: true, json: async () => [{ type: targetType, url: baseline.url, webSocketDebuggerUrl: 'ws://fixture' }] };
  });
  Socket.handler = (msg) => {
    commands.push(msg.method);
    if (msg.method === 'Page.navigate') return navigate ? navigate() : {};
    if (msg.method !== 'Runtime.evaluate') return {};
    const src = msg.params.expression;
    let value;
    if (src === __pageScripts.status) value = submitted ? afterSend?.(++polls) ?? baseline : beforeSend?.() ?? baseline;
    else if (src === __pageScripts.clickSend) { submitted = true; polls = 0; value = true; }
    else if (src === __pageScripts.newChat) value = onNewChat?.() ?? true;
    else if (src === __pageScripts.stopGeneration) { stopCalls++; value = true; }
    else value = true;
    return { result: { value } };
  };
  configure({ newChatEachRequest: false, maxWaitMs: 3000, settleMs: 10 });
  return { commands, get stopCalls() { return stopCalls; }, get targetCalls() { return targetCalls; } };
}

test('CDP 连接超时、命令超时、取消、关闭均释放 pending', async (t) => {
  sockets(t);
  Socket.open = false;
  await assert.rejects(new CDP('ws://fixture', { timeoutMs: 20 }).connect(), { name: 'TimeoutError' });
  Socket.open = true;
  const cdp = await new CDP('ws://fixture', { timeoutMs: 30 }).connect();
  Socket.handler = () => undefined;
  await assert.rejects(cdp.send('Runtime.enable'), { name: 'TimeoutError' });
  assert.equal(cdp.connected, false);
  assert.equal(cdp.pending.size, 0);
  await assert.rejects(cdp.send('Runtime.enable'), /连接已关闭/);

  const next = await new CDP('ws://fixture', { timeoutMs: 500 }).connect();
  const controller = new AbortController();
  const pending = next.send('Runtime.evaluate', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(next.pending.size, 0);
  const closing = next.send('Runtime.enable');
  next.close();
  await assert.rejects(closing, /连接已关闭/);
  assert.equal(next.pending.size, 0);
});

test('新会话等待新文档、输入框和导航期间的执行上下文恢复', async (t) => {
  let navigated = false;
  let reads = 0;
  const fixture = browser(t, {
    navigate: () => { navigated = true; return { loaderId: 'new-loader' }; },
    beforeSend: () => {
      if (!navigated) return status();
      reads++;
      if (reads === 1) return status(); // Page.navigate 刚返回时的旧文档。
      if (reads === 2) return status({ hasEditor: false, readyState: 'loading', documentId: 2 });
      if (reads === 3) throw new Error('Execution context was destroyed');
      return status({ documentId: 2 });
    },
    afterSend: () => status({ documentId: 2, responseId: 1, responseCount: 1, text: 'ready answer' }),
  });
  configure({ newChatEachRequest: true, maxWaitMs: 4000, settleMs: 10 });
  assert.equal(await ask({ prompt: 'hello' }), 'ready answer');
  assert.ok(reads >= 4);
  assert.ok(fixture.commands.includes('Input.insertText'));
});

test('保留旧回答时不能成功，超时后停止生成且不输出旧文本', async (t) => {
  const old = status({ responseCount: 1, responseId: 1, text: 'PREVIOUS ANSWER' });
  const fixture = browser(t, { baseline: old, afterSend: () => old });
  configure({ newChatEachRequest: false, maxWaitMs: 1000, settleMs: 10 });
  const deltas = [];
  await assert.rejects(ask({ prompt: 'next', onDelta: (p) => deltas.push(p) }), { name: 'TimeoutError' });
  assert.deepEqual(deltas, []);
  assert.equal(fixture.stopCalls, 1);
});

test('回答修订后 SSE 与最终结果一致，生成中的旧回答不会串入', async (t) => {
  const old = status({ responseCount: 1, responseId: 1, text: 'OLD ANSWER' });
  browser(t, {
    baseline: old,
    afterSend: (poll) => poll <= 2 ? { ...old, generating: poll === 1 } : status({
      responseCount: 2, responseId: 2, text: poll === 3 ? 'Hello world' : 'Hello there', generating: poll === 3,
    }),
  });
  const deltas = [];
  const result = await ask({ prompt: 'next', onDelta: (p) => deltas.push(p) });
  assert.equal(result, 'Hello there');
  assert.equal(deltas.join(''), result);
});

test('相同文字但不同响应节点仍然是新回答', async (t) => {
  const old = status({ responseCount: 1, responseId: 1, text: 'same answer' });
  browser(t, { baseline: old, afterSend: () => ({ ...old, responseId: 2 }) });
  assert.equal(await ask({ prompt: 'next' }), 'same answer');
});

test('部分答案仍在生成时到期必须报错，不能输出正文或返回成功', async (t) => {
  const fixture = browser(t, {
    afterSend: () => status({ responseCount: 1, responseId: 1, text: 'PARTIAL', generating: true }),
  });
  configure({ newChatEachRequest: false, maxWaitMs: 1000, settleMs: 10 });
  const deltas = [];
  await assert.rejects(ask({ prompt: 'next', onDelta: (p) => deltas.push(p) }), { name: 'TimeoutError' });
  assert.deepEqual(deltas, []);
  assert.equal(fixture.stopCalls, 1);
});

test('活动浏览器请求取消会执行停止与清理', async (t) => {
  const controller = new AbortController();
  const fixture = browser(t, {
    afterSend: () => { controller.abort(); return status({ generating: true }); },
  });
  await assert.rejects(ask({ prompt: 'cancel', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fixture.stopCalls, 1);
});

test('断线后的下一次请求重新获取标签页并连接', async (t) => {
  let count = 0;
  browser(t, {
    beforeSend: () => status({ responseCount: count, responseId: count || null, text: count ? 'answer' : '' }),
    afterSend: (poll) => {
      if (poll === 1) count++;
      return status({ responseCount: count, responseId: count, text: 'answer' });
    },
  });
  assert.equal(await ask({ prompt: 'first' }), 'answer');
  Socket.instances[0].close();
  assert.equal(await ask({ prompt: 'second' }), 'answer');
  assert.equal(Socket.instances.length, 2);
});

test('桌面应用连接 WebView，使用新对话按钮而不导航应用外壳', async (t) => {
  let cleared = false;
  let initialReads = 0;
  const old = status({ responseCount: 1, responseId: 1, text: 'OLD' });
  const fixture = browser(t, {
    baseline: old, targetType: 'webview',
    beforeSend: () => {
      if (++initialReads === 1) return status({ hasEditor: false, readyState: 'loading' });
      return cleared ? status() : old;
    },
    onNewChat: () => { cleared = true; return true; },
    afterSend: () => status({ responseCount: 1, responseId: 2, text: 'desktop answer' }),
  });
  configure({ clientMode: 'desktop', autoLaunch: false, newChatEachRequest: true, maxWaitMs: 3000, settleMs: 10 });
  assert.equal(await ask({ prompt: 'desktop' }), 'desktop answer');
  assert.equal(cleared, true);
  assert.ok(initialReads > 1);
  assert.ok(!fixture.commands.includes('Page.navigate'));
});

test('直接连接应用页面 WebSocket，生成时无需 HTTP 端口发现', async (t) => {
  const fixture = browser(t, { afterSend: () => status({ responseCount: 1, responseId: 1, text: 'direct app answer' }) });
  configure({ clientMode: 'attach', cdpEndpoint: 'ws://127.0.0.1:9333/devtools/page/app', newChatEachRequest: true, maxWaitMs: 3000, settleMs: 10 });
  assert.equal(await ask({ prompt: 'direct' }), 'direct app answer');
  assert.equal(fixture.targetCalls, 0);
  assert.ok(!fixture.commands.includes('Page.navigate'));
});
