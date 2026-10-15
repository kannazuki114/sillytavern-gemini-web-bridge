import { renderMessages, roughTokens } from './render.mjs';

// 同一套请求处理和队列同时供酒馆插件与独立诊断入口使用。
export function createBridge({ config, backend, backendName, log = console.log }) {
  const MODEL_ID = config.modelId || 'gemini-web';
  const startedAt = Date.now();
  let closing = false;
  class RequestError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
  }
  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  function json(res, code, obj) {
    if (res.destroyed || res.writableEnded) return;
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    cors(res);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
    res.end(body);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 10 * 1024 * 1024) {
          chunks.length = 0;
          reject(new RequestError('请求体超过 10 MiB 上限', 413));
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('aborted', () => reject(new RequestError('请求已断开')));
      req.on('error', reject);
    });
  }
  async function parseBody(req) {
    let body;
    if (req.body !== undefined) {
      // Express 的 JSON 中间件已经消费请求流，不能再次等待 end 事件。
      body = req.body;
    } else {
      const raw = req.readableEnded ? '' : await readBody(req);
      try { body = JSON.parse(raw); } catch { throw new RequestError('请求体不是合法 JSON'); }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('请求体必须为 JSON 对象');
    if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new RequestError('stream 必须为布尔值');
    return body;
  }
  function validateMessages(messages) {
    if (!Array.isArray(messages) || !messages.length) throw new RequestError('messages 必须为非空数组');
    const roles = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);
    for (const m of messages) {
      if (!m || !roles.has(m.role)) throw new RequestError('messages 中的每项必须包含有效 role');
      if (m.name !== undefined && typeof m.name !== 'string') throw new RequestError('消息 name 必须为字符串');
      const c = m.content;
      if (typeof c === 'string' || c === null) continue;
      if (Array.isArray(c) && c.every((p) => typeof p === 'string' ||
          (p && (p.type === undefined || p.type === 'text') && typeof p.text === 'string'))) continue;
      throw new RequestError('当前桥接仅支持字符串或文本分块形式的消息 content');
    }
  }

  // 取消的排队任务在执行前跳过；活动任务完成清理后才释放队列。
  let chain = Promise.resolve();
  function enqueue(fn, signal) {
    const run = chain.then(() => { signal.throwIfAborted(); return fn(); });
    chain = run.catch(() => {});
    return run;
  }
  const active = new Set();
  function requestLifetime(req, res) {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException('客户端已断开', 'AbortError'));
    const onClose = () => { if (!res.writableEnded) abort(); };
    req.on('aborted', abort);
    res.on('close', onClose);
    res.on('error', abort);
    active.add(controller);
    if (req.aborted || res.destroyed) abort();
    return {
      signal: controller.signal,
      dispose() {
        req.off('aborted', abort);
        res.off('close', onClose);
        res.off('error', abort);
        active.delete(controller);
      },
    };
  }
  function upstreamError(e) {
    return { error: { message: '后端失败: ' + e.message, type: 'upstream_error',
      ...(e.name === 'TimeoutError' ? { code: 'upstream_timeout' } : {}) } };
  }

  async function handleCompletion(req, res, chat) {
    const lifetime = requestLifetime(req, res);
    const { signal } = lifetime;
    let heartbeat;
    try {
      const body = await parseBody(req);
      let prompt;
      if (chat) {
        validateMessages(body.messages);
        prompt = renderMessages(body.messages, {
          nameForAssistant: config.nameForAssistant || '角色', contextMode: config.contextMode || 'full',
        });
      } else {
        if (typeof body.prompt !== 'string') throw new RequestError('prompt 必须为字符串');
        prompt = body.prompt;
      }
      if (!prompt.trim()) throw new RequestError('提示词不能为空');
      signal.throwIfAborted();
      const stream = body.stream === true;
      const id = (chat ? 'chatcmpl-' : 'cmpl-') + Math.random().toString(36).slice(2, 12);
      const created = Math.floor(Date.now() / 1000);
      const started = Date.now();
      log('收到请求 promptChars=' + prompt.length + ' stream=' + stream + (config.debug ? '\n' + prompt : ''));
      const args = { prompt, messages: body.messages, req: body, signal };

      if (!stream) {
        try {
          const text = await enqueue(() => backend.ask({ ...args, onDelta: null }), signal);
          signal.throwIfAborted();
          json(res, 200, {
            id, object: chat ? 'chat.completion' : 'text_completion', created, model: MODEL_ID,
            choices: [{ index: 0, ...(chat ? { message: { role: 'assistant', content: text } } : { text }), finish_reason: 'stop' }],
            usage: { prompt_tokens: roughTokens(prompt), completion_tokens: roughTokens(text), total_tokens: roughTokens(prompt) + roughTokens(text) },
          });
          log('完成（非流式） ' + (Date.now() - started) + 'ms, ' + text.length + ' 字符');
        } catch (e) {
          if (!signal.aborted) { log('后端出错:', e.message); json(res, 502, upstreamError(e)); }
        }
        return;
      }

      cors(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      const send = (obj) => {
        if (!signal.aborted && !res.destroyed) res.write('data: ' + JSON.stringify(obj) + '\n\n');
      };
      const chunk = (text, finish = null, role = false) => ({
        id, object: chat ? 'chat.completion.chunk' : 'text_completion', created, model: MODEL_ID,
        choices: [{ index: 0, ...(chat ? { delta: { ...(role ? { role: 'assistant' } : {}), ...(text ? { content: text } : {}) } } : { text }), finish_reason: finish }],
      });
      send(chunk('', null, true));
      heartbeat = setInterval(() => {
        if (!signal.aborted && !res.destroyed) res.write(': keep-alive\n\n');
      }, 15000);
      heartbeat.unref();
      try {
        await enqueue(() => backend.ask({ ...args, onDelta: (piece) => { if (piece) send(chunk(piece)); } }), signal);
        signal.throwIfAborted();
        send(chunk('', 'stop'));
        log('完成（流式） ' + (Date.now() - started) + 'ms');
      } catch (e) {
        if (!signal.aborted) { log('流式后端出错:', e.message); send(upstreamError(e)); }
      }
      if (!signal.aborted && !res.destroyed) res.end('data: [DONE]\n\n');
    } finally { clearInterval(heartbeat); lifetime.dispose(); }
  }

  async function handle(req, res) {
    try {
      if (closing) throw new RequestError('插件正在关闭', 503);
      // 路由不依赖客户端提供的 Host，解析异常也必须留在请求的异常处理内。
      let p;
      try { p = new URL(req.url, 'http://localhost').pathname; }
      catch { throw new RequestError('请求 URL 无效'); }
      if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
      const health = p === '/health' || p === '/';
      const models = p === '/v1/models' || p === '/models';
      const chat = p === '/v1/chat/completions' || p === '/chat/completions';
      const completion = p === '/v1/completions' || p === '/completions';
      if (!health && !models && !chat && !completion) throw new RequestError('未知路径 ' + p, 404);
      const method = health || models ? 'GET' : 'POST';
      if (req.method !== method) { res.setHeader('Allow', method); throw new RequestError('此路径仅支持 ' + method, 405); }
      if (health) return json(res, 200, {
        ok: true, backend: backendName, model: MODEL_ID, contextMode: config.contextMode || 'full', uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      });
      if (models) return json(res, 200, {
        object: 'list', data: [{ id: MODEL_ID, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'gemini-web-bridge' }],
      });
      await handleCompletion(req, res, chat);
    } catch (e) {
      if (res.destroyed) return;
      if (!(e instanceof RequestError)) log('未捕获错误:', e.stack || e);
      if (!res.headersSent) json(res, e.status || 500, { error: {
        message: e.message, type: e instanceof RequestError ? 'invalid_request_error' : 'internal_error',
      } });
      else res.end();
    }
  }
  async function close() {
    closing = true;
    for (const controller of active) controller.abort(new DOMException('插件正在关闭', 'AbortError'));
    await chain;
    if (typeof backend.close === 'function') await backend.close();
  }
  return { handle, close };
}
