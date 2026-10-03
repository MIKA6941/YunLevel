// 静态检查：app.js 里引用的 DOM id 是否都存在于 index.html
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map(m => m[1]));
const used = new Map();
const re = /(?:\$|document\.getElementById)\(\s*['"]([A-Za-z0-9_\-:]+)['"]\s*\)/g;
let m;
while ((m = re.exec(js))) {
  if (!used.has(m[1])) used.set(m[1], []);
  used.get(m[1]).push(js.slice(0, m.index).split('\n').length);
}
const missing = [...used.keys()].filter(id => !htmlIds.has(id)).sort();
console.log('index.html ids:', htmlIds.size, '| app.js 引用 id:', used.size);
console.log('缺失 id 数:', missing.length);
for (const id of missing) {
  const lines = used.get(id);
  console.log(`  MISSING #${id}  (app.js 行 ${lines.slice(0, 6).join(',')}${lines.length > 6 ? ' …' : ''})`);
}
// 反向：html 里有但 js 从不引用（只提示动态查询）
const unused = [...htmlIds].filter(id => !used.has(id)).sort();
console.log('\nhtml 有但 js 未按字面引用（可能动态/仅样式）:', unused.length);
console.log(unused.join(', '));
