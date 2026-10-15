// 发现并启动支持 CDP 的浏览器或 Gemini 桌面客户端。
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { listTargets } from './cdp.mjs';

export const GEMINI_URL = 'https://gemini.google.com/app';
export function isGemini(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'gemini.google.com'; }
  catch { return false; }
}
export function clientConfig(input = {}) {
  const c = { clientMode: 'browser', browser: 'auto', desktopEngine: 'auto', autoLaunch: true, launchTimeoutMs: 20000, ...input };
  if (!['browser', 'app', 'desktop', 'attach'].includes(c.clientMode)) throw new Error('clientMode 应为 browser、app、desktop 或 attach');
  if (!['auto', 'edge', 'chrome', 'brave', 'chromium', 'custom'].includes(c.browser)) throw new Error('browser 应为 auto、edge、chrome、brave、chromium 或 custom');
  if (!['auto', 'electron', 'webview2'].includes(c.desktopEngine)) throw new Error('desktopEngine 应为 auto、electron 或 webview2');
  if (typeof c.autoLaunch !== 'boolean') throw new Error('autoLaunch 必须为布尔值');
  c.cdpPort = Number(c.cdpPort ?? 9222);
  if (!Number.isInteger(c.cdpPort) || c.cdpPort < 1 || c.cdpPort > 65535) throw new Error('cdpPort 必须为有效端口');
  c.launchTimeoutMs = Number(c.launchTimeoutMs);
  if (!Number.isSafeInteger(c.launchTimeoutMs) || c.launchTimeoutMs <= 0) throw new Error('launchTimeoutMs 必须为正整数');
  for (const key of ['browserPath', 'appPath', 'profileDir', 'targetId', 'cdpEndpoint']) {
    if (c[key] !== undefined && typeof c[key] !== 'string') throw new Error(key + ' 必须为字符串');
  }
  for (const key of ['browserArgs', 'appArgs']) {
    if (c[key] !== undefined && (!Array.isArray(c[key]) || !c[key].every((arg) => typeof arg === 'string'))) throw new Error(key + ' 必须为字符串数组');
    if (c[key]?.some((arg) => /^--(?:remote-debugging-(?:port|address|pipe)|user-data-dir|app)(?:=|$)/i.test(arg))) {
      throw new Error(key + ' 不可覆盖调试端口、用户目录或应用模式，请使用相应配置字段');
    }
  }
  const endpoint = new URL(c.cdpEndpoint || 'http://127.0.0.1:' + c.cdpPort);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password) {
    throw new Error('cdpEndpoint 必须为本机回环地址的 HTTP 或 WebSocket 调试端点');
  }
  const direct = endpoint.protocol.startsWith('ws') && !endpoint.pathname.startsWith('/devtools/browser/');
  c.wsEndpoint = direct ? endpoint.href : null;
  c.httpEndpoint = (endpoint.protocol === 'https:' || endpoint.protocol === 'wss:' ? 'https://' : 'http://') + endpoint.host;
  c.connectionKey = (c.wsEndpoint || c.httpEndpoint) + '#' + (c.targetId || '');
  return c;
}

export function browserCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const programs = { edge: 'Microsoft/Edge/Application/msedge.exe', chrome: 'Google/Chrome/Application/chrome.exe', brave: 'BraveSoftware/Brave-Browser/Application/brave.exe', chromium: 'Chromium/Application/chrome.exe' };
    return Object.entries(programs).flatMap(([browser, relative]) => roots.map((root) => ({ browser, executable: path.win32.join(root, relative) })));
  }
  if (platform === 'darwin') return [
    { browser: 'edge', executable: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { browser: 'chrome', executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { browser: 'brave', executable: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
    { browser: 'chromium', executable: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
  ];
  return [['edge', 'microsoft-edge'], ['edge', 'microsoft-edge-stable'], ['chrome', 'google-chrome'], ['brave', 'brave-browser'], ['chromium', 'chromium'], ['chromium', 'chromium-browser']]
    .flatMap(([browser, name]) => (env.PATH || '/usr/bin:/usr/local/bin').split(':').map((dir) => ({ browser, executable: path.posix.join(dir, name) })));
}

export function launchPlan(input, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const c = clientConfig(input);
  if (c.clientMode === 'attach') throw new Error('attach 模式只连接现有调试端点，不会启动应用');
  const u = new URL(c.httpEndpoint);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (u.protocol !== 'http:') throw new Error('自动启动仅支持本机 HTTP 调试端点；HTTPS/WebSocket 端点请使用 attach 模式');
  const debugArgs = ['--remote-debugging-address=' + (u.hostname === '[::1]' ? '::1' : '127.0.0.1'), '--remote-debugging-port=' + port];
  if (c.clientMode === 'desktop') {
    if (!c.appPath || !exists(c.appPath)) throw new Error('请在 config.json 的 appPath 中填写 Gemini 桌面客户端可执行文件的完整路径');
    const flags = c.desktopEngine === 'webview2' ? [] : debugArgs;
    return {
      executable: c.appPath, args: [...flags, ...(c.appArgs || [])], label: 'Gemini 桌面客户端',
      env: { ...env, ...(c.desktopEngine !== 'electron' ? {
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS || '', ...debugArgs].join(' ').trim(),
      } : {}) },
    };
  }
  let selected;
  if (c.browserPath) {
    if (!exists(c.browserPath)) throw new Error('browserPath 文件不存在: ' + c.browserPath);
    selected = { browser: c.browser === 'auto' ? 'custom' : c.browser, executable: c.browserPath };
  } else {
    selected = browserCandidates({ platform, env }).find((candidate) => (c.browser === 'auto' || c.browser === candidate.browser) && exists(candidate.executable));
  }
  if (!selected) throw new Error('未找到可用浏览器。可选择 Edge / Chrome / Brave / Chromium，或在 browserPath 填写完整路径');
  const paths = platform === 'win32' ? path.win32 : path;
  const profile = c.profileDir || paths.join(env.LOCALAPPDATA || homedir(), 'gemini-web-bridge', selected.browser + '-profile');
  return {
    executable: selected.executable,
    args: [...debugArgs, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', ...(c.browserArgs || []),
      c.clientMode === 'app' ? '--app=' + GEMINI_URL : GEMINI_URL],
    env: { ...env }, label: selected.browser + (c.clientMode === 'app' ? ' Gemini 应用窗口' : ' 浏览器'), profile,
  };
}

export async function launchClient(input, { signal } = {}) {
  signal?.throwIfAborted();
  const plan = launchPlan(input);
  const child = spawn(plan.executable, plan.args, { env: plan.env, detached: true, stdio: 'ignore', windowsHide: true, shell: false });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return { pid: child.pid, label: plan.label, profile: plan.profile };
}

export function selectTarget(targets, input) {
  const c = clientConfig(input);
  const candidates = targets.filter((t) => ['page', 'webview', 'iframe'].includes(t.type) && isGemini(t.url) && t.webSocketDebuggerUrl);
  if (c.targetId) return candidates.find((t) => t.id === c.targetId);
  return candidates.find((t) => t.type === 'page') || candidates[0];
}

export async function debugTargets(input, { signal } = {}) {
  const c = clientConfig(input);
  if (c.wsEndpoint) return { config: c, targets: [], launched: false };
  let targets;
  try { targets = await listTargets(c.httpEndpoint, { signal }); }
  catch (e) {
    signal?.throwIfAborted();
    if (!c.autoLaunch || c.clientMode === 'attach') throw new Error('无法连接调试端点 ' + c.httpEndpoint + '。请运行 start-gemini.bat，或启用 autoLaunch。(' + e.message + ')');
    const launched = await launchClient(c, { signal });
    const deadline = Date.now() + c.launchTimeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      try { targets = await listTargets(c.httpEndpoint, { signal, timeoutMs: 1500 }); break; }
      catch { signal?.throwIfAborted(); }
      await sleep(250, undefined, { signal });
    }
    if (!Array.isArray(targets)) throw new Error(launched.label + ' 已尝试启动，但调试端点 ' + c.httpEndpoint + ' 未就绪或未返回页面列表。请检查应用是否允许 CDP、端口是否被占用，以及启动参数是否被应用忽略');
    return { config: c, targets, launched: true, ...launched };
  }
  if (!Array.isArray(targets)) throw new Error('调试端点返回的不是页面列表，请检查 cdpEndpoint');
  return { config: c, targets, launched: false };
}

export async function geminiTarget(input, { signal } = {}) {
  const result = await debugTargets(input, { signal });
  const c = result.config;
  if (c.wsEndpoint) return { ...result, target: { webSocketDebuggerUrl: c.wsEndpoint } };
  let target = selectTarget(result.targets, c);
  if (!target && !c.targetId && ['browser', 'app'].includes(c.clientMode)) {
    const r = await fetch(c.httpEndpoint + '/json/new?' + encodeURIComponent(GEMINI_URL), { method: 'PUT', signal });
    if (!r.ok) throw new Error('无法新建 Gemini 页面（HTTP ' + r.status + '），请在该调试浏览器或应用中手动打开 ' + GEMINI_URL);
    target = await r.json();
  }
  // 桌面应用可能先启动外壳，再创建 WebView，不应直接导航或替换外壳。
  if (!target && c.clientMode === 'desktop' && !c.targetId) {
    const deadline = Date.now() + c.launchTimeoutMs;
    while (!target && Date.now() < deadline) {
      await sleep(250, undefined, { signal });
      target = selectTarget(await listTargets(c.httpEndpoint, { signal }), c);
    }
  }
  if (!target?.webSocketDebuggerUrl) throw new Error(
    c.targetId ? '未找到指定的 Gemini targetId: ' + c.targetId :
      '调试端点可连接，但没有 Gemini 网页渲染目标。请在应用内打开 Gemini；独立客户端需要暴露 Gemini 页面或 WebView 的 CDP，纯原生界面不能直接连接',
  );
  return { ...result, target };
}
