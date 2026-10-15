// SillyTavern 服务端插件入口；不创建进程，不注册进程级信号处理器。
import { loadConfig, startService } from './lib/service.mjs';

export const info = {
  id: 'gemini-web-bridge',
  name: 'Gemini Web Bridge',
  description: '通过浏览器或支持 CDP 的 Gemini 桌面客户端提供 OpenAI 兼容接口。',
};

let service = null;
export async function init(router) {
  if (service) throw new Error('Gemini Web Bridge 插件已经加载');
  if (!router || typeof router.get !== 'function') throw new Error('需要 SillyTavern 提供的 Express router');
  const config = loadConfig();
  const running = await startService(config);
  try {
    router.get('/status', (_req, res) => res.json({
      ok: service !== null,
      apiBaseUrl: running.apiBaseUrl,
      model: running.modelId,
      backend: running.backendName,
      cdpPort: config.cdpPort || 9222,
      clientMode: config.clientMode || 'browser',
      browser: config.browser || 'auto',
      cdpEndpoint: config.cdpEndpoint || 'http://127.0.0.1:' + (config.cdpPort || 9222),
    }));
    service = running;
  } catch (e) { await running.close(); throw e; }
}

export async function exit() {
  const running = service;
  service = null;
  if (running) await running.close();
}
