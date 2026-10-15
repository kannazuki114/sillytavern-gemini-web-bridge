#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/service.mjs';
import { CDP } from '../lib/cdp.mjs';
import { clientConfig, debugTargets, geminiTarget, selectTarget } from '../lib/client.mjs';
import { __pageScripts } from '../backends/gemini-cdp.mjs';

const argv = process.argv.slice(2);
function value(name) {
  const eq = argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : undefined;
}
if (argv.includes('--help')) {
  console.log('用法: node tools/start-client.mjs [--mode browser|app|desktop|attach] [--browser auto|edge|chrome|brave|chromium|custom] [--path 可执行文件] [--endpoint 调试地址] [--port 9222] [--save] [--check]');
} else {
  let cdp;
  try {
    const configPath = process.env.GEMINI_BRIDGE_CONFIG || fileURLToPath(new URL('../config.json', import.meta.url));
    const config = loadConfig(configPath);
    const overrides = {};
    for (const [flag, key] of [['mode', 'clientMode'], ['browser', 'browser'], ['endpoint', 'cdpEndpoint']]) {
      if (value(flag) !== undefined) overrides[key] = value(flag);
    }
    if (value('port') !== undefined) { overrides.cdpPort = Number(value('port')); overrides.cdpEndpoint = ''; }
    if (value('path') !== undefined) overrides[(overrides.clientMode || config.clientMode) === 'desktop' ? 'appPath' : 'browserPath'] = value('path');
    Object.assign(config, overrides);
    const normalized = clientConfig(config);
    if (argv.includes('--save') && !argv.includes('--check')) {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
      console.log('[gemini] 已保存配置。若酒馆已启动，请重启酒馆以使用新设置。');
    }
    const check = argv.includes('--check');
    const signal = AbortSignal.timeout(normalized.launchTimeoutMs + 12000);
    const result = check ? await debugTargets({ ...config, autoLaunch: false }, { signal }) : await geminiTarget(config, { signal });
    const target = result.target || (normalized.wsEndpoint ? { webSocketDebuggerUrl: normalized.wsEndpoint } : selectTarget(result.targets, normalized));
    console.log('[gemini] 连接模式: ' + normalized.clientMode + ' | 调试端点: ' + (normalized.wsEndpoint || normalized.httpEndpoint));
    console.log('[gemini] ' + (result.launched ? '已启动 ' + result.label : '已连接现有调试会话'));
    if (result.profile) console.log('[gemini] 会话目录: ' + result.profile);
    if (!target) throw new Error('没有找到 Gemini 页面。请在该调试浏览器或应用内打开 https://gemini.google.com/app');
    cdp = await new CDP(target.webSocketDebuggerUrl).connect({ signal });
    await cdp.send('Runtime.enable', {}, { signal });
    const st = await cdp.eval(__pageScripts.status, { signal });
    console.log('[gemini] 页面: ' + (st?.title || target.title || '') + ' ' + (st?.url || target.url || ''));
    console.log('[gemini] ' + (st?.hasEditor ? '输入框可用，可以在酒馆发起请求。' : '输入框暂未出现：首次使用请在窗口内登录，或等待页面加载；若出现网络错误，请检查浏览器网络/代理。'));
    if (check && !st?.hasEditor) process.exitCode = 1;
  } catch (e) {
    console.error('[gemini] ' + e.message);
    process.exitCode = 1;
  } finally { cdp?.close(); }
}
