// 极简 Chrome DevTools Protocol 客户端，只用 Node 内建的 WebSocket。
export class CDP {
  constructor(wsUrl, { timeoutMs = 10000 } = {}) {
    this.wsUrl = wsUrl;
    this.timeoutMs = timeoutMs;
    this.seq = 0;
    this.pending = new Map();
    this.ws = null;
  }

  get connected() { return this.ws?.readyState === 1; }

  fail(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  async connect({ signal } = {}) {
    signal?.throwIfAborted();
    if (typeof WebSocket !== 'function') throw new Error('请使用 Node.js 22+（需要内建 WebSocket）');
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      if (msg.error) pending.reject(new Error('CDP ' + JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    });
    ws.addEventListener('close', () => this.fail(new Error('CDP 连接已关闭')));
    ws.addEventListener('error', () => {
      this.fail(new Error('CDP 连接出错'));
      this.close();
    });
    try {
      await new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(timer);
          ws.removeEventListener('open', onOpen);
          ws.removeEventListener('error', onError);
          ws.removeEventListener('close', onClose);
          signal?.removeEventListener('abort', onAbort);
          if (error) reject(error); else resolve();
        };
        const onOpen = () => finish();
        const onError = () => finish(new Error('无法连接 CDP: ' + this.wsUrl));
        const onClose = () => finish(new Error('CDP 在连接建立前已关闭'));
        const onAbort = () => finish(signal.reason);
        const timer = setTimeout(() => finish(new DOMException('CDP 连接超时', 'TimeoutError')), this.timeoutMs);
        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('error', onError, { once: true });
        ws.addEventListener('close', onClose, { once: true });
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    } catch (e) { this.close(); throw e; }
    return this;
  }

  send(method, params = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    signal?.throwIfAborted();
    if (!this.connected) return Promise.reject(new Error('CDP 连接已关闭，请重新连接'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        if (error) reject(error); else resolve(value);
      };
      const onAbort = () => finish(signal.reason);
      const timer = setTimeout(() => {
        finish(new DOMException('CDP 命令超时: ' + method, 'TimeoutError'));
        // 超时后浏览器状态不再可靠，下一个请求必须重新附加。
        this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => finish(null, value), reject: (e) => finish(e) });
      signal?.addEventListener('abort', onAbort, { once: true });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { finish(e); this.close(); }
    });
  }

  async eval(expression, options = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    }, options);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description;
      throw new Error('页面内求值失败: ' + (d || r.exceptionDetails.text));
    }
    return r.result?.value;
  }

  close() {
    this.fail(new Error('CDP 连接已关闭'));
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* ignore */ }
  }
}

export async function listTargets(endpoint, { signal, timeoutMs = 10000 } = {}) {
  const origin = typeof endpoint === 'number' || /^\d+$/.test(String(endpoint)) ? 'http://127.0.0.1:' + endpoint : endpoint;
  const r = await fetch(new URL('/json/list', origin).href, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error('无法访问 CDP 调试端点 ' + origin + '（HTTP ' + r.status + '）');
  return r.json();
}
