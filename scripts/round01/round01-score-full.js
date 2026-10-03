'use strict';
/*
 * G-09：评分全程真跑（不用 TICK 加速）
 *   阶段 1 单对象 480 s → 到点自动结束 + 记录追加 + 结束后封存
 *   阶段 2 系统 1500 s → 同上
 * 数据目录保留，供 L4 数据体检。
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8102, BASE = 'http://127.0.0.1:' + PORT;
const TEST_ROOT = path.join(ROOT, '.test-data-round01');
const DATA = path.join(TEST_ROOT, 'score');
const OUT = path.join(TEST_ROOT, 'score.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let log = '';
function say(s) { const line = '[' + new Date().toISOString() + '] ' + s; log += line + '\n'; fs.appendFileSync(OUT, line + '\n'); console.log(line); }

async function api(p, o = {}) {
  const h = {}; if (o.cookie) h.cookie = o.cookie; let b;
  if (o.body !== undefined) { h['content-type'] = 'application/json'; b = JSON.stringify(o.body); }
  const r = await fetch(BASE + p, { method: o.method || 'GET', headers: h, body: b });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { }
  let c = ''; if (typeof r.headers.getSetCookie === 'function') { const l = r.headers.getSetCookie(); if (l.length) c = l.map((x) => x.split(';')[0]).join('; '); }
  return { status: r.status, text: t, json: j, cookie: c };
}
const cmd = (ck, t) => api('/api/command', { method: 'POST', cookie: ck, body: { cmd: t } });
const st = (r) => (r && r.json && r.json.state ? r.json.state : null);

async function waitHealth(ms) { const e = Date.now() + ms; while (Date.now() < e) { try { const h = await api('/api/health'); if (h.status === 200 && h.json.ok) return h.json; } catch (x) { } await sleep(200); } throw new Error('not healthy'); }

async function runStage(label, limitS, modeCmd, sc) {
  say('--- ' + label + ' 开始（限时 ' + limitS + ' s）---');
  let r = await cmd(sc, 'RESET');
  say('RESET -> ' + r.status);
  r = await cmd(sc, modeCmd);
  say(modeCmd + ' -> ' + r.status + ' ' + r.text.slice(0, 120));
  r = await cmd(sc, 'SCORE_TANK 1');
  say('SCORE_TANK 1 -> ' + r.status);
  r = await cmd(sc, 'HIGH_SCORE');
  say('HIGH_SCORE -> ' + r.status + ' ' + r.text.slice(0, 120));
  const cold = st(r) || {};
  say('冷态 loops=' + cold.nLoop + ' sp=' + JSON.stringify([cold.sp1, cold.sp2, cold.sp3]));
  r = await cmd(sc, 'SCORE_START');
  say('SCORE_START -> ' + r.status + ' ' + r.text.slice(0, 160));
  if (r.status !== 200) return { ok: false, why: 'SCORE_START ' + r.status + ' ' + r.text.slice(0, 160) };
  // 设计如此：开始评分会清空回路卡与泵阀，必须重新套模板，否则全程空转（第一轮踩过这个坑）。
  r = await cmd(sc, 'HIGH_SCORE');
  say('SCORE_START 后重新 HIGH_SCORE -> ' + r.status + ' loops=' + (st(r) || {}).nLoop);
  r = await cmd(sc, 'START');
  say('START -> ' + r.status);
  const t0 = Date.now();
  let last = -1, sawNaN = false, outOfRange = [], histMax = 0;
  let finished = false, finState = null, endEventCount = 0;
  while (Date.now() - t0 < (limitS + 240) * 1000) {
    await sleep(2000);
    const s = st(await api('/api/state', { cookie: sc }));
    if (!s) continue;
    const sc2 = s.score || {};
    const sess = Math.round(Number(sc2.sessionT));
    if (sess !== last && sess % 30 === 0) {
      say('  t=' + sess + 's runT=' + Math.round(Number(sc2.runT)) + ' total=' + Number(sc2.total).toFixed(1)
        + ' op=' + Number(sc2.operation).toFixed(1) + ' ctrl=' + Number(sc2.control).toFixed(1)
        + ' safe=' + Number(sc2.safety).toFixed(1) + ' ben=' + Number(sc2.benefit).toFixed(1)
        + ' h=' + [s.h1, s.h2, s.h3].map((x) => Number(x).toFixed(1)).join('/'));
      last = sess;
    }
    for (const k of ['h1', 'h2', 'h3']) {
      const v = Number(s[k]);
      if (!Number.isFinite(v)) sawNaN = true;
      else if (v < 0 || v > 100) outOfRange.push(k + '=' + v);
    }
    for (const k of ['fv101', 'fv102', 'fv103', 'fv104']) {
      const v = Number(s[k]);
      if (!Number.isFinite(v)) sawNaN = true; else if (v < 0 || v > 100) outOfRange.push(k + '=' + v);
    }
    if (s.scoreEnded) endEventCount++;
    if (sc2.finished && !finished) {
      finished = true; finState = s;
      say('  ★ 评分到点自动结束：sessionT=' + sess + ' runT=' + Math.round(Number(sc2.runT)) + ' total=' + Number(sc2.total).toFixed(2));
      break;
    }
  }
  const wall = Math.round((Date.now() - t0) / 1000);
  const rec = (await api('/api/score-record', { cookie: sc })).json;
  say('到点后 /api/score-record：' + JSON.stringify(rec).slice(0, 500));
  const runAtEnd = finState ? Number((finState.score || {}).runT) : -1;
  // 结束后继续跑 25 s，验证分数封存
  await sleep(25000);
  const after = st(await api('/api/state', { cookie: sc })) || {};
  const runAfter = Number((after.score || {}).runT);
  const totalAfter = Number((after.score || {}).total);
  say('结束后 25 s：runT ' + runAtEnd.toFixed(1) + ' -> ' + runAfter.toFixed(1) + '，total ' + (finState ? Number((finState.score || {}).total).toFixed(2) : '?') + ' -> ' + totalAfter.toFixed(2));
  const h = (await api('/api/history', { cookie: sc })).json.history || {};
  histMax = h.t ? h.t.length : 0;
  const widths = [...new Set(Object.keys(h).map((k) => h[k].length))];
  say('历史：通道数=' + Object.keys(h).length + ' 长度集合=' + JSON.stringify(widths) + ' 末点t=' + (h.t && h.t[h.t.length - 1]));
  const bad = [];
  for (const [k, arr] of Object.entries(h)) for (const v of arr) if (v === null || (typeof v === 'number' && !Number.isFinite(v))) bad.push(k);
  return {
    ok: finished, wall, sessionT: finState ? Math.round(Number((finState.score || {}).sessionT)) : -1,
    total: totalAfter, sealed: Math.abs(runAfter - runAtEnd) < 1e-6,
    runAtEnd, runAfter, record: rec, sawNaN, outOfRange, histChannels: Object.keys(h).length, widths,
    badChannels: [...new Set(bad)], endEventCount,
  };
}

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(OUT, '');
  say('port=' + PORT + ' data=' + DATA);
  const ch = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), YUN_DATA_DIR: DATA, YUN_TEACHER_CODE: 'TEST_TEACHER_CODE', YUN_CLASS_CODE: 'SC26', YUN_MAX_SESSIONS: '12' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ch.stdout.on('data', (d) => say('[srv] ' + String(d).trim()));
  ch.stderr.on('data', (d) => say('[srv!] ' + String(d).trim().split('\n')[0]));
  try {
    await waitHealth(30000);
    const tc = (await api('/api/login', { method: 'POST', body: { role: 'teacher', teacherCode: 'TEST_TEACHER_CODE' } })).cookie;
    const cl = await api('/api/teacher/classes', { cookie: tc });
    const cid = cl.json.classes.find((c) => c.code === 'SC26').id;
    await api('/api/teacher/classes/' + cid + '/students', { method: 'POST', cookie: tc, body: { studentId: 'SC001', name: 'ScoreStu' } });
    const sc = (await api('/api/login', { method: 'POST', body: { role: 'student', classCode: 'SC26', studentId: 'SC001', name: 'ScoreStu' } })).cookie;
    say('教师/学生就绪 classId=' + cid);

    const p1 = await runStage('阶段1 单对象', 480, 'SCORE_MODE 1', sc);
    say('阶段1 结果: ' + JSON.stringify(p1));
    say('教师评分记录条数: ' + JSON.stringify((await api('/api/teacher/records', { cookie: tc })).json).slice(0, 600));
    const csv = await api('/api/teacher/export.csv?classId=' + cid + '&model=all', { cookie: tc });
    fs.writeFileSync(path.join(TEST_ROOT, 'score-records.csv'), csv.text || '');
    say('评分 CSV 已存（' + (csv.text || '').length + ' 字节）');

    const p2 = await runStage('阶段2 系统', 1500, 'SCORE_MODE 2', sc);
    say('阶段2 结果: ' + JSON.stringify(p2));
    say('最终评分记录: ' + JSON.stringify((await api('/api/teacher/records', { cookie: tc })).json).slice(0, 900));
    const csv2 = await api('/api/teacher/export.csv?classId=' + cid + '&model=all', { cookie: tc });
    fs.writeFileSync(path.join(TEST_ROOT, 'score-records2.csv'), csv2.text || '');
    say('DONE');
  } catch (e) {
    say('FATAL ' + e.stack);
  } finally {
    ch.kill(); await sleep(500);
    try { process.kill(ch.pid, 'SIGKILL'); } catch (e) { }
    say('server stopped');
  }
  process.exit(0);
})();
