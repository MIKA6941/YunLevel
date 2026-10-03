'use strict';
/*
 * 第01轮专项回归 · 修正版（修掉 v1 的三处脚本缺陷）
 *   B1 tank 拒绝 SET_INLET_TEMP（换第二个学生，避开一账号一处）
 *   B2 旧 MV=1(FV1101) 回路在 /api/state / 回路卡目录里的真实取值
 *   B3 教师保存评分设置 → 是否把在线 hx 会话强制拉回 400
 *   B4 教师 hx 会话配 SP/带宽 → 是否下发到学生引擎
 *   B5 hx 教师导出内容（先 save 再 export）
 *   B6 SET_INLET_TEMP 与 SP / T_target 的语义关系
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.T_PORT || 8099);
const BASE = 'http://127.0.0.1:' + PORT;
const TEACHER_CODE = 'TEST_TEACHER_CODE';
const CLASS_CODE = 'RT26';

let passed = 0, failed = 0;
const failures = [], notes = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { failed++; failures.push(name + ' :: ' + (detail || '')); console.log('  FAIL  ' + name + '  :: ' + (detail || '')); }
  return !!cond;
}
function note(x) { notes.push(x); console.log('  NOTE  ' + x); }
function section(t) { console.log('\n== ' + t + ' =='); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= (tol === undefined ? 0.51 : tol);
async function api(p, opts = {}) {
  const headers = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  let body;
  if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const res = await fetch(BASE + p, { method: opts.method || 'GET', headers, body });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { }
  let cookie = '';
  if (typeof res.headers.getSetCookie === 'function') { const l = res.headers.getSetCookie(); if (l.length) cookie = l.map((c) => c.split(';')[0]).join('; '); }
  return { status: res.status, text, json, cookie, headers: res.headers };
}
const cmd = (ck, t) => api('/api/command', { method: 'POST', cookie: ck, body: { cmd: t } });
const st = (r) => (r && r.json && r.json.state ? r.json.state : null);
async function waitHealth(ms) { const e = Date.now() + ms; while (Date.now() < e) { try { const r = await api('/api/health'); if (r.status === 200 && r.json.ok) return r.json; } catch (x) { } await sleep(200); } throw new Error('not healthy'); }

async function main() {
  const TEST_ROOT = path.join(ROOT, '.test-data-round01');
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(TEST_ROOT, 'targeted-v2-'));
  console.log('port    : ' + PORT + '\ndata dir: ' + dataDir);
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), YUN_DATA_DIR: dataDir, YUN_TEACHER_CODE: TEACHER_CODE, YUN_CLASS_CODE: CLASS_CODE, YUN_MAX_SESSIONS: '16' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
  child.stderr.on('data', (d) => process.stdout.write('[srv] ' + d));
  try {
    await waitHealth(25000);
    const tc = (await api('/api/login', { method: 'POST', body: { role: 'teacher', teacherCode: TEACHER_CODE } })).cookie;
    const classes = await api('/api/teacher/classes', { cookie: tc });
    const cid = classes.json.classes.find((c) => c.code === CLASS_CODE).id;
    for (const s of [['S7001', 'HxStu'], ['S7002', 'TankStu']]) await api('/api/teacher/classes/' + cid + '/students', { method: 'POST', cookie: tc, body: { studentId: s[0], name: s[1] } });
    await api('/api/teacher/settings', { method: 'POST', cookie: tc, body: { openModels: { hx: true } } });

    const hc = (await api('/api/login', { method: 'POST', body: { role: 'student', classCode: CLASS_CODE, studentId: 'S7001', name: 'HxStu', model: 'hx' } })).cookie;
    const tkc = (await api('/api/login', { method: 'POST', body: { role: 'student', classCode: CLASS_CODE, studentId: 'S7002', name: 'TankStu', model: 'tank' } })).cookie;
    check('两个学生分别登录 hx / tank 成功', !!hc && !!tkc, '');

    section('B1 tank 对 SET_INLET_TEMP 的响应');
    const tk = await cmd(tkc, 'SET_INLET_TEMP 500');
    check('tank 拒绝 SET_INLET_TEMP → 400 UNKNOWN_COMMAND', tk.status === 400 && tk.json && tk.json.code === 'UNKNOWN_COMMAND', tk.status + ' ' + tk.text.slice(0, 160));

    section('B2 旧 MV（FV1101=1 / HV1102=3）回路的向后兼容');
    const a1 = await cmd(hc, 'LOOP_ADD 0 1');
    check('LOOP_ADD pv=0(TI1104) mv=1(FV1101) 被引擎接受', a1.status === 200, a1.status + ' ' + a1.text.slice(0, 160));
    const s2 = st(a1) || {};
    const loops = s2.loops || [];
    note('nLoop=' + s2.nLoop + ' loops=' + JSON.stringify(loops.map((l) => ({ pv: l.pv, mv: l.mv }))));
    check('回路表里 MV 字段保留为 1（未被打回 0）', Number(loops[0] && loops[0].mv) === 1, 'mv=' + (loops[0] && loops[0].mv));
    const hv = await cmd(hc, 'SET_VALVE 3 40');
    check('SET_VALVE 3(HV1102) 仍可用', hv.status === 200, hv.status);
    await cmd(hc, 'LOOP_CLEAR');
    const a2 = await cmd(hc, 'LOOP_ADD 0 0');
    const a3 = await cmd(hc, 'LOOP_ADD 0 1');
    check('第二条回路用 MV=1 也能建', a3.status === 200, a3.status + ' ' + a3.text.slice(0, 160));
    note('前端 mvCatalog 现只剩 value 0/2；含 mv=1 的历史工程打开后回路卡 MV 标签会落空');
    const saved = await api('/api/current/save', { method: 'POST', cookie: hc, body: {} });
    check('含旧 MV 工程可保存', saved.status === 200, saved.status);
    const sub = await api('/api/student/submit', { method: 'POST', cookie: hc, body: { slot: 2 } });
    check('含旧 MV 工程可上传云端', sub.status === 200, sub.status + ' ' + sub.text.slice(0, 160));
    const rs = await api('/api/student/restore', { method: 'POST', cookie: hc, body: { slot: 2 } });
    const sr = st(rs) || {};
    const rloops = (sr.loops || []).map((l) => Number(l.mv)).sort();
    check('云端恢复后 nLoop=2', Number(sr.nLoop) === 2, 'nLoop=' + sr.nLoop);
    check('云端恢复后仍保留 MV=1（数据没丢）', rloops.includes(1), 'mv 列表=' + JSON.stringify(rloops));

    section('B3 教师保存评分设置 → 在线 hx 会话是否被强拉回 400');
    await cmd(hc, 'SET_INLET_TEMP 560');
    let s3 = st(await api('/api/state', { cookie: hc })) || {};
    check('前置：学生 hx ti1103=560', near(s3.ti1103, 560), 'ti1103=' + s3.ti1103);
    const post = await api('/api/teacher/settings', {
      method: 'POST', cookie: tc,
      body: { scoreConfig: { initTempHx: 420, durationUnit: 480, durationSystem: 1500, bandTank: 3, bandHx: 8, sp1: 55, sp2: 55, sp3: 55, spHx: 450 } },
    });
    check('POST settings 200 ok', post.status === 200 && post.json.ok === true, post.status);
    await sleep(1500);
    s3 = st(await api('/api/state', { cookie: hc })) || {};
    note('教师保存设置后 学生 ti1103=' + s3.ti1103 + ' sp=' + s3.sp);
    check('学生 ti1103 未被静默改写（期望仍 560；变成 400 即缺陷）', near(s3.ti1103, 560), 'ti1103=' + s3.ti1103);
    check('学生 ti1103 也没有变成教师配的 420（配置未下发）', !near(s3.ti1103, 420), 'ti1103=' + s3.ti1103);

    section('B4 教师 hx 会话配 SP/带宽 → 是否下发到学生引擎');
    const htc = (await api('/api/login', { method: 'POST', body: { role: 'teacher', teacherCode: TEACHER_CODE, model: 'hx' } })).cookie;
    const tsp = await cmd(htc, 'SET_PVX_SP 0 450');
    check('教师 hx 会话 SET_PVX_SP 0 450', tsp.status === 200, tsp.status);
    const tst = st(await api('/api/state', { cookie: htc })) || {};
    check('教师 hx sp=450', near(tst.sp, 450), 'sp=' + tst.sp);
    const sst = st(await api('/api/state', { cookie: hc })) || {};
    check('学生 hx sp 同步为 450（期望失败=配置不下发）', near(sst.sp, 450), '学生 sp=' + sst.sp);
    const tcfg = await cmd(htc, 'SCORE_CFG 480 1500 3 8 300 3 -20');
    check('教师 hx SCORE_CFG', tcfg.status === 200, tcfg.status);
    const sscore = (st(await api('/api/state', { cookie: hc })) || {}).score || {};
    const tscore = (st(await api('/api/state', { cookie: htc })) || {}).score || {};
    note('教师 score=' + JSON.stringify(tscore).slice(0, 200));
    note('学生 score=' + JSON.stringify(sscore).slice(0, 200));
    check('学生 score.mode 仍为 0（教师选的方案没下发）', Number(sscore.mode) === 0, 'mode=' + sscore.mode);

    section('B5 hx 导出内容（先 save 再 export）');
    await api('/api/current/save', { method: 'POST', cookie: htc, body: {} });
    const exp = await api('/api/current/export', { method: 'GET', cookie: htc });
    check('hx 教师导出 200', exp.status === 200, exp.status + ' len=' + (exp.text || '').length + ' ctype=' + (exp.headers.get('content-type') || ''));
    const body = exp.text || '';
    const has = (s) => body.includes(s);
    note('导出体积 ' + body.length + ' 字节（若是 zip 则为二进制，下面按字节查）');
    check('hx 导出不含 FV1101', !has('FV1101'), '');
    check('hx 导出不含 HV1102', !has('HV1102'), '');
    check('hx 导出含 FV1102', has('FV1102'), '');
    check('hx 导出含 TI1103', has('TI1103'), '');

    section('B6 SET_INLET_TEMP 与 SP / 稳态目标的语义');
    await cmd(hc, 'RESET');
    await cmd(hc, 'SET_INLET_TEMP 600');
    const s6 = st(await api('/api/state', { cookie: hc })) || {};
    note('SET_INLET_TEMP 600 后：ti1103=' + s6.ti1103 + ' ti1104=' + s6.ti1104 + ' sp=' + s6.sp);
    check('ti1103 跟随 600', near(s6.ti1103, 600), 'ti1103=' + s6.ti1103);
    check('sp 未跟随（仍为教师/默认目标）', !near(s6.sp, 600), 'sp=' + s6.sp);
    note('→ 学生可把入口温度抬到 650 而评分目标不动；教师配置的「初温/目标 SP」对学生无效');
    const s6b = await cmd(hc, 'START');
    await sleep(8000);
    const s6c = st(await api('/api/state', { cookie: hc })) || {};
    check('入口 600 冷启动后 ti1104 被顶高（物理响应存在）', Number(s6c.ti1104) > 400, 'ti1104=' + s6c.ti1104);
    check('ti1104 未超物理上限 700', Number(s6c.ti1104) < 700, 'ti1104=' + s6c.ti1104);
    const h6 = (await api('/api/history', { cookie: hc })).json.history || {};
    const bad = [];
    for (const [k, arr] of Object.entries(h6)) for (const v of arr) if (v === null || (typeof v === 'number' && !Number.isFinite(v))) bad.push(k);
    check('hx 历史无 null / NaN', bad.length === 0, 'bad channels=' + JSON.stringify([...new Set(bad)]));

    console.log('\n== 汇总 ==\npassed : ' + passed + '\nfailed : ' + failed);
    if (failures.length) { console.log('\nfailures 明细：'); failures.forEach((f) => console.log('  - ' + f)); }
    console.log('\n观察：'); notes.forEach((n) => console.log('  - ' + n));
  } finally {
    child.kill(); await sleep(600);
    try { process.kill(child.pid, 'SIGKILL'); } catch (e) { }
  }
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL ' + e.stack); process.exit(2); });
