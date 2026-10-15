
import { __pageScripts } from '../backends/gemini-cdp.mjs';
let bad = 0;
for (const [name, code] of Object.entries(__pageScripts)) {
  try { new Function(code); console.log('  [PASS] ' + name + ' 是可求值的合法 JS (' + code.length + ' 字符)'); }
  catch (e) { console.log('  [FAIL] ' + name + ' -> ' + e.message); bad++; }
}
console.log(bad ? '页面脚本校验失败 ' + bad + ' 项' : '页面脚本全部合法 ✅');
process.exit(bad ? 1 : 0);
