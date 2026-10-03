#!/usr/bin/env node
'use strict';
/*
 * scripts/data-audit.js —— L4 数据体检
 *
 * 用法：
 *   node scripts/data-audit.js                # 扫 data/
 *   YUN_AUDIT_DIR=<dir> node scripts/data-audit.js
 *   node scripts/data-audit.js --json         # 机器可读
 *
 * 判据见 docs/可长期测试的稳定方案.md §5.2（D-01~D-18 硬性异常）
 * 退出码：0 = 无硬性异常；1 = 有硬性异常；2 = 参数/目录错误
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dirArgIdx = args.indexOf('--dir');
const DATA_DIR = path.resolve(
  process.env.YUN_AUDIT_DIR || (dirArgIdx >= 0 ? args[dirArgIdx + 1] : '') || path.join(ROOT, 'data')
);

const TANK_MAGIC = 0x594c5631; // 'YLV1'
const HX_MAGIC = 0x594c4858; // 'YLHX'
const TANK_CHANNELS = 16;
const HX_CHANNELS = 17;
const HX_ONLY = ['ti1104', 'ti1103', 'fi1105', 'spf', 'qhx', 'twall', 'twater'];
const TANK_ONLY = ['h1', 'h2', 'h3', 'sp1', 'sp2', 'sp3', 'qin', 'q12', 'q23', 'qout'];

const hard = [];
const soft = [];
const stats = {};

function bad(id, title, where, detail) { hard.push({ id, title, where, detail }); }
function obs(id, title, where, detail) { soft.push({ id, title, where, detail }); }
function note(k, v) { stats[k] = v; }

function walk(dir, out = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function readJsonlSafe(p) {
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return { rows: [], err: e.message }; }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows = []; const badLines = [];
  lines.forEach((l, i) => { try { rows.push(JSON.parse(l)); } catch (e) { badLines.push(i + 1); } });
  return { rows, badLines, tailComplete: text.length === 0 || text.endsWith('\n') };
}

function scanValues(where, channels) {
  for (const [key, arr] of Object.entries(channels)) {
    if (!Array.isArray(arr)) { bad('D-01', 'NaN / Infinity', where, `通道 ${key} 不是数组`); continue; }
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v === null) { bad('D-02', 'null 冒充数值', where, `通道 ${key}[${i}] = null`); break; }
      if (typeof v === 'number' && !Number.isFinite(v)) { bad('D-01', 'NaN / Infinity', where, `通道 ${key}[${i}] = ${v}`); break; }
    }
  }
}

function scanHistory(file, kind) {
  const j = readJsonSafe(file);
  if (!j) { bad('D-13', '文件截断 / 解析失败', file, 'JSON 解析失败'); return null; }
  const ch = j.history && typeof j.history === 'object' ? j.history : j;
  const keys = Object.keys(ch);
  const expect = kind === 'tank' ? TANK_CHANNELS : HX_CHANNELS;
  if (keys.length !== expect) bad('D-07', '通道数不对', file, `${keys.length} 个通道，应为 ${expect}`);
  const widths = keys.map((k) => (Array.isArray(ch[k]) ? ch[k].length : -1));
  if (new Set(widths).size !== 1) bad('D-08', '通道长度不齐', file, JSON.stringify(keys.map((k, i) => k + '=' + widths[i])));
  scanValues(file, ch);
  // D-09 / D-10 时间单调
  const t = ch.t || [];
  for (let i = 1; i < t.length; i++) {
    if (Number(t[i]) < Number(t[i - 1])) { bad('D-10', '时间戳倒退', file, `t[${i - 1}]=${t[i - 1]} > t[${i}]=${t[i]}`); break; }
  }
  let dup = 0;
  for (let i = 1; i < t.length; i++) if (Number(t[i]) === Number(t[i - 1])) dup++;
  if (t.length > 5 && dup / t.length > 0.5) obs('D-09', '时间大量重复', file, `${dup}/${t.length} 个重复点`);
  // 物理量程
  const range = kind === 'tank'
    ? { '0..100': ['h1', 'h2', 'h3', 'sp1', 'sp2', 'sp3'], '开度 0..100': ['pump', 'fv101', 'fv102', 'fv103', 'fv104'], '非负': ['qin', 'q12', 'q23', 'qout'] }
    : { '温度 0..1000': ['ti1104', 'ti1103', 'twall', 'twater', 'sp'], '非负': ['qin', 'fi1105', 'spf', 'fuel', 'mw', 'level', 'relieve', 'qhx'], '开度 0..100': ['fv1102', 'fv1105', 'fv1101', 'hv1102'] };
  for (const [label, ks] of Object.entries(range)) {
    for (const k of ks) {
      const arr = ch[k]; if (!Array.isArray(arr)) continue;
      for (const v of arr) {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        if (label === '0..100' || label === '开度 0..100') {
          if (n < -0.001 || n > 100.001) { bad('D-03', '液位越界 0..100', file, `${k}=${n}`); return j; }
        } else if (label === '温度 0..1000') {
          if (n < -0.001 || n > 1000) { bad('D-04', '温度越界', file, `${k}=${n}`); return j; }
        } else if (n < -0.001) { bad('D-05', '流量负值', file, `${k}=${n}`); return j; }
      }
    }
  }
  // 统计观察
  if (kind === 'tank') {
    for (const k of ['h1', 'h2', 'h3']) {
      const a = ch[k] || []; if (a.length < 60) continue;
      const uniq = new Set(a.map((x) => Number(x).toFixed(6))).size;
      if (uniq <= 2) obs('S-01', '曲线长时间完全不动', file, `${k} 只有 ${uniq} 个不同取值 / ${a.length} 点`);
    }
    const a = ch.fv101 || []; if (a.length > 60) {
      const sat = a.filter((x) => Number(x) <= 0.01 || Number(x) >= 99.99).length / a.length;
      if (sat > 0.9) obs('S-02', '输出长期贴 0%/100%', file, `fv101 ${(sat * 100).toFixed(0)}% 采样在饱和区`);
    }
  }
  if (t.length >= 1800) obs('S-07', '曲线顶到 1800 上限', file, `t 数组长度 ${t.length}`);
  return j;
}

function scanStateBin(file, kind) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return; }
  if (buf.length < 4) { bad('D-13', '文件截断', file, `长度 ${buf.length}`); return; }
  const magic = buf.readUInt32LE(0);
  const expect = kind === 'tank' ? TANK_MAGIC : HX_MAGIC;
  if (magic !== expect) {
    bad('D-11', '魔数错位', file, `0x${magic.toString(16).toUpperCase()} 应为 0x${expect.toString(16).toUpperCase()}`);
  }
  if (buf.length < 64) bad('D-13', '文件截断', file, `长度 ${buf.length} 疑似不足`);
}

function scanCrossModel(historyDir, stateDir, magic) {
  for (const f of walk(historyDir)) {
    if (!f.endsWith('.json')) continue;
    const txt = fs.readFileSync(f, 'utf8');
    if (HX_ONLY.some((k) => txt.includes('"' + k + '"')) && TANK_ONLY.some((k) => txt.includes('"' + k + '"'))) {
      bad('D-12', '跨模型目录混放', f, '同时出现 hx 与 tank 字段名');
    }
  }
  for (const f of walk(stateDir)) {
    let buf; try { buf = fs.readFileSync(f); } catch (e) { continue; }
    if (buf.length < 4) continue;
    if (buf.readUInt32LE(0) !== magic) bad('D-11', '魔数错位', f, `0x${buf.readUInt32LE(0).toString(16).toUpperCase()} 不是 0x${magic.toString(16).toUpperCase()}`);
  }
}

function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error('数据目录不存在：' + DATA_DIR);
    process.exit(2);
  }
  console.log('扫描目录：' + DATA_DIR);

  // classes.json —— D-16 孤儿文件的依据
  // 状态/历史文件名是 sha256(sessionKey) 前 24 位，sessionKey = classId::studentId[::modelId]，
  // 与 server/engine-session.js:35 一致，所以孤儿判定要按同样的算法重算哈希。
  const hashId = (v) => crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 24);
  const classesFile = path.join(DATA_DIR, 'classes.json');
  const classes = readJsonSafe(classesFile);
  const rosterIds = new Set();
  const expectedHashes = new Set();
  if (classes && Array.isArray(classes.classes)) {
    for (const c of classes.classes) {
      for (const s of (c.students || [])) {
        rosterIds.add(String(s.studentId));
        expectedHashes.add(hashId(`${c.id}::${s.studentId}`));
        expectedHashes.add(hashId(`${c.id}::${s.studentId}::hx`));
      }
    }
    // 教师演示会话（server/server.js: TEACHER_CLASS_ID='__teacher__', TEACHER_STUDENT_ID='teacher'）
    expectedHashes.add(hashId('__teacher__::teacher'));
    expectedHashes.add(hashId('__teacher__::teacher::hx'));
    note('班级数', classes.classes.length);
    note('名单人数', rosterIds.size);
  } else if (fs.existsSync(classesFile)) {
    bad('D-13', '文件截断 / 解析失败', classesFile, 'classes.json 解析失败');
  }

  // 状态 / 历史
  const stateDir = path.join(DATA_DIR, 'state');
  const hxStateDir = path.join(DATA_DIR, 'hx-state');
  const histDir = path.join(DATA_DIR, 'history');
  const hxHistDir = path.join(DATA_DIR, 'hx-history');
  const stateFiles = fs.existsSync(stateDir) ? walk(stateDir).filter((f) => f.endsWith('.bin')) : [];
  const hxStateFiles = fs.existsSync(hxStateDir) ? walk(hxStateDir).filter((f) => f.endsWith('.bin')) : [];
  const histFiles = fs.existsSync(histDir) ? walk(histDir).filter((f) => f.endsWith('.json')) : [];
  const hxHistFiles = fs.existsSync(hxHistDir) ? walk(hxHistDir).filter((f) => f.endsWith('.json')) : [];
  note('tank state 文件', stateFiles.length);
  note('hx state 文件', hxStateFiles.length);
  note('tank history 文件', histFiles.length);
  note('hx history 文件', hxHistFiles.length);

  for (const f of stateFiles) scanStateBin(f, 'tank');
  for (const f of hxStateFiles) scanStateBin(f, 'hx');
  if (fs.existsSync(histDir)) scanCrossModel(histDir, stateDir, TANK_MAGIC);
  if (fs.existsSync(hxHistDir)) scanCrossModel(hxHistDir, hxStateDir, HX_MAGIC);

  for (const f of histFiles) scanHistory(f, 'tank');
  for (const f of hxHistFiles) scanHistory(f, 'hx');

  // D-05 单学生文件异常偏大 / S-05
  const allHist = [...histFiles, ...hxHistFiles].map((f) => ({ f, size: fs.statSync(f).size }));
  if (allHist.length >= 3) {
    const sizes = allHist.map((x) => x.size).sort((a, b) => a - b);
    const med = sizes[Math.floor(sizes.length / 2)];
    for (const x of allHist) if (med > 0 && x.size > med * 10) obs('S-05', '单学生文件异常偏大', x.f, `${x.size} 字节，中位数 ${med}`);
  }

  // D-16 孤儿文件（按 sessionKey 哈希反查名单）
  for (const f of [...stateFiles, ...hxStateFiles]) {
    const id = path.basename(f).replace(/\.bin$/, '');
    if (expectedHashes.size && !expectedHashes.has(id)) {
      bad('D-16', '孤儿文件（已删学生残留）', f, 'classes.json 里没有对应学生会话（hash ' + id + '）');
    }
  }

  // D-17 tank / hx 数据互相污染
  if (stateFiles.length && hxStateFiles.length) {
    const same = stateFiles.some((a) => {
      const ab = fs.readFileSync(a);
      return hxStateFiles.some((b) => Buffer.compare(ab, fs.readFileSync(b)) === 0);
    });
    if (same) bad('D-17', 'tank 与 hx 数据互相污染', DATA_DIR, '存在逐字节相同的状态文件');
  }

  // 评分记录 D-14 / D-15
  const recFile = path.join(DATA_DIR, 'score_records.jsonl');
  if (fs.existsSync(recFile)) {
    const { rows, badLines, tailComplete } = readJsonlSafe(recFile);
    note('评分记录条数', rows.length);
    if (badLines.length) bad('D-13', '文件截断', recFile, `第 ${badLines.join(',')} 行不是完整 JSON`);
    if (!tailComplete) obs('D-14', '评分记录末行不完整', recFile, '文件未以换行结尾');
    const need = ['endedAt', 'mode', 'tank', 'total', 'operation', 'control', 'safety', 'benefit'];
    for (const r of rows) {
      const sc = r.score || r;
      const miss = need.filter((k) => !(k in sc) && !(k in r));
      if (miss.length) { bad('D-14', '评分记录字段缺失', recFile, JSON.stringify(miss).slice(0, 160)); break; }
      const total = Number(sc.total);
      if (!Number.isFinite(total) || total < 0 || total > 100) { bad('D-15', '分数越界', recFile, 'total=' + sc.total); break; }
      const sum = ['operation', 'control', 'safety', 'benefit'].reduce((a, k) => a + (Number(sc[k]) || 0), 0);
      if (Math.abs(sum - total) > 1.5) { bad('D-15', '分项之和不等于总分', recFile, `分项和=${sum.toFixed(2)} 总分=${total}`); break; }
    }
    if (rows.length === 0) obs('S-04', '评分记录长期为空', recFile, '0 条');
  } else {
    obs('S-04', '评分记录缺失', recFile, 'score_records.jsonl 不存在');
  }

  // D-18 会话数超限：静态数据目录看不出来，标注为不适用
  obs('D-18', '会话数超限（YUN_MAX_SESSIONS）', DATA_DIR, '需在线服务才能验证，本脚本不适用');

  // 输出
  const report = { dir: DATA_DIR, stats, hard, soft };
  if (asJson) { console.log(JSON.stringify(report, null, 2)); }
  else {
    console.log('\n---- 统计 ----');
    for (const [k, v] of Object.entries(stats)) console.log('  ' + k + ': ' + v);
    console.log('\n---- 硬性异常 D-01~D-18：' + hard.length + ' 条 ----');
    for (const h of hard) console.log('  [' + h.id + '] ' + h.title + '\n        ' + h.where + '\n        ' + h.detail);
    console.log('\n---- 统计性观察 S-01~S-08：' + soft.length + ' 条 ----');
    for (const s of soft) console.log('  [' + s.id + '] ' + s.title + '\n        ' + s.where + '\n        ' + s.detail);
  }
  process.exit(hard.length ? 1 : 0);
}
main();
