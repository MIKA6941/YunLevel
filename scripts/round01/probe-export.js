'use strict';
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8100, BASE = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, o = {}) {
  const h = {}; if (o.cookie) h.cookie = o.cookie; let b;
  if (o.body !== undefined) { h['content-type'] = 'application/json'; b = JSON.stringify(o.body); }
  const r = await fetch(BASE + p, { method: o.method || 'GET', headers: h, body: b });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { }
  let c = ''; if (typeof r.headers.getSetCookie === 'function') { const l = r.headers.getSetCookie(); if (l.length) c = l.map((x) => x.split(';')[0]).join('; '); }
  return { status: r.status, text: t, json: j, cookie: c, headers: r.headers };
}
(async () => {
  const TEST_ROOT = path.join(ROOT, '.test-data-round01');
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'probe-export-'));
  const ch = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), YUN_DATA_DIR: dir, YUN_TEACHER_CODE: 'TEST_TEACHER_CODE', YUN_CLASS_CODE: 'EX26', YUN_MAX_SESSIONS: '8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ch.stdout.on('data', d => process.stdout.write('[srv] ' + d)); ch.stderr.on('data', d => process.stdout.write('[srv] ' + d));
  try {
    for (let i = 0; i < 100; i++) { try { const h = await api('/api/health'); if (h.json && h.json.ok) break; } catch (e) { } await sleep(200); }
    const tc = (await api('/api/login', { method: 'POST', body: { role: 'teacher', teacherCode: 'TEST_TEACHER_CODE' } })).cookie;
    await api('/api/teacher/settings', { method: 'POST', cookie: tc, body: { openModels: { hx: true } } });
    const hc = (await api('/api/login', { method: 'POST', body: { role: 'teacher', teacherCode: 'TEST_TEACHER_CODE', model: 'hx' } })).cookie;
    await api('/api/command', { method: 'POST', cookie: hc, body: { cmd: 'LOOP_ADD 0 0' } });
    const sv = await api('/api/current/save', { method: 'POST', cookie: hc, body: {} });
    console.log('save status', sv.status);
    const ex = await api('/api/current/export', { method: 'GET', cookie: hc });
    console.log('export status', ex.status, 'ctype', ex.headers.get('content-type'), 'len', ex.text.length);
    const j = ex.json;
    if (j) {
      console.log('top keys:', Object.keys(j));
      console.log(JSON.stringify(j, null, 1).slice(0, 2500));
    } else {
      console.log(ex.text.slice(0, 800));
    }
    // 冷态上传云端
    const sub = await api('/api/student/submit', { method: 'POST', cookie: hc, body: { slot: 2 } });
    console.log('\n[冷态] /api/student/submit ->', sub.status, sub.text.slice(0, 200));
  } finally { ch.kill(); await sleep(500); try { process.kill(ch.pid, 'SIGKILL'); } catch (e) { } }
  process.exit(0);
})();
