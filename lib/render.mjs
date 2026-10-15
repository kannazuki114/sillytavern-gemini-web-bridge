// 把 OpenAI 风格的 messages 渲染成 Gemini 网页版能吃的单条提示词。

export function contentToText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === 'string' ? p : (typeof p?.text === 'string' ? p.text : ''))).join('');
  }
  return '';
}

/**
 * @param {Array<{role?:string,name?:string,content?:unknown}>} messages
 * @param {{nameForAssistant?:string, contextMode?:'full'|'lastUser'}} opts
 */
export function renderMessages(messages, opts = {}) {
  const nameForAssistant = opts.nameForAssistant || '角色';
  const contextMode = opts.contextMode || 'full';

  if (contextMode === 'lastUser') {
    for (let i = (messages || []).length - 1; i >= 0; i--) {
      if (messages[i]?.role !== 'user') continue;
      const text = contentToText(messages[i].content).trim();
      if (text) return text;
    }
    return '';
  }

  const sys = [];
  const turns = [];

  for (const m of messages || []) {
    const text = contentToText(m && m.content).trim();
    if (!text) continue;
    const role = m && m.role;
    if (role === 'system' || role === 'developer') {
      sys.push(text);
      continue;
    }
    const who = (m && m.name) || (role === 'user' ? '用户' : nameForAssistant);
    turns.push(who + ': ' + text);
  }

  if (!sys.length && !turns.length) return '';

  const head = sys.length ? sys.join('\n\n') + '\n\n' : '';
  return (
    head +
    '--- 对话记录 ---\n' +
    turns.join('\n\n') +
    '\n--- 对话记录结束 ---\n\n' +
    '现在请你以「' + nameForAssistant + '」的身份，直接续写下一段回复。' +
    '只输出回复正文，不要重复上面的对话记录，不要加任何解释或前缀。'
  );
}

/** 粗略估算 token，仅供 usage 字段展示。 */
export function roughTokens(s) {
  if (!s) return 0;
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return Math.max(1, Math.ceil(cjk + (s.length - cjk) / 4));
}
