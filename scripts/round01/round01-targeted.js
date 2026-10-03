'use strict';
/*
 * 第01轮专项回归：针对 backups/YunLevel-before-hx-plan-ui-20260928-192437 之后的改动
 *   A1 hx 冷态默认温度（TI1103/TI1104/SP 同为 400）
 *   A2 SET_INLET_TEMP 区间与行为（新命令）
 *   A3 运行中 SET_INLET_TEMP
 *   A4 tank 模型拒绝 SET_INLET_TEMP
 *   A5 移出界面的 MV（FV1101 / HV1102）向后兼容
 *   A6 评分配置 scoreConfig 是否落盘
 *   A7 教师评分配置是否下发到学生引擎
 *   A8 换热器导出里是否还残留 FV1101 / HV1102
 * 用法：node round01-targeted.js   （端口 8098，独立临时数据目录）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.T_PORT || 8098);
const BASE = 'http://127.0.0.1:' + PORT;
const TEACHER_CODE = 'TEST_TEACHER_CODE';
const CLASS_CODE = 'RT26';
const SID = 'S7001';
const SNAME = 'RoundOne';

let passed = 0, failed = 0;
const failures = [];
const notes = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { failed++; failures.push(name + ' :: ' + (detail || '')); console.log('  FAIL  ' + name + '  :: ' + (detail || '')); }
  return !!cond;
}
function note(text) { notes.push(text); console.log('  NOTE  ' + text); }
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
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  let cookie = '';
  if (typeof res.headers.getSetCookie === 'function') {
    const l = res.headers.getSetCookie(); if (l.length) cookie = l.map((c) => c.split(';')[0]).join('; ');
  }
  return { status: res.status, text, json, cookie, headers: res.headers };
}
const cmd = (ck, t) => api('/api/command', { method: 'POST', cookie: ck, body: { cmd: t } });
const st = (r) => (r && r.json && r.json.state ? r.json.state : null);
async function waitHealth(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await api('/api/health'); if (r.status === 200 && r.json && r.json.ok) return r.json; } catch (e) { }
    await sleep(200);
  }
  throw new Error('server not healthy');
}

async function main() {
  const TEST_ROOT = path.join(ROOT, '.test-data-round01');
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(TEST_ROOT, 'targeted-'));
  console.log('port    : ' + PORT);
  console.log('data dir: ' + dataDir);
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), YUN_DATA_DIR: dataDir, YUN_TEACHER_CODE: TEACHER_CODE,
      YUN_CLASS_CODE: CLASS_CODE, YUN_MAX_SESSIONS: '12',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
  child.stderr.on('data', (d) => process.stdout.write('[srv] ' + d));

  try {
    await waitHealth(25000);
    const t = await api('/api/login', { method: 'POST', body: { role: 'teacher', teacherCode: TEACHER_CODE } });
    const tc = t.cookie;
    const classes = await api('/api/teacher/classes', { cookie: tc });
    const cid = (classes.json.classes || []).find((c) => c.code === CLASS_CODE).id;
    await api('/api/teacher/classes/' + cid + '/students', { method: 'POST', cookie: tc, body: { studentId: SID, name: SNAME } });
    await api('/api/teacher/settings', { method: 'POST', cookie: tc, body: { openModels: { hx: true } } });

    /* ---------- A1 hx 冷态默认温度 ---------- */
    section('A1 hx 冷态默认温度（改后应为 400/400/400）');
    const hs = await api('/api/login', { method: 'POST', body: { role: 'student', classCode: CLASS_CODE, studentId: SID, name: SNAME, model: 'hx' } });
    const hc = hs.cookie;
    const s0 = st(await api('/api/state', { cookie: hc })) || {};
    check('hx 冷态 ti1103 = 400', near(s0.ti1103, 400), 'ti1103=' + s0.ti1103);
    check('hx 冷态 ti1104 = 400（改前 400+40=440）', near(s0.ti1104, 400), 'ti1104=' + s0.ti1104);
    check('hx 冷态 SP = 400（改前 440）', near(s0.sp, 400), 'sp=' + s0.sp);
    check('hx 冷态 ti1104 与 ti1103 同点（无 +40 偏置）', near(s0.ti1104, s0.ti1103, 0.01), s0.ti1104 + ' vs ' + s0.ti1103);

    /* ---------- A2 SET_INLET_TEMP 区间 ---------- */
    section('A2 SET_INLET_TEMP 区间校验');
    const lo = await cmd(hc, 'SET_INLET_TEMP 249');
    check('249 被拒 INLET_TEMP_RANGE', lo.status === 400 && lo.json && lo.json.code === 'INLET_TEMP_RANGE', lo.status + ' ' + lo.text.slice(0, 120));
    const hi = await cmd(hc, 'SET_INLET_TEMP 651');
    check('651 被拒 INLET_TEMP_RANGE', hi.status === 400 && hi.json && hi.json.code === 'INLET_TEMP_RANGE', hi.status + ' ' + hi.text.slice(0, 120));
    const nan = await cmd(hc, 'SET_INLET_TEMP abc');
    check('非数字被拒或回退 400（记录实际）', true, nan.status + ' ' + nan.text.slice(0, 120) + ' → ti1103=' + (st(nan) || {}).ti1103);
    const r250 = await cmd(hc, 'SET_INLET_TEMP 250');
    check('250 接受', r250.status === 200, r250.status + ' ' + r250.text.slice(0, 120));
    check('ti1103 跟随到 250', near((st(r250) || {}).ti1103, 250), 'ti1103=' + (st(r250) || {}).ti1103);
    const r650 = await cmd(hc, 'SET_INLET_TEMP 650');
    check('650 接受', r650.status === 200, r650.status);
    check('ti1103 跟随到 650', near((st(r650) || {}).ti1103, 650), 'ti1103=' + (st(r650) || {}).ti1103);
    const rMid = await cmd(hc, 'SET_INLET_TEMP 520');
    check('520 接受且精确', near((st(rMid) || {}).ti1103, 520, 0.01), 'ti1103=' + (st(rMid) || {}).ti1103);
    const spAfter = Number((st(rMid) || {}).sp);
    check('SET_INLET_TEMP 同时把 SP 拉到同值（引擎行为）', near(spAfter, 520), 'sp=' + spAfter);
    const noArg = await cmd(hc, 'SET_INLET_TEMP');
    check('缺参数时不静默改值（期望报错）', noArg.status === 400, 'status=' + noArg.status + ' → ti1103=' + (st(noArg) || {}).ti1103);
    await cmd(hc, 'SET_INLET_TEMP 400');

    /* ---------- A3 运行中 SET_INLET_TEMP ---------- */
    section('A3 运行中 SET_INLET_TEMP + TI1104 曲线通道');
    await cmd(hc, 'LOOP_ADD 0 0');
    await cmd(hc, 'SET_PID loop 0 0.5 60 0 1 0 0');
    const started = await cmd(hc, 'START');
    check('hx START', started.status === 200, started.status);
    await sleep(6000);
    const runSet = await cmd(hc, 'SET_INLET_TEMP 300');
    check('运行中 SET_INLET_TEMP 300 被接受', runSet.status === 200, runSet.status + ' ' + runSet.text.slice(0, 120));
    await sleep(4000);
    const s1 = st(await api('/api/state', { cookie: hc })) || {};
    check('运行中 ti1103 已变为 300', near(s1.ti1103, 300), 'ti1103=' + s1.ti1103);
    check('ti1104 有限且非 NaN', Number.isFinite(Number(s1.ti1104)), 'ti1104=' + s1.ti1104);
    check('ti1104 落在物理区间 100..700', Number(s1.ti1104) > 100 && Number(s1.ti1104) < 700, 'ti1104=' + s1.ti1104);
    const hxHist = (await api('/api/history', { cookie: hc })).json.history || {};
    const ti4 = hxHist.ti1104 || [];
    check('hx history 17 通道', Object.keys(hxHist).length === 17, 'n=' + Object.keys(hxHist).length);
    check('TI1104 通道是真实数值（非 null/NaN）', ti4.length > 0 && ti4.every((v) => typeof v === 'number' && Number.isFinite(v)), 'n=' + ti4.length + ' last=' + ti4[ti4.length - 1]);
    const ti3 = hxHist.ti1103 || [];
    check('TI1103 通道有值且被改写', ti3.length > 0 && ti3.every((v) => typeof v === 'number' && Number.isFinite(v)) && near(ti3[ti3.length - 1], 300, 1.0), 'last=' + ti3[ti3.length - 1]);
    check('history 各通道等长', new Set(Object.keys(hxHist).map((k) => hxHist[k].length)).size === 1, JSON.stringify([...new Set(Object.keys(hxHist).map((k) => hxHist[k].length))]));
    await cmd(hc, 'PAUSE');

    /* ---------- A4 tank 拒绝 SET_INLET_TEMP ---------- */
    section('A4 tank 模型对 SET_INLET_TEMP 的响应');
    const ts = await api('/api/login', { method: 'POST', body: { role: 'student', classCode: CLASS_CODE, studentId: SID, name: SNAME, model: 'tank' } });
    const tkc = ts.cookie;
    const tk = await cmd(tkc, 'SET_INLET_TEMP 500');
    check('tank 拒绝 SET_INLET_TEMP（期望 400 UNKNOWN_COMMAND）', tk.status === 400, 'status=' + tk.status + ' ' + tk.text.slice(0, 140));

    /* ---------- A5 已移出界面的 MV 向后兼容 ---------- */
    section('A5 FV1101 / HV1102 回路向后兼容（UI 目录已删这两个 MV）');
    const mv1 = await cmd(hc, 'LOOP_ADD 1 1');
    check('引擎仍接受 LOOP_ADD pv=TI1104 mv=FV1101(1)', mv1.status === 200, mv1.status + ' ' + mv1.text.slice(0, 140));
    const hv = await cmd(hc, 'SET_VALVE 3 40');
    check('引擎仍接受 SET_VALVE 3(HV1102)', hv.status === 200, hv.status + ' ' + hv.text.slice(0, 140));
    if (mv1.status === 200) {
      const sMv = st(mv1) || {};
      const loopMv = sMv.loops && sMv.loops[0] ? sMv.loops[0].mv : null;
      note('旧 MV=1 回路在 /api/state 中的 mv 字段 = ' + JSON.stringify(loopMv) + '（前端 mvCatalog 已无 value=1，回路卡会显示空标签）');
      const saved = await api('/api/current/save', { method: 'POST', cookie: hc, body: {} });
      check('含旧 MV 的工程可保存', saved.status === 200, saved.status + ' ' + saved.text.slice(0, 140));
      const sub = await api('/api/student/submit', { method: 'POST', cookie: hc, body: { slot: 2 } });
      check('含旧 MV 的工程可上传云端', sub.status === 200, sub.status + ' ' + sub.text.slice(0, 140));
      const res2 = await api('/api/student/restore', { method: 'POST', cookie: hc, body: { slot: 2 } });
      check('含旧 MV 的工程可从云端恢复', res2.status === 200, res2.status + ' ' + res2.text.slice(0, 140));
      const sRes = st(res2) || {};
      check('恢复后回路数一致', Number(sRes.nLoop) === Number(sMv.nLoop), 'nLoop=' + sRes.nLoop);
    }
    // hx 课程里 FV1101 已从图面/曲线/指标移除，检查导出里是否还有痕迹
    const exp = await api('/api/current/export', { method: 'GET', cookie: tc });
    note('教师 /api/current/export（tank 教师会话）status=' + exp.status);

    /* ---------- A6 scoreConfig 是否落盘 ---------- */
    section('A6 评分配置 scoreConfig 是否被服务端保存');
    const setPost = await api('/api/teacher/settings', {
      method: 'POST', cookie: tc,
      body: {
        scoreConfig: {
          initTempHx: 420, durationUnit: 480, durationSystem: 1500,
          bandTank: 3, bandHx: 8, sysBandTank: 4, sysBandHx: 9,
          disturbAt: 300, disturbMv: 3, disturbDelta: -20,
          sp1: 55, sp2: 55, sp3: 55, spHx: 450, sysSp1: 60, sysSp2: 60, sysSp3: 60, sysSpHx: 470,
        },
      },
    });
    check('POST /api/teacher/settings 返回 200 ok', setPost.status === 200 && setPost.json && setPost.json.ok === true, setPost.status + ' ' + setPost.text.slice(0, 160));
    check('响应 settings 里含 scoreConfig（未落盘则失败）', !!(setPost.json && setPost.json.settings && setPost.json.settings.scoreConfig),
      'settings keys=' + JSON.stringify(setPost.json && setPost.json.settings ? Object.keys(setPost.json.settings) : null));
    const rawFile = path.join(dataDir, 'settings.json');
    let rawTxt = '';
    try { rawTxt = fs.readFileSync(rawFile, 'utf8'); } catch (e) { rawTxt = '(read fail ' + e.message + ')'; }
    check('磁盘 settings.json 含 initTempHx', rawTxt.indexOf('initTempHx') >= 0, rawTxt.slice(0, 200));

    /* ---------- A7 教师评分配置是否下发到学生引擎 ---------- */
    section('A7 教师评分配置 → 学生引擎');
    await api('/api/teacher/settings', { method: 'POST', cookie: tc, body: { allowStudentUpload: true } });
    const sHxAfter = st(await api('/api/state', { cookie: hc })) || {};
    check('学生 hx 初温被改成 420（期望失败=缺陷）', near(sHxAfter.ti1103, 420), 'ti1103=' + sHxAfter.ti1103 + ' sp=' + sHxAfter.sp);
    check('学生 hx SP 被改成 450（期望失败=缺陷）', near(sHxAfter.sp, 450, 1.0), 'sp=' + sHxAfter.sp);
    note('hx 引擎默认 SP 来自内置模板（400/450 视初始状态），学生端 SP 不受教师评分面板影响');

    // 换热器单对象评分：教师面板 obj=hx/mode=unit 会下发 SCORE_MODE 1
    const hxMode = await cmd(hc, 'SCORE_MODE 1');
    check('hx 引擎接受 SCORE_MODE 1（单对象）', hxMode.status === 200, hxMode.status + ' ' + hxMode.text.slice(0, 140));
    const hxObj = await cmd(hc, 'SCORE_TANK 0');
    check('hx 引擎接受 SCORE_TANK 0', hxObj.status === 200, hxObj.status + ' ' + hxObj.text.slice(0, 140));
    const cfg = await cmd(hc, 'SCORE_CFG 480 1500 3 8 300 3 -20');
    check('hx 引擎接受 SCORE_CFG（单对象限时/带宽）', cfg.status === 200, cfg.status + ' ' + cfg.text.slice(0, 140));
    const scCfg = (st(cfg) || {}).score || {};
    note('学生 hx score 摘要 = ' + JSON.stringify(scCfg).slice(0, 300));

    /* ---------- A8 换热器导出是否残留 FV1101 / HV1102 ---------- */
    section('A8 换热器导出内容（models.js mvNames 已删 FV1101）');
    const hxTeacher = await api('/api/login', { method: 'POST', body: { role: 'teacher', teacherCode: TEACHER_CODE, model: 'hx' } });
    const htc = hxTeacher.cookie;
    const csv = await api('/api/teacher/records', { cookie: htc });
    note('/api/teacher/records status=' + csv.status);
    const hxExp = await api('/api/current/export', { method: 'GET', cookie: htc });
    const body = hxExp.text || '';
    check('hx 教师导出 200', hxExp.status === 200, hxExp.status + ' len=' + body.length);
    if (hxExp.status === 200) {
      const bin = Buffer.from(body, 'binary');
      const has = (s) => bin.includes(Buffer.from(s, 'utf8')) || body.includes(s);
      check('hx 导出不含 FV1101', !has('FV1101'), '');
      check('hx 导出不含 HV1102', !has('HV1102'), '');
      check('hx 导出不含 FV1105 的旧名「蒸汽B」', !has('蒸汽B'), '');
    }

    /* ---------- 汇总 ---------- */
    console.log('\n== 汇总 ==');
    console.log('passed : ' + passed);
    console.log('failed : ' + failed);
    if (failures.length) { console.log('\nfailures 明细：'); failures.forEach((f) => console.log('  - ' + f)); }
    console.log('\n观察：'); notes.forEach((n) => console.log('  - ' + n));
  } finally {
    child.kill();
    await sleep(600);
    try { process.kill(child.pid, 'SIGKILL'); } catch (e) { }
  }
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL ' + e.stack); process.exit(2); });
