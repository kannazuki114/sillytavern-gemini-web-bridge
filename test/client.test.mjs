import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { clientConfig, launchPlan, selectTarget, debugTargets, geminiTarget } from '../lib/client.mjs';

const env = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' };
const windows = (exists = () => true) => ({ platform: 'win32', env, exists });
test('自动选 Edge，无 Edge 时可选 Chrome；支持自定义浏览器路径', () => {
  const auto = launchPlan({}, windows());
  assert.match(auto.executable, /msedge\.exe$/);
  assert.ok(auto.args.includes('--remote-debugging-port=9222'));
  assert.ok(auto.args.some((a) => a.startsWith('--user-data-dir=')));
  const chrome = launchPlan({}, windows((file) => file.includes('Google')));
  assert.match(chrome.executable, /Google.*chrome\.exe$/);
  const custom = launchPlan({ browserPath: 'D:\\Apps\\browser.exe' }, windows());
  assert.equal(custom.executable, 'D:\\Apps\\browser.exe');
  assert.throws(() => launchPlan({}, windows(() => false)), /未找到可用浏览器/);
  assert.throws(() => launchPlan({ browserPath: 'missing.exe' }, windows(() => false)), /文件不存在/);
});

test('Gemini 应用窗口使用 app 模式，不与普通标签页启动参数混淆', () => {
  const plan = launchPlan({ clientMode: 'app', browser: 'edge', cdpPort: 9333 }, windows());
  assert.ok(plan.args.includes('--app=https://gemini.google.com/app'));
  assert.ok(plan.args.includes('--remote-debugging-port=9333'));
  assert.ok(!plan.args.includes('https://gemini.google.com/app'));
});

test('Electron 与 WebView2 桌面客户端的启动参数和环境变量', () => {
  const electron = launchPlan({ clientMode: 'desktop', desktopEngine: 'electron', appPath: 'D:\\Gemini.exe', appArgs: ['--safe-test'] }, windows());
  assert.equal(electron.executable, 'D:\\Gemini.exe');
  assert.ok(electron.args.includes('--remote-debugging-port=9222'));
  assert.ok(electron.args.includes('--safe-test'));
  assert.ok(!electron.args.some((a) => a.startsWith('--user-data-dir=')));
  assert.ok(!electron.args.some((a) => a.includes('https://gemini')));
  const webview = launchPlan({ clientMode: 'desktop', desktopEngine: 'webview2', appPath: 'D:\\Gemini.exe' }, windows());
  assert.deepEqual(webview.args, []);
  assert.match(webview.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, /--remote-debugging-port=9222/);
  assert.equal(env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, undefined);
  assert.throws(() => launchPlan({ clientMode: 'desktop' }, windows()), /appPath/);
});

test('HTTP/浏览器 WebSocket/页面 WebSocket 端点规范化与配置校验', () => {
  assert.equal(clientConfig({ cdpEndpoint: 'http://localhost:9333' }).httpEndpoint, 'http://localhost:9333');
  assert.equal(clientConfig({ cdpEndpoint: 'ws://127.0.0.1:9333/devtools/browser/abc' }).wsEndpoint, null);
  assert.equal(clientConfig({ cdpEndpoint: 'ws://127.0.0.1:9333/devtools/page/abc' }).wsEndpoint, 'ws://127.0.0.1:9333/devtools/page/abc');
  for (const endpoint of ['http://example.com:9222', 'file:///app', 'http://user:secret@localhost:9222']) {
    assert.throws(() => clientConfig({ cdpEndpoint: endpoint }), /cdpEndpoint/);
  }
  assert.throws(() => clientConfig({ clientMode: 'native-mobile' }), /clientMode/);
  assert.throws(() => clientConfig({ browserArgs: ['--remote-debugging-port=9999'] }), /不可覆盖/);
});

test('识别浏览器、应用 WebView 与内嵌 Gemini，不选择无关应用外壳', () => {
  const shell = { id: 'shell', type: 'page', url: 'file:///Gemini/index.html', webSocketDebuggerUrl: 'ws://fixture/shell' };
  const webview = { id: 'view', type: 'webview', url: 'https://gemini.google.com/app', webSocketDebuggerUrl: 'ws://fixture/view' };
  assert.equal(selectTarget([shell, webview], { clientMode: 'desktop' }), webview);
  assert.equal(selectTarget([{ ...webview, type: 'iframe' }], {}).id, 'view');
  assert.equal(selectTarget([{ ...webview, url: 'https://gemini.google.com.example.org/app' }], {}), undefined);
  assert.equal(selectTarget([webview], { targetId: 'other' }), undefined);
});

test('页面 WebSocket 直接接入，无需 Chrome 或 HTTP 页面发现', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('不应请求 HTTP 页面列表'));
  const result = await geminiTarget({ cdpEndpoint: 'ws://127.0.0.1:9333/devtools/page/app', clientMode: 'attach' });
  assert.equal(result.target.webSocketDebuggerUrl, 'ws://127.0.0.1:9333/devtools/page/app');
});

test('实际 HTTP 发现：桌面应用只接入 WebView，浏览器允许创建页面，attach 不自动打开', async (t) => {
  let targets = [];
  let created = 0;
  const view = { id: 'view', type: 'webview', url: 'https://gemini.google.com/app', webSocketDebuggerUrl: 'ws://fixture/view' };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/json/list') return res.end(JSON.stringify(targets));
    assert.equal(req.method, 'PUT');
    assert.equal(decodeURIComponent(req.url), '/json/new?https://gemini.google.com/app');
    created++;
    res.end(JSON.stringify({ ...view, type: 'page' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = { cdpEndpoint: 'http://127.0.0.1:' + server.address().port, autoLaunch: false };
  assert.equal((await geminiTarget(base)).target.type, 'page');
  assert.equal(created, 1);
  await assert.rejects(geminiTarget({ ...base, clientMode: 'attach' }), /没有 Gemini 网页渲染目标/);
  targets = [view];
  assert.equal((await geminiTarget({ ...base, clientMode: 'desktop' })).target.type, 'webview');
  assert.equal(created, 1);
  assert.equal((await debugTargets(base)).launched, false);
});
