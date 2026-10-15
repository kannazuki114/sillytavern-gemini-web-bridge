// 诊断脚本：连接当前配置的浏览器或桌面应用，输出 Gemini 选择器命中情况。
// 用法: node tools/inspect-gemini.mjs
import { CDP } from '../lib/cdp.mjs';
import { loadConfig } from '../lib/service.mjs';
import { clientConfig, debugTargets, selectTarget } from '../lib/client.mjs';

const cfg = loadConfig();
if (process.env.CDP_PORT) { cfg.cdpPort = Number(process.env.CDP_PORT); cfg.cdpEndpoint = ''; }
const c = clientConfig({ ...cfg, autoLaunch: false });
const signal = AbortSignal.timeout(15000);
const { targets } = await debugTargets(c, { signal });
const pages = targets.filter((t) => ['page', 'webview', 'iframe'].includes(t.type));
console.log('== 页面列表 ==');
for (const p of pages) console.log(' -', p.id, '|', p.title, '|', p.url);

const page = c.wsEndpoint ? { webSocketDebuggerUrl: c.wsEndpoint } : selectTarget(targets, c);
if (!page) { console.error('没有找到 Gemini 页面或 WebView；请运行 node tools/start-client.mjs --check 查看连接状态'); process.exit(1); }

const cdp = await new CDP(page.webSocketDebuggerUrl).connect({ signal });
try {
await cdp.send('Runtime.enable', {}, { signal });

const report = await cdp.eval('(function(){' +
  'var sels=[' +
  "'rich-textarea .ql-editor[contenteditable=\"true\"]'," +
  "'rich-textarea div[contenteditable=\"true\"]'," +
  "'div[contenteditable=\"true\"][role=\"textbox\"]'," +
  "'button.send-button'," +
  "'button[aria-label*=\"Send\"]'," +
  "'model-response'," +
  "'message-content'," +
  "'stop-button'," +
  "'.markdown'" +
  '];' +
  'var out={url:location.href,title:document.title,hits:{}};' +
  'for(var i=0;i<sels.length;i++){out.hits[sels[i]]=document.querySelectorAll(sels[i]).length;}' +
  'var rs=document.querySelectorAll("model-response");' +
  'out.lastResponseText=rs.length?(rs[rs.length-1].innerText||"").slice(0,400):null;' +
  'return out;})()', { signal });

console.log('\n== 选择器命中 ==');
for (const [k, v] of Object.entries(report.hits || {})) console.log(' ' + (v ? 'OK ' : '-- ') + v + '  ' + k);
console.log('\nURL:', report.url);
console.log('标题:', report.title);
console.log('\n最后一条回答（截断）:\n' + (report.lastResponseText || '(无)'));
} finally { cdp.close(); }
