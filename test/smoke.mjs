// 桥接服务自测：验证 OpenAI 兼容接口的契约（不碰浏览器，用 echo 后端）。
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
let fails = 0;

function ok(cond, label, extra) {
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + label + (extra !== undefined && !cond ? '  -> ' + JSON.stringify(extra) : ''));
  if (!cond) fails++;
}

console.log('== 1. GET /health ==');
const health = await (await fetch(BASE + '/health')).json();
console.log('  ', JSON.stringify(health));
ok(health.ok === true, 'health.ok === true');

console.log('== 2. GET /v1/models ==');
const models = await (await fetch(BASE + '/v1/models')).json();
ok(models.object === 'list' && Array.isArray(models.data) && models.data.length > 0, 'models 列表非空', models);

const stPayload = {
  model: 'gemini-web',
  messages: [
    { role: 'system', content: '你是一个中世纪酒馆的老板娘，说话豪爽。' },
    { role: 'user', content: '来一杯麦酒。' },
    { role: 'assistant', content: '好嘞，马上来！' },
    { role: 'user', content: '今天有什么新鲜事？' },
  ],
  temperature: 0.9,
  stream: false,
};

console.log('== 3. POST /v1/chat/completions (非流式) ==');
const r3 = await fetch(BASE + '/v1/chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stPayload),
});
const j3 = await r3.json();
ok(r3.status === 200, 'HTTP 200', r3.status);
ok(typeof j3.id === 'string' && j3.id.startsWith('chatcmpl-'), 'id 形如 chatcmpl-*', j3.id);
ok(j3.object === 'chat.completion', 'object === chat.completion', j3.object);
ok(Array.isArray(j3.choices) && j3.choices.length === 1, 'choices 长度为 1', j3.choices);
ok(j3.choices[0].message.role === 'assistant', 'role === assistant', j3.choices[0].message.role);
ok(typeof j3.choices[0].message.content === 'string' && j3.choices[0].message.content.length > 0, 'content 非空');
ok(j3.choices[0].finish_reason === 'stop', 'finish_reason === stop', j3.choices[0].finish_reason);
ok(j3.usage && typeof j3.usage.total_tokens === 'number', 'usage.total_tokens 是数字', j3.usage);
console.log('  回复片段:', JSON.stringify(j3.choices[0].message.content.slice(0, 90)));

console.log('== 4. POST /v1/chat/completions (流式 SSE) ==');
const r4 = await fetch(BASE + '/v1/chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...stPayload, stream: true }),
});
ok((r4.headers.get('content-type') || '').includes('text/event-stream'), 'Content-Type 是 SSE', r4.headers.get('content-type'));
const raw = await r4.text();
const lines = raw.split('\n').filter((l) => l.startsWith('data: '));
const frames = lines.map((l) => l.slice(6)).filter((s) => s !== '[DONE]').map((s) => JSON.parse(s));
ok(lines[lines.length - 1] === 'data: [DONE]', '以 data: [DONE] 结尾');
ok(frames.every((f) => f.object === 'chat.completion.chunk'), '所有帧 object === chat.completion.chunk');
ok(frames.some((f) => f.choices[0].finish_reason === 'stop'), '存在 finish_reason === stop 的收尾帧');
const assembled = frames.map((f) => (f.choices[0].delta && f.choices[0].delta.content) || '').join('');
ok(assembled.length > 0, '拼接后的内容非空');
ok(assembled === j3.choices[0].message.content, '流式拼接结果与非流式内容一致');
console.log('  流式帧数:', frames.length, '| 拼接长度:', assembled.length);

console.log('== 5. 上下文渲染检查 ==');
// echo 后端会把收到的提示词回显出来，正好用来断言渲染结果。
const echoOut = j3.choices[0].message.content;
ok(echoOut.includes('老板娘'), 'system 消息被折进提示词开头');
ok(echoOut.includes('--- 对话记录 ---'), '对话记录有分隔标记');
ok(echoOut.includes('用户: 来一杯麦酒。'), '用户消息带说话人标签');
ok(echoOut.includes('角色: 好嘞，马上来！'), 'assistant 消息用角色名标签');
ok(echoOut.includes('今天有什么新鲜事？'), '最后一条用户消息在上下文里');
const r5 = await fetch(BASE + '/v1/chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: '只问这一句' }], stream: false }),
});
const j5 = await r5.json();
ok(j5.choices[0].message.content.includes('只问这一句'), '提示词被完整传给后端');

console.log('== 6. 错误处理 ==');
const r6 = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
ok(r6.status === 400, '非法 JSON 返回 400', r6.status);
const r7 = await fetch(BASE + '/nope');
ok(r7.status === 404, '未知路径返回 404', r7.status);
const r8 = await fetch(BASE + '/v1/chat/completions', { method: 'OPTIONS' });
ok(r8.status === 204, 'CORS 预检返回 204', r8.status);
ok(r8.headers.get('access-control-allow-origin') === '*', 'CORS 头存在');

console.log('\n' + (fails === 0 ? '全部通过 ✅' : '失败 ' + fails + ' 项 ❌'));
process.exit(fails === 0 ? 0 : 1);
