#!/usr/bin/env node
// 可选的独立诊断入口；酒馆插件由 index.mjs 加载，无需运行本文件。
import { loadConfig, startService } from './lib/service.mjs';

const argv = process.argv.slice(2);
function argVal(name) {
  const i = argv.indexOf('--' + name);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--' + name + '='));
  return eq ? eq.slice(name.length + 3) : undefined;
}
const config = loadConfig();
config.port = Number(argVal('port') ?? process.env.BRIDGE_PORT ?? config.port);
config.host = process.env.BRIDGE_HOST || config.host;
config.backend = argVal('backend') || process.env.BRIDGE_BACKEND || config.backend;
if (argv.includes('--debug')) config.debug = true;
const service = await startService(config);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const timer = setTimeout(() => process.exit(1), 5000);
  timer.unref();
  try { await service.close(); clearTimeout(timer); process.exit(0); }
  catch (e) { console.error(e); process.exit(1); }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
