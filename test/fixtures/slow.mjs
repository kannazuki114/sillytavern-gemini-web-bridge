// 仅供 HTTP 队列、取消和错误契约的集成测试使用。
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const record = (id, event) => appendFileSync(process.env.BRIDGE_TEST_LOG, JSON.stringify({ id, event }) + '\n');
export async function ask({ req, onDelta, signal }) {
  const id = req.testId;
  signal.throwIfAborted();
  record(id, 'started');
  try {
    await sleep(req.delayMs ?? 100, undefined, { signal });
    if (req.fail) throw new DOMException('fixture timeout', 'TimeoutError');
    const text = 'fixture:' + id;
    if (onDelta) onDelta(text);
    record(id, 'completed');
    return text;
  } catch (e) {
    record(id, signal.aborted ? 'aborted' : 'failed');
    // 模拟浏览器停止生成的异步清理，队列必须等清理结束后再运行下一项。
    await sleep(30);
    record(id, 'cleaned');
    throw e;
  }
}
