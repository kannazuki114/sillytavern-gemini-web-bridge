// 通过 CDP 使用浏览器、网页应用或桌面客户端中的 Gemini 页面。
import { CDP } from '../lib/cdp.mjs';
import { clientConfig, geminiTarget, isGemini, GEMINI_URL } from '../lib/client.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const state = { cdp: null, connectionKey: null, cfg: {} };
export function configure(c) {
  const cfg = clientConfig(c);
  for (const [key, fallback] of [['maxWaitMs', 180000], ['settleMs', 1200]]) {
    cfg[key] = Number(cfg[key] ?? fallback);
    if (!Number.isSafeInteger(cfg[key]) || cfg[key] <= 0) throw new Error(key + ' 必须为正整数');
  }
  state.cfg = cfg;
}

const SEL = {
  editor: [
    'rich-textarea .ql-editor[contenteditable="true"]', 'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]', 'div.ql-editor[contenteditable="true"]', 'textarea[aria-label]',
  ],
  stop: [
    'button[aria-label*="Stop"]', 'button[aria-label*="停止"]',
    'button[data-test-id="stop-button"]', 'stop-button', '.stop-button',
  ],
  send: [
    'button.send-button', 'button[aria-label*="Send message"]', 'button[aria-label*="发送消息"]',
    'button[aria-label*="Send"]', 'button[aria-label*="发送"]', 'button[data-test-id="send-button"]',
  ],
  response: ['model-response', '.model-response-text', 'message-content'],
  newChat: [
    '[data-test-id="new-chat-button"]', '[data-test-id="new-conversation-button"]',
    'a[href="/app"]', 'button[aria-label*="New chat"]', 'a[aria-label*="New chat"]',
    'button[aria-label*="新对话"]', 'a[aria-label*="新对话"]',
  ],
  loginWall: ['form[action*=signin]', 'a[href*="accounts.google.com/ServiceLogin"]'],
};
const J = JSON.stringify;
const HELPERS =
  'function __visible(e){return !!(e&&e.getClientRects().length&&getComputedStyle(e).visibility!=="hidden");}' +
  'function __first(sels){for(var i=0;i<sels.length;i++){var n=document.querySelectorAll(sels[i]);' +
  'for(var j=0;j<n.length;j++){if(__visible(n[j]))return n[j];}}return null;}' +
  'function __responses(sels){for(var i=0;i<sels.length;i++){var n=Array.from(document.querySelectorAll(sels[i])).filter(__visible);if(n.length)return n;}return [];}';
const iife = (body) => '(function(){' + HELPERS + body + '})()';

export const __pageScripts = {
  status: iife(
    'var editor=__first(' + J(SEL.editor) + ');var stop=__first(' + J(SEL.stop) + ');' +
    'var responses=__responses(' + J(SEL.response) + ');var last=responses[responses.length-1];' +
    'var ids=window.__geminiBridgeResponseIds||(window.__geminiBridgeResponseIds={nodes:new WeakMap(),next:0});' +
    'if(last&&!ids.nodes.has(last))ids.nodes.set(last,++ids.next);' +
    'var content=last&&(last.querySelector(".markdown")||last);' +
    'return{hasEditor:!!editor,generating:!!stop,text:content?(content.innerText||"").trim():"",' +
    'url:location.href,title:document.title,readyState:document.readyState,documentId:performance.timeOrigin,' +
    'responseCount:responses.length,responseId:last?ids.nodes.get(last):null,' +
    'loginWall:!editor&&!!__first(' + J(SEL.loginWall) + ')};'
  ),
  focusSelect: iife(
    'var el=__first(' + J(SEL.editor) + ');if(!el)return false;el.focus();' +
    'if(el.tagName==="TEXTAREA"){el.select();return true;}' +
    'var sel=window.getSelection();sel.removeAllRanges();var r=document.createRange();' +
    'r.selectNodeContents(el);sel.addRange(r);return true;'
  ),
  clickSend: iife(
    'var b=__first(' + J(SEL.send) + ');' +
    'if(b&&!b.disabled&&b.getAttribute("aria-disabled")!=="true"){b.click();return true;}return false;'
  ),
  stopGeneration: iife('var b=__first(' + J(SEL.stop) + ');if(b){b.click();return true;}return false;'),
  newChat: iife('var b=__first(' + J(SEL.newChat) + ');if(b&&!b.disabled){b.click();return true;}return false;'),
  isGenerating: iife('return !!__first(' + J(SEL.stop) + ');'),
  waitIdle: iife('return !__first(' + J(SEL.stop) + ');'),
};

async function attach(input, signal) {
  const c = clientConfig(input);
  signal.throwIfAborted();
  if (state.cdp?.connected && state.connectionKey === c.connectionKey) return state.cdp;
  await close();
  const { target: page } = await geminiTarget(c, { signal });
  const cdp = new CDP(page.webSocketDebuggerUrl);
  try {
    await cdp.connect({ signal });
    await cdp.send('Page.enable', {}, { signal });
    await cdp.send('Runtime.enable', {}, { signal });
  } catch (e) { cdp.close(); throw e; }
  state.cdp = cdp;
  cdp.targetType = page.type;
  state.connectionKey = c.connectionKey;
  return cdp;
}

const navigating = (e) => /Execution context was destroyed|Cannot find context|Cannot find default execution context|Inspected target navigated/i.test(e.message);
async function waitFor(cdp, src, signal, label, predicate = Boolean) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const v = await cdp.eval(src, { signal });
      if (predicate(v)) return v;
    } catch (e) { if (!navigating(e)) throw e; }
    await sleep(250, undefined, { signal });
  }
  throw new DOMException('等待超时: ' + label, 'TimeoutError');
}
function ready(st) {
  if (st?.loginWall) throw new Error('看起来没有登录 Google 账号。请在当前调试浏览器或 Gemini 应用中登录后重试。');
  return !!(st?.hasEditor && st.readyState !== 'loading' && isGemini(st.url));
}
async function gotoGemini(cdp, signal, config) {
  let before;
  try { before = await cdp.eval(__pageScripts.status, { signal }); }
  catch (e) { if (!navigating(e)) throw e; }
  if (['desktop', 'attach'].includes(config.clientMode) || config.wsEndpoint || cdp.targetType === 'iframe') {
    // 应用外壳可能承载导航与登录，使用页面中的新对话按钮，不导航外壳。
    if (ready(before) && before.responseCount === 0) return;
    if (!await cdp.eval(__pageScripts.newChat, { signal })) {
      throw new Error('应用内没有找到新对话按钮，请手动打开 Gemini 新对话后重试，或检查 newChat 选择器');
    }
    await waitFor(cdp, __pageScripts.status, signal, '应用内新对话', (st) => ready(st) && st.responseCount === 0);
    return;
  }
  const nav = await cdp.send('Page.navigate', { url: GEMINI_URL }, { signal });
  if (nav.errorText) throw new Error('无法打开 Gemini: ' + nav.errorText);
  await waitFor(cdp, __pageScripts.status, signal, 'Gemini 新会话出现输入框', (st) => {
    // Page.navigate 的旧文档可能短暂仍可求值，不能在旧页面中输入。
    if (nav.loaderId && before?.documentId === st?.documentId) return false;
    if (!ready(st)) return false;
    return /^\/app\/?$/.test(new URL(st.url).pathname) && st.responseCount === 0;
  });
}
async function clearEditor(cdp, signal) {
  if (!await cdp.eval(__pageScripts.focusSelect, { signal })) throw new Error('Gemini 页面没有找到输入框');
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }, { signal });
  }
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, { signal });
  }
  await sleep(120, undefined, { signal });
}
async function stopAndWait(cdp) {
  if (!cdp.connected) return;
  // 原请求信号已中止，清理必须使用独立且有上限的信号。
  const signal = AbortSignal.timeout(3000);
  try {
    await cdp.eval(__pageScripts.stopGeneration, { signal });
    await waitFor(cdp, __pageScripts.waitIdle, signal, '停止生成');
  } catch {
    cdp.close();
    if (state.cdp === cdp) state.cdp = null;
  }
}

export async function ask({ prompt, onDelta, signal: externalSignal }) {
  const c = state.cfg;
  const maxWaitMs = c.maxWaitMs ?? 180000;
  const settleMs = c.settleMs ?? 1200;
  const timeout = AbortSignal.timeout(maxWaitMs);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
  let cdp;
  let submitted = false;
  try {
    cdp = await attach(c, signal);
    if (cdp.targetType !== 'iframe') await cdp.send('Page.bringToFront', {}, { signal });
    await waitFor(cdp, __pageScripts.status, signal, 'Gemini 页面出现输入框', ready);
    if (c.newChatEachRequest !== false) await gotoGemini(cdp, signal, c);
    await waitFor(cdp, __pageScripts.status, signal, 'Gemini 页面出现输入框', ready);
    await waitFor(cdp, __pageScripts.waitIdle, signal, '上一次生成结束');
    await clearEditor(cdp, signal);
    await cdp.send('Input.insertText', { text: prompt }, { signal });
    await sleep(200, undefined, { signal });

    const baseline = await cdp.eval(__pageScripts.status, { signal });
    submitted = true;
    if (!await cdp.eval(__pageScripts.clickSend, { signal })) {
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, { signal });
      }
    }

    let text = '';
    let newResponse = false;
    let lastChange = Date.now();
    while (true) {
      await sleep(300, undefined, { signal });
      const cur = await cdp.eval(__pageScripts.status, { signal });
      if (!cur) continue;
      if (cur.documentId !== baseline.documentId) throw new Error('生成过程中页面已导航，请重试');
      if (cur.loginWall) throw new Error('Gemini 登录状态已失效，请重新登录');
      // 不以“看见旧文本”或“按钮正在生成”代替新回答的证据。
      if ((cur.responseId != null && cur.responseId !== baseline.responseId) ||
          cur.responseCount > baseline.responseCount || (cur.text && cur.text !== baseline.text)) newResponse = true;
      if (!newResponse) continue;
      const next = cur.text || '';
      if (next !== text) { text = next; lastChange = Date.now(); }
      if (text && !cur.generating && Date.now() - lastChange >= settleMs) {
        signal.throwIfAborted();
        // 网页可改写整段文本；标准 SSE 只能追加，因此稳定后一次发送正文。
        if (onDelta) onDelta(text);
        return text;
      }
    }
  } catch (e) {
    if (cdp && submitted) await stopAndWait(cdp);
    if (!cdp?.connected && state.cdp === cdp) state.cdp = null;
    if (externalSignal?.aborted) throw externalSignal.reason;
    if (timeout.aborted) throw new DOMException('等待 Gemini 回答超时（' + maxWaitMs + 'ms），未将不完整回答作为成功结果返回', 'TimeoutError');
    throw e;
  }
}

export async function close() {
  state.cdp?.close();
  state.cdp = null;
  state.connectionKey = null;
}
