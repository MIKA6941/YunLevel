// 简易 LCS 行 diff，用法：node linediff.js <old> <new> [context]
const fs = require('fs');
const [oldF, newF, ctxArg] = process.argv.slice(2);
const ctx = Number(ctxArg || 2);
const norm = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').split('\n');
const a = norm(oldF), b = norm(newF);
const n = a.length, m = b.length;
const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
for (let i = n - 1; i >= 0; i--) {
  for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
}
const ops = [];
let i = 0, j = 0;
while (i < n && j < m) {
  if (a[i] === b[j]) { ops.push([' ', a[i], i + 1, j + 1]); i++; j++; }
  else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i], i + 1, '']); i++; }
  else { ops.push(['+', b[j], '', j + 1]); j++; }
}
while (i < n) { ops.push(['-', a[i], i + 1, '']); i++; }
while (j < m) { ops.push(['+', b[j], '', j + 1]); j++; }
const keep = new Array(ops.length).fill(false);
ops.forEach((op, k) => { if (op[0] !== ' ') { for (let t = Math.max(0, k - ctx); t <= Math.min(ops.length - 1, k + ctx); t++) keep[t] = true; } });
let out = [];
ops.forEach((op, k) => {
  if (!keep[k]) return;
  out.push(`${op[0]}${op[0] === ' ' ? '' : (op[2] ? `old:${op[2]}` : `new:${op[3]}`)}  ${op[1]}`);
});
console.log(out.join('\n'));
console.log(`\n# total -${ops.filter(o => o[0] === '-').length} +${ops.filter(o => o[0] === '+').length}`);
