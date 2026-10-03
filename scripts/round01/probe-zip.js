'use strict';
// 云端导出 ZIP 内部结构核查（G-17 局部）+ hx CSV 是否残留 FV1101
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8101, BASE = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, o = {}) {
  const h = {}; if (o.cookie) h.cookie = o.cookie; let b;
  if (o.body !== undefined) { h['content-type'] = 'application/json'; b = JSON.stringify(o.body); }
  const r = await fetch(BASE + p, { method: o.method || 'GET', headers: h, body: b });
  const buf = Buffer.from(await r.arrayBuffer()); const t = buf.toString('utf8');
  let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { }
  let c = ''; if (typeof r.headers.getSetCookie === 'function') { const l = r.headers.getSetCookie(); if (l.length) c = l.map((x) => x.split(';')[0]).join('; '); }
  return { status: r.status, text: t, json: j, cookie: c, buf, headers: r.headers };
}
(async () => {
  const TEST_ROOT = path.join(ROOT, '.test-data-round01');
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'probe-zip-'));
  const ch = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), YUN_DATA_DIR: dir, YUN_TEACHER_CODE: 'TEST_TEACHER_CODE', YUN_CLASS_CODE: 'ZP26', YUN_MAX_SESSIONS: '12' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ch.stdout.on('data', d => process.stdout.write('[srv] ' + d)); ch.stderr.on('data', d => process.stdout.write('[srv] ' + d));
  try {
    for (let i = 0; i < 100; i++) { try { const h = await api('/api/health'); if (h.json && h.json.ok) break; } catch (e) { } await sleep(200); }
    const tc = (await api('/api/login', { method: 'POST', body: { role: 'teacher', teacherCode: 'TEST_TEACHER_CODE' } })).cookie;
    const classes = await api('/api/teacher/classes', { cookie: tc });
    const cid = classes.json.classes.find(c => c.code === 'ZP26').id;
    await api('/api/teacher/settings', { method: 'POST', cookie: tc, body: { openModels: { hx: true }, allowStudentUpload: true } });
    for (const [id, nm] of [['Z1001', '甲'], ['Z1002', '乙']]) await api('/api/teacher/classes/' + cid + '/students', { method: 'POST', cookie: tc, body: { studentId: id, name: nm } });

    for (const [id, nm, model] of [['Z1001', '甲', 'hx'], ['Z1002', '乙', 'tank']]) {
      const sc = (await api('/api/login', { method: 'POST', body: { role: 'student', classCode: 'ZP26', studentId: id, name: nm, model } })).cookie;
      await api('/api/command', { method: 'POST', cookie: sc, body: { cmd: 'LOOP_ADD 0 0' } });
      await api('/api/command', { method: 'POST', cookie: sc, body: { cmd: 'START' } });
      await sleep(3000);
      await api('/api/command', { method: 'POST', cookie: sc, body: { cmd: 'PAUSE' } });
      const sub = await api('/api/student/submit', { method: 'POST', cookie: sc, body: { slot: 1 } });
      console.log('submit ' + id + '/' + model + ' -> ' + sub.status + ' ' + sub.text.slice(0, 120));
      await api('/api/logout', { method: 'POST', cookie: sc, body: {} });
    }

    for (const model of ['hx', 'tank', 'all']) {
      const z = await api('/api/teacher/cloud-export', { method: 'POST', cookie: tc, body: { classId: cid, model: model } });
      const disp = decodeURIComponent(String(z.headers.get('content-disposition') || ''));
      console.log('\n=== cloud-export model=' + model + ' -> ' + z.status + ' ctype=' + z.headers.get('content-type') + ' bytes=' + z.buf.length);
      console.log('   content-disposition: ' + disp);
      if (z.status !== 200) { console.log(z.text.slice(0, 200)); continue; }
      // zip 里的文件名是明文存储的
      const names = [];
      const b = z.buf;
      for (let i = 0; i + 30 < b.length; i++) {
        if (b.readUInt32LE(i) === 0x04034b50) {
          const nlen = b.readUInt16LE(i + 26);
          const elen = b.readUInt16LE(i + 28);
          const nm = b.slice(i + 30, i + 30 + nlen).toString('utf8');
          if (nm && !nm.endsWith('/')) names.push({ off: i, size: b.readUInt32LE(i + 18), csize: b.readUInt32LE(i + 22), nm });
        }
      }
      names.forEach(n => console.log('   entry: ' + n.nm + '  (' + n.csize + ' bytes)'));
      const allNames = names.map(n => n.nm);
      console.log('   含 FV1101 的条目: ' + JSON.stringify(allNames.filter(n => n.includes('FV1101'))));
      console.log('   含 HV1102 的条目: ' + JSON.stringify(allNames.filter(n => n.includes('HV1102'))));
      console.log('   目录前缀: ' + JSON.stringify([...new Set(allNames.map(n => n.split('/')[0]))]));
      // CSV 是 store 还是 deflate：看原始字节里能不能搜到位号
      const probe = ['FV1101', 'HV1102', 'FV1102', 'FV1105', 'TI1103', 'TI1104', 'FV101', 'LI101'];
      console.log('   原始字节命中: ' + JSON.stringify(probe.map((s) => [s, b.includes(Buffer.from(s, 'utf8'))])));
      const f = names.find(n => n.nm.endsWith('.csv') && n.nm.includes('参数'));
      if (f) {
        const raw = b.slice(f.off, f.off + 30 + f.nm.length + f.csize);
        console.log('   首个 ' + f.nm + ' 的原始片段: ' + JSON.stringify(raw.toString('utf8').slice(0, 160)));
      }
    }
  } finally { ch.kill(); await sleep(500); try { process.kill(ch.pid, 'SIGKILL'); } catch (e) { } }
  process.exit(0);
})();
