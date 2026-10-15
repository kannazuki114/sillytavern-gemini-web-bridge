import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBridge } from './bridge.mjs';

export function loadConfig(configPath = process.env.GEMINI_BRIDGE_CONFIG || fileURLToPath(new URL('../config.json', import.meta.url))) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('插件配置必须为 JSON 对象');
  return { port: 8788, host: '127.0.0.1', backend: 'gemini-cdp', modelId: 'gemini-web', ...config };
}

export async function startService(config, { log = (...a) => console.log('[gemini-web-bridge]', ...a) } = {}) {
  const port = Number(config.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port 必须为 0 到 65535 的整数');
  // 插件共享一个 Google 会话，本地接口始终只供同机酒馆访问。
  if (config.host !== '127.0.0.1' && config.host !== '::1') throw new Error('host 只支持本机回环地址 127.0.0.1 或 ::1');
  const backendName = config.backend || 'gemini-cdp';
  const mod = await import('../backends/' + backendName + '.mjs');
  const backend = mod.default || mod;
  if (typeof backend.ask !== 'function') throw new Error('后端 ' + backendName + ' 没有导出 ask()');
  if (typeof backend.configure === 'function') backend.configure(config);
  const bridge = createBridge({ config, backend, backendName, log });
  const server = http.createServer(bridge.handle);
  try {
    await new Promise((resolve, reject) => {
      const onError = (e) => reject(e);
      server.once('error', onError);
      server.listen(port, config.host, () => { server.off('error', onError); resolve(); });
    });
  } catch (e) {
    await bridge.close();
    if (e.code === 'EADDRINUSE') throw new Error('本机端口 ' + port + ' 已占用，请关闭旧桥接进程或修改插件 config.json 的 port');
    throw e;
  }
  const host = config.host === '::1' ? '[::1]' : config.host;
  const origin = 'http://' + host + ':' + server.address().port;
  const apiBaseUrl = origin + '/v1';
  log('监听 ' + origin);
  log('后端: ' + backendName + ' | 模型 ID: ' + (config.modelId || 'gemini-web'));
  log('酒馆里填: 自定义地址 = ' + apiBaseUrl);
  let closing;
  return {
    apiBaseUrl,
    backendName,
    modelId: config.modelId || 'gemini-web',
    close() {
      if (!closing) closing = (async () => {
        const closed = new Promise((resolve) => server.close(resolve));
        try { await bridge.close(); }
        finally { server.closeAllConnections(); await closed; }
      })();
      return closing;
    },
  };
}
