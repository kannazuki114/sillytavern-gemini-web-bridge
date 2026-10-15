// 假后端：不碰浏览器，用来验证酒馆 <-> 桥接服务的管线是否通。

export const meta = { name: 'echo', description: '回显后端，仅用于管线自测' };

import { setTimeout as sleep } from 'node:timers/promises';

export async function ask({ prompt, onDelta, signal }) {
  signal?.throwIfAborted();
  const reply =
    '[echo] 桥接服务已收到请求。\n' +
    '收到的提示词长度：' + prompt.length + ' 字符\n' +
    '前 200 字符预览：\n' + prompt.slice(0, 200);

  if (onDelta) {
    for (const piece of reply.match(/[\s\S]{1,16}/g) || []) {
      signal?.throwIfAborted();
      onDelta(piece);
      await sleep(8, undefined, { signal });
    }
  }
  return reply;
}

export async function close() {}
