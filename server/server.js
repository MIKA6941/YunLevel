const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const config = require('./config');
const { ensureDir, appendJsonLine, readJson, readJsonLines, csvCell, safeId } = require('./storage');
const { hashId } = require('./storage');
const {
  RosterStore,
  normalizeClassCode,
  normalizeStudentId,
  cleanText,
} = require('./roster-store');
const { EngineSession } = require('./engine-session');
const { SnapshotStore, PROJECT_SLOTS } = require('./snapshot-store-v2');
const {
  MODEL_IDS,
  modelDisplayName,
  modelExportSpec,
  resolveModelIds,
  sessionKeyForModel,
} = require('./models');
const { buildZip } = require('./zip-builder');

ensureDir(config.dataDir);
ensureDir(config.stateDir);
ensureDir(config.historyDir);
ensureDir(config.runtimeDir);
ensureDir(config.modelDirs.hx.stateDir);
ensureDir(config.modelDirs.hx.historyDir);
const snapshots = new SnapshotStore({
  modelId: 'tank',
  settingsFile: config.settingsFile,
  submissionsDir: config.submissionsDir,
  teacherBackupsDir: config.teacherBackupsDir,
});

// 换热器使用独立的快照库（目录完全分开），但全局设置只有一份。
const snapshotsHx = new SnapshotStore({
  modelId: 'hx',
  settingsFile: config.settingsFile,
  settingsSource: snapshots,
  submissionsDir: config.modelDirs.hx.submissionsDir,
  teacherBackupsDir: config.modelDirs.hx.teacherBackupsDir,
});

// 与「某个模型的学生数据」相关的读写都经过这里；
// 名单和全局设置不分模型。
function storeFor(modelId) {
  return modelId === 'hx' ? snapshotsHx : snapshots;
}
for (const name of fs.readdirSync(config.runtimeDir)) {
  try { fs.unlinkSync(path.join(config.runtimeDir, name)); } catch {}
}

const LF = String.fromCharCode(10);
const BOM = String.fromCharCode(0xFEFF);
const CLOUD_UPLOAD_BODY_LIMIT = 24 * 1024 * 1024;
const roster = new RosterStore(config.classesFile, config.classCode);
const sessionsByToken = new Map();
const enginesByKey = new Map();
const studentStreams = new Map();
const teacherStreams = new Map();
const teacherStudentStreams = new Map();
let recordCache = readJsonLines(config.recordsFile);

// 会话键。tank 走 sessionKeyForModel 的默认分支，返回值与改造前逐字一致。
function sessionKey(classId, studentId) {
  return sessionKeyForModel(classId, studentId, config.defaultModelId);
}

function sessionKeyFor(classId, studentId, modelId) {
  return sessionKeyForModel(classId, studentId, modelId || config.defaultModelId);
}

function teacherSessionKey(modelId) {
  return sessionKeyFor(TEACHER_CLASS_ID, TEACHER_STUDENT_ID, modelId);
}

const TEACHER_CLASS_ID = '__teacher__';
const TEACHER_STUDENT_ID = 'teacher';

function runtimePaths(sessionKeyValue) {
  const token = `${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
  const prefix = `${hashId(sessionKeyValue)}_${token}`;
  return {
    stateFile: path.join(config.runtimeDir, `${prefix}.bin`),
    historyFile: path.join(config.runtimeDir, `${prefix}.json`),
  };
}

function cleanupRuntimeFiles(engine) {
  if (!engine || !String(engine.stateFile || '').startsWith(path.resolve(config.runtimeDir))) return;
  setTimeout(() => {
    try { fs.unlinkSync(engine.stateFile); } catch {}
    try { fs.unlinkSync(engine.historyFile); } catch {}
  }, 1700).unref?.();
}

function stopEngine(engine, removeRuntime = false) {
  if (!engine) return;
  engine.stop();
  if (removeRuntime) cleanupRuntimeFiles(engine);
}

function waitForClosed(engine, timeoutMs = 2600) {
  if (!engine || engine.closed && !engine.child) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    engine.once('closed', finish);
  });
}

function studentEngineOptions(classInfo, studentId, studentName, sessionKeyValue, modelId = config.defaultModelId) {
  const dirs = config.dirsForModel(modelId);
  return {
    classId: classInfo.id,
    sessionKey: sessionKeyValue,
    studentId,
    name: studentName,
    className: classInfo.name,
    modelId,
    enginePath: config.engineForModel(modelId),
    dataDir: config.dataDir,
    stateDir: dirs.stateDir,
    historyDir: dirs.historyDir,
    ...runtimePaths(sessionKeyValue),
  };
}

function teacherEngineOptions(modelId = config.defaultModelId) {
  const dirs = config.dirsForModel(modelId);
  const key = teacherSessionKey(modelId);
  const prefix = hashId(key);
  return {
    classId: TEACHER_CLASS_ID,
    sessionKey: key,
    studentId: TEACHER_STUDENT_ID,
    name: '教师演示',
    className: '教学演示',
    ownerRole: 'teacher',
    modelId,
    enginePath: config.engineForModel(modelId),
    dataDir: config.dataDir,
    stateDir: dirs.stateDir,
    historyDir: dirs.historyDir,
    stateFile: path.join(dirs.stateDir, `${prefix}.bin`),
    historyFile: path.join(dirs.historyDir, `${prefix}.json`),
  };
}

async function saveStudentSnapshot(engine, reason = 'manual', enforcePermission = false) {
  if (!engine) throw Object.assign(new Error('没有正在运行的会话'), { statusCode: 404 });
  if (enforcePermission && !snapshots.getSettings().allowStudentUpload) {
    throw Object.assign(new Error('教师未开放上传，请联系老师'), { statusCode: 403 });
  }
  await engine.send('SAVE', 4000);
  return storeFor(engine.modelId).saveProject(engine, 1, reason);
}

async function saveProjectSnapshot(engine, slot, reason = 'manual', enforcePermission = false, assets = {}) {
  if (!engine) throw Object.assign(new Error('没有正在运行的会话'), { statusCode: 404 });
  // 云端1=导出云端：受教师「上传云端」开关控制；云端2/3/4 学生自由上传
  if (enforcePermission && slot === 1 && engine.ownerRole !== 'teacher' && !snapshots.getSettings().allowStudentUpload) {
    throw Object.assign(new Error('导出云端（云端1）未开放上传，请联系老师'), { statusCode: 403 });
  }
  // 冷态（未启动）与暂停都允许上传；仅「运行且未暂停」拒绝
  if (engine.lastState?.running && !engine.lastState?.paused) {
    throw Object.assign(new Error('请先暂停仿真，再上传云端'), { statusCode: 400 });
  }
  await engine.send('SAVE', 4000);
  return storeFor(engine.modelId).saveProject(engine, slot, reason, { assets });
}

async function saveCurrentSnapshot(engine, reason = 'manual') {
  if (!engine) throw Object.assign(new Error('没有正在运行的会话'), { statusCode: 404 });
  // H1 整改：只有「运行中且未暂停」才拒绝；
  // 冷态（未启动）与暂停状态都允许保存当前配置/状态。
  if (engine.lastState?.running && !engine.lastState?.paused) {
    throw Object.assign(new Error('请先暂停仿真，再保存当前状态'), { statusCode: 400 });
  }
  await engine.send('SAVE', 4000);
  return storeFor(engine.modelId).saveCurrent(engine, reason);
}

async function saveStudentRecovery(engine, reason = 'forced-exit') {
  if (!engine) throw Object.assign(new Error('没有正在运行的会话'), { statusCode: 404 });
  await engine.send('SAVE', 4000);
  return storeFor(engine.modelId).saveRecovery(engine, reason);
}

function broadcastStudentSettings() {
  const settings = snapshots.getSettings();
  const data = `event: settings${LF}data: ${JSON.stringify(settings)}${LF}${LF}`;
  for (const set of studentStreams.values()) {
    for (const res of set) {
      try { res.write(data); } catch { set.delete(res); }
    }
  }
}

function engineForAuth(auth) {
  return auth?.sessionKey ? enginesByKey.get(auth.sessionKey) || null : null;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, value, type = 'text/plain; charset=utf-8', filename = '') {
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  };
  if (filename) {
    const safeName = String(filename).replace(/[\\/:*?"<>|]/g, '_');
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`;
  }
  res.writeHead(status, headers);
  res.end(value);
}

function sendProjectDownload(res, filename, project) {
  const safeName = String(filename || 'project').replace(/[^0-9A-Za-z_.\-\u4e00-\u9fff]/g, '_');
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName}.ylproj`)}`,
  });
  res.end(JSON.stringify(project));
}

function sendZipDownload(res, filename, buffer) {
  const safeName = String(filename || 'export').replace(/[\\/:*?"<>|]/g, '_');
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName}.zip`)}`,
  });
  res.end(buffer);
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function authOf(req) {
  const token = parseCookies(req).yun_token;
  return token ? sessionsByToken.get(token) : null;
}

function requireRole(req, res, role) {
  const auth = authOf(req);
  if (!auth) {
    sendJson(res, 401, { error: '请先登录' });
    return null;
  }
  if (role && auth.role !== role) {
    sendJson(res, 403, { error: '没有权限' });
    return null;
  }
  return auth;
}

function requireSimulationRole(req, res) {
  const auth = requireRole(req, res);
  if (!auth) return null;
  if (auth.role !== 'student' && auth.role !== 'teacher') {
    sendJson(res, 403, { error: '没有仿真权限' });
    return null;
  }
  return auth;
}

function readBody(req, limit = 1024 * 256) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function authCookie(token) {
  const secure = config.cookieSecure ? '; Secure' : '';
  return `yun_token=${token}; HttpOnly; SameSite=Lax; Path=/${secure}`;
}

function publicStudentState(engine) {
  return {
    ...engine.summary,
    state: engine.lastState,
    history: engine.history,
  };
}

function visibleSessions(classId = '', modelId = '') {
  const classFilter = String(classId || '');
  const modelFilter = String(modelId || '');
  return Array.from(enginesByKey.values())
    .filter((engine) => engine.ownerRole !== 'teacher')
    .filter((engine) => !classFilter || engine.classId === classFilter)
    // 两个模型各看各的：教师端的液位看板不会混进换热器的学生。
    .filter((engine) => !modelFilter || engine.modelId === modelFilter)
    .map((engine) => engine.summary);
}

function overview(classId = '', modelId = '') {
  // modelId='all' 表示教师端「全部模型」：不再按模型过滤，两个模型的学生一起返回。
  const all = modelId === 'all' || modelId === '*';
  const sessions = visibleSessions(classId, all ? '' : modelId);
  return {
    serverTime: new Date().toISOString(),
    model: String(modelId || ''),
    online: sessions.length,
    sessions,
  };
}

function broadcastToStudent(engine, event, payload) {
  const set = studentStreams.get(engine.sessionKey);
  if (!set) return;
  const data = `event: ${event}${LF}data: ${JSON.stringify(payload)}${LF}${LF}`;
  for (const res of set) {
    try { res.write(data); } catch { set.delete(res); }
  }
}

function broadcastToTeacherStudentWatchers(engine, state) {
  if (!state || !teacherStudentStreams.size) return;
  const data = `event: state${LF}data: ${JSON.stringify(state)}${LF}${LF}`;
  for (const [res, target] of teacherStudentStreams) {
    if (target.classId !== engine.classId || target.studentId !== engine.studentId) continue;
    if ((target.modelId || config.defaultModelId) !== engine.modelId) continue;
    try { res.write(data); } catch { teacherStudentStreams.delete(res); }
  }
}

function emitOverviewNow() {
  if (!teacherStreams.size) return;
  // 每个教师连接只看自己那个模型的看板。
  const rendered = new Map();
  for (const [res, modelId] of teacherStreams) {
    const key = String(modelId || config.defaultModelId);
    if (!rendered.has(key)) {
      const payload = overview('', key);
      rendered.set(key, `event: overview${LF}data: ${JSON.stringify(payload)}${LF}${LF}`);
    }
    try { res.write(rendered.get(key)); } catch { teacherStreams.delete(res); }
  }
}

let overviewTimer = null;
function broadcastOverview() {
  if (overviewTimer) return;
  overviewTimer = setTimeout(() => {
    overviewTimer = null;
    emitOverviewNow();
  }, 1000);
  overviewTimer.unref?.();
}

function appendScoreRecord(engine) {
  const state = engine.lastState || {};
  const score = state.score || {};
  const key = `${engine.sessionKey}:${score.sessionT}:${score.total}`;
  if (engine.lastRecordKey === key) return;
  engine.lastRecordKey = key;
  const record = {
    endedAt: new Date().toISOString(),
    modelId: engine.modelId,
    classId: engine.classId,
    studentId: engine.studentId,
    name: engine.name,
    className: engine.className,
    ownerRole: engine.ownerRole,
    mode: Number(score.mode || 0),
    tank: Number(score.tank || 0),
    scoreTime: Number(score.sessionT || 0),
    score: {
      total: Number(score.total || 0),
      operation: Number(score.operation || 0),
      control: Number(score.control || 0),
      safety: Number(score.safety || 0),
      benefit: Number(score.benefit || 0),
      flowBalance: Number(score.flowBalance || 0),
      efficiency: Number(score.efficiency || 0),
    },
    tanks: state.tanks || [],
    loops: state.loops || [],
    cascades: state.cascades || [],
  };
  recordCache.push(record);
  appendJsonLine(config.recordsFile, record);
}

function recordModel(record) {
  return String(record.modelId || config.defaultModelId);
}

function recordsCsv(classId = '', modelId = '') {
  const lines = [
    [
      '结束时间', '实验模型', '班级', '学号', '姓名', '评分模式', '评分对象', '评分时间(s)',
      '总分', '操作', '控制', '安全', '收益', '流量平衡', '效率',
    ].join(','),
  ];
  const filter = String(classId || '');
  const modelFilter = String(modelId || '');
  const allModels = modelFilter === 'all' || modelFilter === '*';
  for (const r of recordCache) {
    if (r.ownerRole === 'teacher') continue;
    if (filter && r.classId !== filter) continue;
    if (!allModels && modelFilter && recordModel(r) !== modelFilter) continue;
    lines.push([
      r.endedAt, modelDisplayName(recordModel(r)), r.className, r.studentId, r.name, r.mode, r.tank, r.scoreTime,
      r.score.total, r.score.operation, r.score.control, r.score.safety,
      r.score.benefit, r.score.flowBalance, r.score.efficiency,
    ].map(csvCell).join(','));
  }
  return `${BOM}${lines.join(LF)}${LF}`;
}

function rosterCsv(classId) {
  const classInfo = roster.findClassById(classId);
  if (!classInfo) throw Object.assign(new Error('班级不存在'), { statusCode: 404 });
  const lines = [['学号', '姓名', '状态'].join(',')];
  for (const student of classInfo.students) {
    lines.push([student.studentId, student.name, student.enabled ? '启用' : '停用'].map(csvCell).join(','));
  }
  return `${BOM}${lines.join(LF)}${LF}`;
}


function scoreConfigFromSettings() {
  try {
    const settings = snapshots.getSettings();
    return (settings && settings.scoreConfig && typeof settings.scoreConfig === 'object')
      ? settings.scoreConfig
      : null;
  } catch {
    return null;
  }
}

function numOr(value, fallback) {
  const v = Number(value);
  return Number.isFinite(v) ? v : fallback;
}

// 把教师评分细则下发到单个会话（教师/学生同一路径）。
// opts.applyInitTemp：仅在教师显式带 scoreConfig 且会话冷态时改 TI1103，避免把学生实验中的 560 打回 400。
async function applyScoreConfigToEngine(engine, cfg, opts = {}) {
  if (!engine || !cfg) return;
  const applyInitTemp = opts.applyInitTemp !== false;
  const isHx = engine.modelId === 'hx';
  const du = numOr(cfg.durationUnit, 480);
  const ds = numOr(cfg.durationSystem, 1500);
  const bt = numOr(cfg.bandTank, 2);
  const bh = numOr(cfg.bandHx, 5);
  const da = numOr(cfg.disturbAt, 300);
  const dm = numOr(cfg.disturbMv, 3);
  const dd = numOr(cfg.disturbDelta, -20);
  try {
    await engine.send(`SCORE_CFG ${du} ${ds} ${bt} ${bh} ${da} ${dm} ${dd}`);
    if (isHx) {
      const spHx = numOr(cfg.spHx, 400);
      await engine.send(`SET_PVX_SP 0 ${spHx}`);
      const initTemp = numOr(cfg.initTempHx, NaN);
      const cold = !(engine.lastState && engine.lastState.running);
      if (applyInitTemp && cold && Number.isFinite(initTemp) && initTemp > 100 && initTemp < 700) {
        await engine.send(`SET_INIT_TEMP ${initTemp}`);
      }
    } else {
      await engine.send(`SET_SP 0 ${numOr(cfg.sp1, 50)}`);
      await engine.send(`SET_SP 1 ${numOr(cfg.sp2, 50)}`);
      await engine.send(`SET_SP 2 ${numOr(cfg.sp3, 50)}`);
    }
  } catch (err) {
    console.error(`apply score config failed: ${err.message}`);
  }
}

async function applyScoreConfigToAll(patchScoreConfig, opts = {}) {
  const cfg = patchScoreConfig || scoreConfigFromSettings();
  if (!cfg) return;
  for (const engine of enginesByKey.values()) {
    if (!engine || engine.closed) continue;
    await applyScoreConfigToEngine(engine, cfg, opts);
  }
}

async function applyHxInitTempToEngine(engine) {
  if (!engine || engine.modelId !== 'hx') return;
  const cfg = scoreConfigFromSettings();
  const t = numOr(cfg && cfg.initTempHx, 400);
  try {
    if (!engine.lastState || !engine.lastState.running) {
      await engine.send(`SET_INIT_TEMP ${t}`);
    }
  } catch (err) {
    console.error(`apply hx init temp failed: ${err.message}`);
  }
}

function attachEngine(engine) {
  engine.on('state', (state) => {
    engine.appendHistory(state);
    broadcastToStudent(engine, 'state', state);
    broadcastToTeacherStudentWatchers(engine, state);
    if (state.scoreEnded && engine.ownerRole !== 'teacher') appendScoreRecord(engine);
    if (engine.ownerRole !== 'teacher') broadcastOverview();
  });
  engine.on('log', (text) => console.error(`[engine ${engine.classId}/${engine.studentId}] ${text}`));
  engine.on('closed', () => {
    if (enginesByKey.get(engine.sessionKey) === engine) {
      enginesByKey.delete(engine.sessionKey);
    }
    if (engine.ownerRole !== 'teacher') broadcastOverview();
  });
}

function studentHasLiveSession(classId, studentId) {
  for (const auth of sessionsByToken.values()) {
    if (auth.role === 'student' && auth.classId === classId && auth.studentId === studentId) {
      return true;
    }
  }
  return false;
}

function revokeStudentAuthAll(classId, studentId) {
  for (const [token, auth] of sessionsByToken) {
    if (auth.role === 'student' && auth.classId === classId && auth.studentId === studentId) {
      sessionsByToken.delete(token);
    }
  }
}

function revokeStudentAuth(classId, studentId, modelId = config.defaultModelId) {
  for (const [token, auth] of sessionsByToken) {
    if (auth.role === 'student' && auth.classId === classId && auth.studentId === studentId && (auth.modelId || config.defaultModelId) === modelId) {
      sessionsByToken.delete(token);
    }
  }
}

function stopStudentEngine(classId, studentId) {
  // 名单变更要同时清掉这个学生在两个模型上的会话，否则换热器会话会被漏掉。
  for (const modelId of MODEL_IDS) {
    const key = sessionKeyFor(classId, studentId, modelId);
    const engine = enginesByKey.get(key);
    if (engine) {
      saveStudentRecovery(engine, 'account-change').catch(() => {}).finally(() => stopEngine(engine, true));
      enginesByKey.delete(key);
    }
    studentStreams.delete(key);
    revokeStudentAuth(classId, studentId, modelId);
  }
}

function stopClassEngines(classId) {
  for (const [key, engine] of enginesByKey) {
    if (engine.classId !== classId) continue;
    saveStudentRecovery(engine, 'class-change').catch(() => {}).finally(() => stopEngine(engine, true));
    enginesByKey.delete(key);
    studentStreams.delete(key);
  }
  for (const [token, auth] of sessionsByToken) {
    if (auth.role === 'student' && auth.classId === classId) sessionsByToken.delete(token);
  }
}

async function login(req, res, body) {
  const role = body.role === 'teacher' ? 'teacher' : 'student';
  const requestedModel = String(body.model || config.defaultModelId);
  if (requestedModel !== 'tank' && requestedModel !== 'hx') {
    return sendJson(res, 400, { error: '实验模型编号无效' });
  }
  const openModels = snapshots.getSettings().openModels || {};
  if (role === 'student' && requestedModel !== config.defaultModelId && openModels[requestedModel] !== true) {
    return sendJson(res, 403, { error: '该实验模型尚未由教师开放' });
  }
  if (role === 'teacher') {
    if (String(body.teacherCode || '') !== config.teacherCode) {
      return sendJson(res, 403, { error: '教师口令不正确' });
    }
    const teacherKey = teacherSessionKey(requestedModel);
    const old = enginesByKey.get(teacherKey);
    if (old) old.stop();
    if (old) await waitForClosed(old);
    const engine = new EngineSession(teacherEngineOptions(requestedModel));
    attachEngine(engine);
    enginesByKey.set(teacherKey, engine);
    await engine.start();

    const token = makeToken();
    const auth = {
      token,
      role: 'teacher',
      classId: TEACHER_CLASS_ID,
      sessionKey: teacherKey,
      studentId: TEACHER_STUDENT_ID,
      name: '教师演示',
      className: '教学演示',
      modelId: requestedModel,
      createdAt: Date.now(),
    };
    if (role === 'teacher') {
      // 教师可多网页观察；仅第一个登录可编辑
      let active = 0;
      for (const a of sessionsByToken.values()) {
        if (a.role === 'teacher') active += 1;
      }
      auth.viewOnly = active >= 1;
    }
    sessionsByToken.set(token, auth);
    res.setHeader('Set-Cookie', authCookie(token));
    return sendJson(res, 200, {
      role: 'teacher',
      model: requestedModel,
      classId: TEACHER_CLASS_ID,
      studentId: TEACHER_STUDENT_ID,
      name: auth.name,
      className: auth.className,
      viewOnly: !!auth.viewOnly,
      state: engine.lastState,
    });
  }

  const classCode = normalizeClassCode(body.classCode);
  const studentId = normalizeStudentId(body.studentId);
  const name = cleanText(body.name, 80);
  if (!classCode || !studentId || !name) {
    return sendJson(res, 400, { error: '请输入班级码、学号和姓名' });
  }

  const classInfo = roster.findClassByCode(classCode);
  if (!classInfo) return sendJson(res, 403, { error: '班级码不正确' });
  if (!classInfo.enabled) return sendJson(res, 403, { error: '该班级已停用' });

  const student = classInfo.students.find((item) => item.studentId === studentId);
  if (!student) return sendJson(res, 403, { error: '该学号不在班级名单中' });
  if (!student.enabled) return sendJson(res, 403, { error: '该学生账号已停用' });
  if (student.name !== name) return sendJson(res, 403, { error: '姓名与班级名单不一致' });

  const modelId = requestedModel;
  const key = sessionKeyFor(classInfo.id, studentId, modelId);
  const studentSessionCount = Array.from(enginesByKey.values())
    .filter((engine) => engine.ownerRole !== 'teacher').length;
  if (studentSessionCount >= config.maxSessions && !enginesByKey.has(key)) {
    return sendJson(res, 503, { error: '当前在线人数已达服务器上限' });
  }

  // 一账号同时只允许一个模型、一处登录：已在线则拒绝新登录，不顶掉旧会话
  if (studentHasLiveSession(classInfo.id, studentId)) {
    return sendJson(res, 403, { error: '该账号已登录，请先退出或关闭其它页面后再登录' });
  }
  const old = enginesByKey.get(key);
  if (old) {
    try { await saveStudentRecovery(old, 'forced-exit-before-login'); } catch (err) { console.error(`snapshot before relogin failed: ${err.message}`); }
    stopEngine(old, true);
  }
  const engine = new EngineSession(studentEngineOptions(classInfo, studentId, student.name, key, modelId));
  attachEngine(engine);
  enginesByKey.set(key, engine);
  await engine.start();
  applyScoreConfigToEngine(engine, scoreConfigFromSettings(), { applyInitTemp: true }).catch(() => {});

  const token = makeToken();
  const auth = {
    token,
    role: 'student',
    classId: classInfo.id,
    sessionKey: key,
    studentId,
    name: student.name,
    className: classInfo.name,
    modelId,
    createdAt: Date.now(),
  };
  sessionsByToken.set(token, auth);
  res.setHeader('Set-Cookie', authCookie(token));
  return sendJson(res, 200, {
    role: 'student',
    model: modelId,
    classId: classInfo.id,
    studentId,
    name: student.name,
    className: classInfo.name,
    state: engine.lastState,
  });
}

async function handleCommand(req, res, auth, body, options = {}) {
  const cmd = String(body.cmd || '').trim();
  const engine = options.studentTarget
    ? enginesByKey.get(sessionKeyFor(body.classId, body.studentId, auth.modelId))
    : engineForAuth(auth);
  if (!engine) return sendJson(res, 404, { error: '没有正在运行的会话' });
  const commandPattern = new RegExp('^[A-Z_]+(?: (?:[A-Za-z_]+|[0-9eE+.-]+))*$');
  if (!commandPattern.test(cmd)) {
    return sendJson(res, 400, { error: '非法控制命令' });
  }
  try {
    const state = await engine.send(cmd);
    return sendJson(res, 200, { ok: true, state });
  } catch (err) {
    if (err.code) {
      return sendJson(res, 400, { ok: false, code: err.code, error: err.message || '控制命令被拒绝' });
    }
    return sendJson(res, 500, { ok: false, error: err.message || '控制命令失败' });
  }
}

function studentProjectStatus(auth) {
  return {
    settings: snapshots.getSettings(),
    slots: storeFor(auth.modelId).listProjects(auth.classId, auth.studentId),
    current: storeFor(auth.modelId).getCurrent(auth.classId, auth.studentId)?.meta || null,
    recovery: storeFor(auth.modelId).getRecovery(auth.classId, auth.studentId)?.meta || null,
    projectSlots: PROJECT_SLOTS,
  };
}

async function restoreStudentProject(auth, slot, reason = 'restore-project') {
  const project = storeFor(auth.modelId).getProject(auth.classId, auth.studentId, slot);
  if (!project) throw Object.assign(new Error('该云端方案还没有保存内容'), { statusCode: 404 });
  const classInfo = roster.findClassById(auth.classId);
  if (!classInfo) throw Object.assign(new Error('班级不存在'), { statusCode: 404 });
  const old = enginesByKey.get(auth.sessionKey);
  stopEngine(old, true);
  const options = studentEngineOptions(classInfo, auth.studentId, auth.name, auth.sessionKey, auth.modelId);
  storeFor(auth.modelId).copyProjectToEngine(project, options);
  const engine = new EngineSession(options);
  attachEngine(engine);
  enginesByKey.set(auth.sessionKey, engine);
  await engine.start();
  await engine.send('DEACTIVATE', 4000);
  return { state: engine.lastState, history: engine.history, project: project.meta, reason };
}

async function restoreStudentRecovery(auth) {
  const recovery = storeFor(auth.modelId).getRecovery(auth.classId, auth.studentId);
  if (!recovery) throw Object.assign(new Error('没有可恢复的自动保存记录'), { statusCode: 404 });
  const classInfo = roster.findClassById(auth.classId);
  if (!classInfo) throw Object.assign(new Error('班级不存在'), { statusCode: 404 });
  const old = enginesByKey.get(auth.sessionKey);
  stopEngine(old, true);
  const options = studentEngineOptions(classInfo, auth.studentId, auth.name, auth.sessionKey, auth.modelId);
  storeFor(auth.modelId).copyProjectToEngine(recovery, options);
  const engine = new EngineSession(options);
  attachEngine(engine);
  enginesByKey.set(auth.sessionKey, engine);
  await engine.start();
  await engine.send('DEACTIVATE', 4000);
  return { state: engine.lastState, history: engine.history, recovery: recovery.meta };
}

async function restoreOwnCurrent(auth) {
  const current = storeFor(auth.modelId).getCurrent(auth.classId, auth.studentId);
  if (!current) throw Object.assign(new Error('还没有保存当前状态'), { statusCode: 404 });
  if (auth.role === 'teacher') {
    const store = storeFor(auth.modelId);
    const old = enginesByKey.get(teacherSessionKey(auth.modelId));
    if (!old) throw Object.assign(new Error('教师仿真会话不存在，请重新登录'), { statusCode: 404 });
    await old.send('SAVE', 4000);
    store.saveTeacherBackup(old, 'before-restore-current');
    stopEngine(old);
    await waitForClosed(old);
    const options = teacherEngineOptions(auth.modelId);
    storeFor(auth.modelId).copyProjectToEngine(current, options);
    const engine = new EngineSession(options);
    attachEngine(engine);
    enginesByKey.set(teacherSessionKey(auth.modelId), engine);
    await engine.start();
    await engine.send('DEACTIVATE', 4000);
    return { state: engine.lastState, history: engine.history, current: current.meta };
  }
  const classInfo = roster.findClassById(auth.classId);
  if (!classInfo) throw Object.assign(new Error('班级不存在'), { statusCode: 404 });
  const old = enginesByKey.get(auth.sessionKey);
  stopEngine(old, true);
  const options = studentEngineOptions(classInfo, auth.studentId, auth.name, auth.sessionKey, auth.modelId);
  storeFor(auth.modelId).copyProjectToEngine(current, options);
  const engine = new EngineSession(options);
  attachEngine(engine);
  enginesByKey.set(auth.sessionKey, engine);
  await engine.start();
  await engine.send('DEACTIVATE', 4000);
  return { state: engine.lastState, history: engine.history, current: current.meta };
}

// 教师端跨模型：按需为某个模型起教师仿真会话。
// 登录时只起「登录模型」的引擎，另一个模型在第一次用到时再起，避免白占内核进程。
async function ensureTeacherEngine(modelId) {
  const key = teacherSessionKey(modelId);
  const existing = enginesByKey.get(key);
  if (existing && existing.child && !existing.closed) return existing;
  const engine = new EngineSession(teacherEngineOptions(modelId));
  attachEngine(engine);
  enginesByKey.set(key, engine);
  await engine.start();
  applyScoreConfigToEngine(engine, scoreConfigFromSettings(), { applyInitTemp: true }).catch(() => {});
  return engine;
}

async function loadTeacherProject(classId, studentId, slot, modelId = config.defaultModelId) {
  const store = storeFor(modelId);
  const project = store.getProject(classId, studentId, slot);
  if (!project) throw Object.assign(new Error('该学生这个云端方案还没有保存内容'), { statusCode: 404 });
  const key = teacherSessionKey(modelId);
  let backup = null;
  const old = enginesByKey.get(key);
  if (old) {
    await old.send('SAVE', 4000);
    backup = store.saveTeacherBackup(old, 'before-load-student');
    stopEngine(old);
    await waitForClosed(old);
  }
  const options = teacherEngineOptions(modelId);
  store.copyProjectToEngine(project, options);
  const engine = new EngineSession(options);
  attachEngine(engine);
  enginesByKey.set(key, engine);
  await engine.start();
  await engine.send('DEACTIVATE', 4000);
  return { state: engine.lastState, history: engine.history, project: project.meta, backup };
}

async function restoreTeacherBackup(modelId = config.defaultModelId) {
  const store = storeFor(modelId);
  const backup = store.getTeacherBackup();
  if (!backup) throw Object.assign(new Error('没有可恢复的教师备份'), { statusCode: 404 });
  const old = enginesByKey.get(teacherSessionKey(modelId));
  // 跨模型看板下该模型的教师引擎可能还没起，没有旧引擎就直接恢复。
  if (old) {
    stopEngine(old);
    await waitForClosed(old);
  }
  const options = teacherEngineOptions(modelId);
  store.copyTeacherBackupToEngine(backup, options);
  const engine = new EngineSession(options);
  attachEngine(engine);
  enginesByKey.set(teacherSessionKey(modelId), engine);
  await engine.start();
  await engine.send('DEACTIVATE', 4000);
  return { state: engine.lastState, history: engine.history, backup: backup.meta };
}

async function restoreOwnProject(auth, slot) {
  if (auth.role === 'teacher') return loadTeacherProject(TEACHER_CLASS_ID, TEACHER_STUDENT_ID, slot, auth.modelId);
  return restoreStudentProject(auth, slot);
}

function cloudProjectParams(project) {
  if (!project) return {};
  const payload = readJson(project.params, null);
  return payload && typeof payload === 'object' ? payload : {};
}

function cloudProjectState(project) {
  const params = cloudProjectParams(project);
  return params.state && typeof params.state === 'object' ? params.state : {};
}

function cloudProjectSummary(project) {
  const params = cloudProjectParams(project);
  return params.summary && typeof params.summary === 'object' ? params.summary : (project?.meta || {});
}

function projectNumber(value, digits = 3) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue.toFixed(digits) : '';
}

function projectTiText(value) {
  const numberValue = Number(value);
  return value === null || value === undefined || !Number.isFinite(numberValue) || numberValue < 0 ? 'inf' : numberValue.toFixed(1);
}

// 位号名按模型解析：三级液位是 LI/FI/FV，换热器是 TI/FI/FV110x。
function projectPvName(value, modelId = config.defaultModelId) {
  const names = modelExportSpec(modelId).pvNames || [];
  return names[Number(value)] || `PV${value}`;
}

function projectMvName(value, modelId = config.defaultModelId) {
  const names = modelExportSpec(modelId).mvNames || [];
  return names[Number(value)] || `FV${value}`;
}

// 执行器当前由谁驱动：串级 > 回路 > 手操/未用。与教师端参数面板同一口径。
function projectDriverMap(state) {
  const drivers = new Map();
  (Array.isArray(state.cascades) ? state.cascades : []).forEach((cascade) => {
    drivers.set(Number(cascade.mv), '串级');
  });
  (Array.isArray(state.loops) ? state.loops : []).forEach((loop) => {
    const mv = Number(loop.mv);
    if (!drivers.has(mv)) drivers.set(mv, loop.manual ? '回路手动' : '回路自动');
  });
  return drivers;
}

function cloudProjectParameterRows(project, modelId = config.defaultModelId) {
  const spec = modelExportSpec(modelId);
  const state = cloudProjectState(project);
  const meta = project?.meta || {};
  const rows = [
    ['系统状态'],
    ['项目', '数值'],
    ['实验模型', modelDisplayName(modelId)],
    ['班级', meta.className || project?.meta?.className || ''],
    ['学号', meta.studentId || ''],
    ['姓名', meta.name || ''],
    ['上传时间', meta.savedAt || meta.uploadedAt || ''],
    ['运行状态', state.running ? (state.paused ? '暂停' : '运行中') : '未启动'],
    ['控制方案', Number(state.mode || 0) === 1 ? '串级' : '单回路'],
    ['前馈偏置', state.bias ? '开' : '关'],
    ['仿真时间(s)', projectNumber(state.sim_time, 1)],
  ];
  for (const item of spec.parameters || []) {
    rows.push([item.label, projectNumber(state[item.key], item.digits ?? 3)]);
  }
  rows.push(
    [],
    ['回路与 PID 参数'],
    ['类型', '序号', '被控/主环', '副环/执行', 'PV当前值', 'SP', 'Kp', 'Ti', 'Td', '作用', '控制方式', 'P', 'I', 'D', 'u(t)', '输出', '手动输出'],
  );
  const loops = Array.isArray(state.loops) ? state.loops : [];
  loops.forEach((loop, index) => {
    const sum = Number(loop.pTerm || 0) + Number(loop.iTerm || 0) + Number(loop.dTerm || 0);
    const u = Number(loop.uBias || 0) - Number(loop.action || 1) * sum;
    rows.push(['单回路', index + 1, projectPvName(loop.pv, modelId), projectMvName(loop.mv, modelId), projectNumber(loop.pvValue, 3), projectNumber(loop.sp, 3), projectNumber(loop.kp, 4), projectTiText(loop.ti), projectNumber(loop.td, 2), Number(loop.action) > 0 ? '正作用' : '反作用', loop.manual ? '手动' : '自动', projectNumber(loop.pTerm, 4), projectNumber(loop.iTerm, 4), projectNumber(loop.dTerm, 4), projectNumber(u, 4), projectNumber(loop.out, 3), projectNumber(loop.manualOut, 3)]);
  });
  const cascades = Array.isArray(state.cascades) ? state.cascades : [];
  cascades.forEach((cascade, index) => {
    rows.push(['串级主环', index + 1, projectPvName(cascade.outer, modelId), projectPvName(cascade.inner, modelId), projectNumber(cascade.outerPvValue, 3), projectNumber(cascade.outerSp, 3), projectNumber(cascade.outerKp, 4), projectTiText(cascade.outerTi), projectNumber(cascade.outerTd, 2), Number(cascade.outerAction) > 0 ? '正作用' : '反作用', cascade.outerManual ? '手动' : '自动', projectNumber(cascade.outerP, 4), projectNumber(cascade.outerI, 4), projectNumber(cascade.outerD, 4), '', projectNumber(cascade.outerOut, 3), '']);
    rows.push(['串级副环', index + 1, projectPvName(cascade.inner, modelId), projectMvName(cascade.mv, modelId), projectNumber(cascade.innerPvValue, 3), projectNumber(cascade.outerOut, 3), projectNumber(cascade.innerKp, 4), projectTiText(cascade.innerTi), projectNumber(cascade.innerTd, 2), Number(cascade.innerAction) > 0 ? '正作用' : '反作用', cascade.innerManual ? '手动' : '自动', projectNumber(cascade.innerP, 4), projectNumber(cascade.innerI, 4), projectNumber(cascade.innerD, 4), '', projectNumber(cascade.innerOut, 3), '']);
  });
  rows.push([], ['执行器状态'], ['位号', '实际开度(%)', '指令开度(%)', '控制方式']);
  const drivers = projectDriverMap(state);
  for (const item of spec.actuators || []) {
    const actual = Number(state[item.key] || 0);
    const command = item.cmdKey ? state[item.cmdKey] : state[item.key];
    const mv = item.mv;
    const driver = mv === null || mv === undefined
      ? (actual > 0.5 ? '手操' : '未用')
      : (drivers.get(Number(mv)) || (actual > 0.5 ? '手操' : '未用'));
    rows.push([item.label, projectNumber(actual, 3), projectNumber(command, 3), driver]);
  }
  return rows;
}

function cloudProjectParameterCsv(project, modelId = config.defaultModelId) {
  return `${BOM}${cloudProjectParameterRows(project, modelId).map((row) => row.map(csvCell).join(',')).join(LF)}${LF}`;
}

function cloudProjectAssetStatus(project) {
  const imageFlags = project?.meta?.imageFlags || {};
  return {
    params: !!project && fs.existsSync(project.params),
    curveView: !!project && fs.existsSync(project.curveView),
    level: !!project && fs.existsSync(project.images.level) && imageFlags.level !== false,
    flow: !!project && fs.existsSync(project.images.flow) && imageFlags.flow !== false,
    valve: !!project && fs.existsSync(project.images.valve) && imageFlags.valve !== false,
  };
}

function cloudStudentFolder(index, student) {
  const id = safeId(student.studentId || 'student');
  const name = safeId(student.name || 'name');
  return `${String(index + 1).padStart(3, '0')}_${id}_${name}`;
}

function cloudExportStateText(project, assets, modelId = config.defaultModelId) {
  if (!project) return '未上传云端方案 1，未生成参数或曲线图片。';
  const labels = modelExportSpec(modelId).curveLabels || {};
  const missing = [];
  if (!assets.params) missing.push('参数快照');
  if (!assets.level) missing.push(`${labels.level || '曲线'}图片`);
  if (!assets.flow) missing.push(`${labels.flow || '流量曲线'}图片`);
  if (!assets.valve) missing.push(`${labels.valve || '开度曲线'}图片`);
  return missing.length
    ? `已上传云端方案 1，但缺少：${missing.join('、')}。请学生重新上传云端。`
    : '云端方案 1 的参数与三张曲线图片完整。';
}

// 单个模型的云端导出包。文件名、表头、参数列全部取自该模型的 ModelSpec。
function buildModelCloudExport(classInfo, students, modelId) {
  const modelName = modelDisplayName(modelId);
  const spec = modelExportSpec(modelId);
  const curveLabels = spec.curveLabels || {};
  const levelLabel = curveLabels.level || '曲线';
  const flowLabel = curveLabels.flow || '流量曲线';
  const valveLabel = curveLabels.valve || '开度曲线';
  const entries = [];
  const summaryRows = [[
    '班级', '实验模型', '学号', '姓名', '上传时间', '仿真时间(s)',
    ...(spec.parameters || []).map((item) => item.label),
    '回路数', '评分', '参数快照', `${levelLabel}图片`, `${flowLabel}图片`, `${valveLabel}图片`, '备注',
  ]];
  const manifestRows = [['序号', '文件夹', '实验模型', '学号', '姓名', '状态']];
  let uploadedCount = 0;
  let completeCount = 0;

  students.forEach((student, index) => {
    const project = storeFor(modelId).getProject(classInfo.id, student.studentId, 1);
    const summary = cloudProjectSummary(project);
    const assets = cloudProjectAssetStatus(project);
    const folder = cloudStudentFolder(index, student);
    const uploaded = !!project;
    const complete = !!(assets.params && assets.level && assets.flow && assets.valve);
    if (uploaded) uploadedCount += 1;
    if (complete) completeCount += 1;

    summaryRows.push([
      classInfo.name,
      modelName,
      student.studentId,
      student.name,
      project?.meta?.savedAt || project?.meta?.uploadedAt || '',
      projectNumber(summary.simTime ?? summary.sim_time, 1),
      ...(spec.parameters || []).map((item) => projectNumber(summary[item.key], item.digits ?? 3)),
      projectNumber(summary.loops, 0),
      projectNumber(summary.scoreTotal, 1),
      assets.params ? '有' : '缺',
      assets.level ? '有' : '缺',
      assets.flow ? '有' : '缺',
      assets.valve ? '有' : '缺',
      uploaded ? (complete ? '完整' : '请学生重新上传') : '未上传云端',
    ]);
    manifestRows.push([index + 1, folder, modelName, student.studentId, student.name, uploaded ? (complete ? '完整导出' : '缺少参数或图片') : '未上传']);

    if (!uploaded) return;
    const base = `students/${folder}`;
    if (assets.params) entries.push({ name: `${base}/参数.csv`, data: cloudProjectParameterCsv(project, modelId) });
    if (assets.level) entries.push({ name: `${base}/${levelLabel}.png`, data: fs.readFileSync(project.images.level), compress: false });
    if (assets.flow) entries.push({ name: `${base}/${flowLabel}.png`, data: fs.readFileSync(project.images.flow), compress: false });
    if (assets.valve) entries.push({ name: `${base}/${valveLabel}.png`, data: fs.readFileSync(project.images.valve), compress: false });
    entries.push({ name: `${base}/导出状态.txt`, data: `${cloudExportStateText(project, assets, modelId)}${LF}` });
  });

  const summaryText = `${BOM}${summaryRows.map((row) => row.map(csvCell).join(',')).join(LF)}${LF}`;
  const manifestText = `${BOM}${manifestRows.map((row) => row.map(csvCell).join(',')).join(LF)}${LF}`;
  const readme = [
    `实验模型：${modelName}`,
    `班级：${classInfo.name}`,
    `导出时间：${new Date().toLocaleString()}`,
    `导出学生数：${students.length}`,
    `已上传云端方案 1：${uploadedCount}`,
    `参数与三张图片完整：${completeCount}`,
    `曲线图片：${levelLabel} / ${flowLabel} / ${valveLabel}`,
    '说明：只导出学生已上传到云端方案 1 的内容；不读取在线状态，也不从实时曲线临时生成图片。',
  ].join(LF) + LF;
  entries.unshift(
    { name: '班级参数汇总.csv', data: summaryText },
    { name: '导出清单.csv', data: manifestText },
    { name: '导出说明.txt', data: `${BOM}${readme}` },
  );
  return { entries, uploadedCount, completeCount };
}

// 教师云端导出入口。modelId 可以是单个模型，也可以是 'all'。
// 'all' 时按模型分子文件夹，每个模型各带一份汇总/清单/说明，互不混用。
function buildTeacherCloudExport(classInfo, students, modelId = config.defaultModelId) {
  const ids = resolveModelIds(modelId);
  const multi = ids.length > 1;
  const entries = [];
  let uploadedCount = 0;
  let completeCount = 0;
  const modelNames = [];
  for (const id of ids) {
    const part = buildModelCloudExport(classInfo, students, id);
    uploadedCount += part.uploadedCount;
    completeCount += part.completeCount;
    modelNames.push(modelDisplayName(id));
    if (!multi) entries.push(...part.entries);
    else entries.push(...part.entries.map((entry) => ({ ...entry, name: `${modelDisplayName(id)}/${entry.name}` })));
  }
  if (multi) {
    const readme = [
      `班级：${classInfo.name}`,
      `实验模型：${modelNames.join(' + ')}`,
      `导出时间：${new Date().toLocaleString()}`,
      `导出学生数：${students.length}`,
      `已上传云端方案 1 合计：${uploadedCount}`,
      '说明：本次导出包含多个模型，每个模型一个子文件夹，方案与图片互不混用。',
    ].join(LF) + LF;
    entries.unshift({ name: '导出说明.txt', data: `${BOM}${readme}` });
  }
  return { buffer: buildZip(entries), uploadedCount, completeCount, modelNames };
}
async function mainHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const parts = pathname.split('/').filter(Boolean);

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        online: visibleSessions().length,
        uptime: Math.round(process.uptime()),
        engine: path.basename(config.enginePath),
      });
    }
    if (req.method === 'GET' && pathname === '/api/model/list') {
      const settings = snapshots.getSettings();
      const open = settings.openModels || {};
      const models = [{ id: 'tank', name: '三级液位', open: open.tank !== false }];
      models.push({ id: 'hx', name: '换热器', open: open.hx === true });
      return sendJson(res, 200, { models });
    }
    if (req.method === 'POST' && pathname === '/api/login') {
      return await login(req, res, await readBody(req));
    }
    if (req.method === 'POST' && pathname === '/api/logout') {
      const auth = authOf(req);
      if (auth) {
        sessionsByToken.delete(auth.token);
        if (auth.role === 'student' || auth.role === 'teacher') {
          const engine = engineForAuth(auth);
          if (auth.role === 'student' && engine) {
            try { await saveStudentRecovery(engine, 'logout'); } catch (err) { console.error(`snapshot on logout failed: ${err.message}`); }
          }
          stopEngine(engine, auth.role === 'student');
          enginesByKey.delete(auth.sessionKey);
          studentStreams.delete(auth.sessionKey);
        }
      }
      res.setHeader('Set-Cookie', 'yun_token=; Max-Age=0; Path=/');
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/me') {
      const auth = authOf(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      return sendJson(res, 200, {
        role: auth.role,
        model: auth.modelId || config.defaultModelId,
        classId: auth.classId,
        studentId: auth.studentId,
        name: auth.name,
        className: auth.className,
        viewOnly: !!auth.viewOnly,
      });
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      const engine = engineForAuth(auth);
      if (!engine) return sendJson(res, 404, { error: '会话不存在' });
      return sendJson(res, 200, publicStudentState(engine));
    }
    if (req.method === 'GET' && pathname === '/api/history') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      const engine = engineForAuth(auth);
      if (!engine) return sendJson(res, 404, { error: '会话不存在' });
      return sendJson(res, 200, { history: engine.history });
    }
    if (req.method === 'POST' && pathname === '/api/curve-clear') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      const engine = engineForAuth(auth);
      if (!engine) return sendJson(res, 404, { error: '会话不存在' });
      engine.clearHistory();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/score-record') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      for (let i = recordCache.length - 1; i >= 0; i--) {
        const record = recordCache[i];
        if (record.ownerRole !== 'teacher' && record.classId === auth.classId && record.studentId === auth.studentId
          && recordModel(record) === (auth.modelId || config.defaultModelId)) {
          return sendJson(res, 200, { record });
        }
      }
      return sendJson(res, 200, { record: null });
    }
    if (req.method === 'POST' && pathname === '/api/command') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      return await handleCommand(req, res, auth, await readBody(req));
    }
    if (req.method === 'GET' && pathname === '/api/stream') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`event: hello${LF}data: ${JSON.stringify({ ok: true })}${LF}${LF}`);
      res.write(`event: settings${LF}data: ${JSON.stringify(snapshots.getSettings())}${LF}${LF}`);
      if (!studentStreams.has(auth.sessionKey)) studentStreams.set(auth.sessionKey, new Set());
      studentStreams.get(auth.sessionKey).add(res);
      const engine = engineForAuth(auth);
      if (engine?.lastState) {
        res.write(`event: state${LF}data: ${JSON.stringify(engine.lastState)}${LF}${LF}`);
      }
      req.on('close', () => studentStreams.get(auth.sessionKey)?.delete(res));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/projects') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      return sendJson(res, 200, studentProjectStatus(auth));
    }
    if (req.method === 'POST' && pathname === '/api/current/save') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      const engine = engineForAuth(auth);
      const current = await saveCurrentSnapshot(engine, 'manual-current');
      return sendJson(res, 200, { ok: true, current, slots: storeFor(auth.modelId).listProjects(auth.classId, auth.studentId) });
    }
    if (req.method === 'POST' && pathname === '/api/current/restore') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      const result = await restoreOwnCurrent(auth);
      return sendJson(res, 200, { ok: true, ...result, slots: storeFor(auth.modelId).listProjects(auth.classId, auth.studentId) });
    }
    if (req.method === 'GET' && pathname === '/api/current/export') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      if (auth.role === 'student') return sendJson(res, 403, { error: '学生端不提供工程导出' });
      const current = storeFor(auth.modelId).currentPackage(auth.classId, auth.studentId);
      const name = `${auth.studentId || 'current'}-current`;
      return sendProjectDownload(res, name, current);
    }
    if (req.method === 'POST' && pathname === '/api/current/import') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      const engine = engineForAuth(auth);
      const body = await readBody(req, 8 * 1024 * 1024);
      const current = storeFor(auth.modelId).importProjectToCurrent(body.project, engine, 'imported-current');
      const result = await restoreOwnCurrent(auth);
      return sendJson(res, 200, { ok: true, current, ...result, slots: storeFor(auth.modelId).listProjects(auth.classId, auth.studentId) });
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'projects' && parts.length === 4 && parts[3] === 'save') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      const engine = engineForAuth(auth);
      const body = await readBody(req, CLOUD_UPLOAD_BODY_LIMIT);
      const assets = body && body.assets && typeof body.assets === 'object' ? body.assets : {};
      const slotN = Number(parts[2]);
      const project = await saveProjectSnapshot(engine, slotN, 'manual', slotN === 1, assets);
      return sendJson(res, 200, { ok: true, project, slots: storeFor(auth.modelId).listProjects(auth.classId, auth.studentId) });
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'projects' && parts.length === 4 && parts[3] === 'restore') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      const result = await restoreOwnProject(auth, parts[2]);
      return sendJson(res, 200, { ok: true, ...result, slots: storeFor(auth.modelId).listProjects(auth.classId, auth.studentId) });
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts.length === 4 && parts[3] === 'export') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      if (auth.role === 'student') return sendJson(res, 403, { error: '学生端不提供云端工程导出' });
      const project = storeFor(auth.modelId).projectPackage(auth.classId, auth.studentId, parts[2]);
      const name = `${auth.studentId || 'project'}-slot${parts[2]}`;
      return sendProjectDownload(res, name, project);
    }
    if (req.method === 'POST' && pathname === '/api/projects/import') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      const engine = engineForAuth(auth);
      const body = await readBody(req, 8 * 1024 * 1024);
      const project = await storeFor(auth.modelId).importProjectToSlot(body.project, engine, body.slot || 1, 'imported');
      const result = await restoreOwnProject(auth, project.slot);
      return sendJson(res, 200, { ok: true, project, ...result, slots: storeFor(auth.modelId).listProjects(auth.classId, auth.studentId) });
    }
    if (req.method === 'POST' && pathname === '/api/recovery/restore') {
      const auth = requireSimulationRole(req, res);
      if (!auth) return;
      if (auth.role === 'teacher') {
        const result = await restoreTeacherBackup(auth.modelId);
        return sendJson(res, 200, { ok: true, ...result });
      }
      const result = await restoreStudentRecovery(auth);
      return sendJson(res, 200, { ok: true, ...result, slots: storeFor(auth.modelId).listProjects(auth.classId, auth.studentId) });
    }
    if (req.method === 'GET' && pathname === '/api/student/cloud-status') {
      const auth = requireRole(req, res, 'student');
      if (!auth) return;
      return sendJson(res, 200, studentProjectStatus(auth));
    }
    if (req.method === 'POST' && pathname === '/api/student/submit') {
      const auth = requireRole(req, res, 'student');
      if (!auth) return;
      const engine = engineForAuth(auth);
      const body = await readBody(req, CLOUD_UPLOAD_BODY_LIMIT);
      const slot = Number(body.slot) || 2; // 默认云端2；1=导出云端
      const project = await saveProjectSnapshot(engine, slot, 'manual', slot === 1, body.assets || {});
      return sendJson(res, 200, { ok: true, project, submission: project, slot });
    }
    if (req.method === 'POST' && pathname === '/api/student/auto-save') {
      const auth = requireRole(req, res, 'student');
      if (!auth) return;
      const engine = engineForAuth(auth);
      const recovery = await saveStudentRecovery(engine, 'forced-exit');
      return sendJson(res, 200, { ok: true, recovery });
    }
    if (req.method === 'POST' && pathname === '/api/student/restore') {
      const auth = requireRole(req, res, 'student');
      if (!auth) return;
      const body0 = await readBody(req);
      const slot0 = Number(body0?.slot) || 2; // 默认云端2（学生自由上传槽）
      const result = await restoreStudentProject(auth, slot0, 'restore-legacy');
      return sendJson(res, 200, { ok: true, ...result, slot: slot0 });
    }

    const teacherBase = parts[0] === 'api' && parts[1] === 'teacher';

    if (req.method === 'GET' && teacherBase && parts.length === 3 && parts[2] === 'classes') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      return sendJson(res, 200, { classes: roster.listClasses() });
    }
    if (req.method === 'POST' && teacherBase && parts.length === 3 && parts[2] === 'classes') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      return sendJson(res, 200, { class: roster.createClass(await readBody(req)) });
    }

    if (teacherBase && parts[2] === 'classes' && parts.length === 4) {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const classId = parts[3];
      if (req.method === 'PUT') {
        const before = roster.findClassById(classId);
        const updated = roster.updateClass(classId, await readBody(req));
        if (before?.enabled && updated.enabled === false) stopClassEngines(classId);
        return sendJson(res, 200, { class: updated });
      }
      if (req.method === 'DELETE') {
        stopClassEngines(classId);
        return sendJson(res, 200, { class: roster.deleteClass(classId) });
      }
    }

    if (teacherBase && parts[2] === 'classes' && parts[4] === 'students') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const classId = parts[3];
      const studentId = parts[5] ? normalizeStudentId(parts[5]) : '';
      if (req.method === 'GET' && !studentId && parts.length === 5) {
        const classInfo = roster.findClassById(classId);
        if (!classInfo) return sendJson(res, 404, { error: '班级不存在' });
        return sendJson(res, 200, { students: classInfo.students });
      }
      if (req.method === 'POST' && !studentId && parts.length === 5) {
        return sendJson(res, 200, { student: roster.addStudent(classId, await readBody(req)) });
      }
      if (req.method === 'PUT' && studentId && parts.length === 6) {
        const result = roster.updateStudent(classId, studentId, await readBody(req));
        if (result.previousStudentId !== result.student.studentId || result.student.enabled === false) {
          stopStudentEngine(classId, result.previousStudentId);
        }
        return sendJson(res, 200, { student: result.student });
      }
      if (req.method === 'DELETE' && studentId && parts.length === 6) {
        const removed = roster.deleteStudent(classId, studentId);
        stopStudentEngine(classId, studentId);
        return sendJson(res, 200, { student: removed });
      }
    }

    if (req.method === 'POST' && teacherBase && parts[2] === 'classes' && parts[4] === 'import') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const body = await readBody(req, 2 * 1024 * 1024);
      const result = roster.importStudents(parts[3], body.rows, body.mode);
      stopClassEngines(parts[3]);
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && teacherBase && parts[2] === 'classes' && parts[4] === 'export.csv') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      return sendText(res, 200, rosterCsv(parts[3]), 'text/csv; charset=utf-8');
    }

    if (req.method === 'GET' && teacherBase && parts.length === 3 && parts[2] === 'overview') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const modelId = url.searchParams.get('model') || auth.modelId || config.defaultModelId;
      return sendJson(res, 200, overview(url.searchParams.get('classId') || '', modelId));
    }
    if (req.method === 'GET' && teacherBase && parts.length === 3 && parts[2] === 'submissions') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const classId = url.searchParams.get('classId') || '';
      const modelIds = resolveModelIds(url.searchParams.get('model') || auth.modelId || config.defaultModelId);
      const submissions = [];
      let backup = null;
      for (const modelId of modelIds) {
        const store = storeFor(modelId);
        submissions.push(...store.listSubmissions(classId));
        const candidate = store.getTeacherBackup();
        if (!candidate) continue;
        const meta = { ...candidate.meta, modelId };
        if (!backup || String(meta.backedUpAt || '') > String(backup.backedUpAt || '')) backup = meta;
      }
      submissions.sort((a, b) => String(b.savedAt || b.uploadedAt || '').localeCompare(String(a.savedAt || a.uploadedAt || '')));
      return sendJson(res, 200, {
        settings: snapshots.getSettings(),
        submissions,
        projects: submissions,
        projectSlots: PROJECT_SLOTS,
        backup,
      });
    }
    if (req.method === 'POST' && teacherBase && parts.length === 3 && parts[2] === 'cloud-export') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const body = await readBody(req);
      const classId = String(body.classId || '');
      const classInfo = roster.findClassById(classId);
      if (!classInfo) return sendJson(res, 404, { error: '班级不存在' });
      const requested = new Set(Array.isArray(body.studentIds) ? body.studentIds.map((value) => normalizeStudentId(value)) : []);
      const students = requested.size
        ? classInfo.students.filter((student) => requested.has(student.studentId))
        : classInfo.students;
      if (!students.length) return sendJson(res, 400, { error: '请至少选择一名学生' });
      const requestedModel = String(body.model || config.defaultModelId);
      const result = buildTeacherCloudExport(classInfo, students, requestedModel);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const modelLabel = resolveModelIds(requestedModel).length > 1
        ? '全部模型'
        : modelDisplayName(requestedModel);
      return sendZipDownload(res, `${classInfo.name}_${modelLabel}_云端导出_${stamp}`, result.buffer);
    }
    if (req.method === 'GET' && teacherBase && parts.length === 3 && parts[2] === 'projects') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const classId = url.searchParams.get('classId') || '';
      const modelIds = resolveModelIds(url.searchParams.get('model') || auth.modelId || config.defaultModelId);
      const projects = modelIds.flatMap((modelId) => storeFor(modelId).listSubmissions(classId));
      return sendJson(res, 200, { projects, projectSlots: PROJECT_SLOTS });
    }
    if (req.method === 'GET' && teacherBase && parts[2] === 'projects' && parts.length === 7 && parts[6] === 'export') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const studentId = normalizeStudentId(parts[4]);
      const slot = parts[5];
      const modelId = url.searchParams.get('model') || config.defaultModelId;
      const project = storeFor(modelId).projectPackage(parts[3], studentId, slot);
      return sendProjectDownload(res, `${modelDisplayName(modelId)}-${studentId}-slot${slot}`, {
        ...project,
        modelId,
        modelName: modelDisplayName(modelId),
      });
    }
    if (req.method === 'POST' && teacherBase && parts.length === 3 && parts[2] === 'load-project') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const body = await readBody(req);
      const modelId = String(body.model || auth.modelId || config.defaultModelId);
      const result = await loadTeacherProject(body.classId, normalizeStudentId(body.studentId), body.slot || 1, modelId);
      // 跨模型读取时把教师会话切到该模型，否则前端读 /api/state 拿到的还是旧引擎。
      auth.modelId = modelId;
      auth.sessionKey = teacherSessionKey(modelId);
      result.modelId = modelId;
      result.modelName = modelDisplayName(modelId);
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (req.method === 'POST' && teacherBase && parts.length === 3 && parts[2] === 'active-model') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const body = await readBody(req);
      const modelId = String(body.model || '');
      if (!MODEL_IDS.includes(modelId)) return sendJson(res, 400, { error: '未知的实验模型' });
      const engine = await ensureTeacherEngine(modelId);
      auth.modelId = modelId;
      auth.sessionKey = teacherSessionKey(modelId);
      return sendJson(res, 200, {
        ok: true,
        model: modelId,
        modelName: modelDisplayName(modelId),
        state: engine.lastState,
        history: engine.history,
      });
    }
    if (req.method === 'POST' && teacherBase && parts.length === 3 && parts[2] === 'settings') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const body = await readBody(req) || {};
      const settings = snapshots.setSettings(body);
      broadcastStudentSettings();
      // 教师点了「应用评分要求」才带 scoreConfig；此时把细则发给全部在线会话。
      // 初始温度只改冷态，避免覆盖学生实验中的 TI1103。
      if (body.scoreConfig && typeof body.scoreConfig === 'object') {
        try {
          await applyScoreConfigToAll(body.scoreConfig, { applyInitTemp: true });
        } catch (err) { console.error(err.message); }
      }
      return sendJson(res, 200, { ok: true, settings });
    }
    if (req.method === 'POST' && teacherBase && parts.length === 3 && parts[2] === 'load-submission') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const body = await readBody(req);
      const result = await loadTeacherProject(body.classId, normalizeStudentId(body.studentId), body.slot || 1, auth.modelId);
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (req.method === 'POST' && teacherBase && parts.length === 3 && parts[2] === 'restore-backup') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const body = await readBody(req).catch(() => ({}));
      const modelId = String(body.model || auth.modelId || config.defaultModelId);
      const result = await restoreTeacherBackup(modelId);
      result.modelId = modelId;
      result.modelName = modelDisplayName(modelId);
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (req.method === 'GET' && teacherBase && parts[2] === 'student' && parts.length === 5) {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const requested = String(url.searchParams.get('model') || auth.modelId || config.defaultModelId);
      const modelId = requested === 'all' || requested === '*' ? auth.modelId : requested;
      const key = sessionKeyFor(parts[3], normalizeStudentId(parts[4]), modelId);
      const engine = enginesByKey.get(key);
      if (!engine) return sendJson(res, 404, { error: '该学生当前不在线' });
      return sendJson(res, 200, publicStudentState(engine));
    }
    if (req.method === 'GET' && teacherBase && parts.length === 3 && parts[2] === 'watch') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const classId = String(url.searchParams.get('classId') || '');
      const studentId = normalizeStudentId(url.searchParams.get('studentId') || '');
      const requested = String(url.searchParams.get('model') || auth.modelId || config.defaultModelId);
      const modelId = requested === 'all' || requested === '*' ? auth.modelId : requested;
      const engine = enginesByKey.get(sessionKeyFor(classId, studentId, modelId));
      if (!engine) return sendJson(res, 404, { error: '该学生当前不在线' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`event: snapshot${LF}data: ${JSON.stringify(publicStudentState(engine))}${LF}${LF}`);
      teacherStudentStreams.set(res, { classId, studentId, modelId });
      req.on('close', () => teacherStudentStreams.delete(res));
      return;
    }
    if (req.method === 'GET' && teacherBase && parts.length === 3 && parts[2] === 'records') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const classId = url.searchParams.get('classId') || '';
      const modelId = url.searchParams.get('model') || auth.modelId || config.defaultModelId;
      const all = modelId === 'all' || modelId === '*';
      const records = recordCache.filter((item) => item.ownerRole !== 'teacher'
        && (!classId || item.classId === classId)
        && (all || recordModel(item) === modelId));
      return sendJson(res, 200, { records });
    }
    if (req.method === 'GET' && teacherBase && parts.length === 3 && parts[2] === 'export.csv') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const modelId = url.searchParams.get('model') || auth.modelId || config.defaultModelId;
      const modelLabel = resolveModelIds(modelId).length > 1 ? '全部模型' : modelDisplayName(modelId);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      return sendText(
        res,
        200,
        recordsCsv(url.searchParams.get('classId') || '', modelId),
        'text/csv; charset=utf-8',
        `评分记录-${modelLabel}-${stamp}.csv`,
      );
    }
    if (req.method === 'POST' && teacherBase && parts.length === 3 && parts[2] === 'clear') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const classId = String((await readBody(req)).classId || '');
      recordCache = classId ? recordCache.filter((item) => item.classId !== classId) : [];
      const text = recordCache.map((item) => JSON.stringify(item)).join(LF);
      fs.writeFileSync(config.recordsFile, text + (text ? LF : ''), 'utf8');
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && teacherBase && parts.length === 3 && parts[2] === 'stream') {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const streamModel = url.searchParams.get('model') || auth.modelId || config.defaultModelId;
      teacherStreams.set(res, streamModel);
      res.write(`event: overview${LF}data: ${JSON.stringify(overview('', streamModel))}${LF}${LF}`);
      req.on('close', () => teacherStreams.delete(res));
      return;
    }
    if (req.method === 'POST' && teacherBase && parts[2] === 'command' && parts.length === 5) {
      const auth = requireRole(req, res, 'teacher');
      if (!auth) return;
      const body = await readBody(req);
      return await handleCommand(req, res, auth, {
        ...body,
        classId: parts[3],
        studentId: normalizeStudentId(parts[4]),
      }, { studentTarget: true });
    }

    return serveStatic(res, pathname);
  } catch (err) {
    console.error(err);
    return sendJson(res, err.statusCode || 500, { error: err.message || '服务器内部错误' });
  }
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (rel.includes('..')) return sendText(res, 403, 'forbidden');
  const file = path.join(config.publicDir, rel);
  const normalized = path.resolve(file);
  if (!normalized.startsWith(path.resolve(config.publicDir))) return sendText(res, 403, 'forbidden');
  fs.readFile(normalized, (err, data) => {
    if (err) return sendText(res, 404, 'not found');
    const ext = path.extname(normalized).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
    }[ext] || 'application/octet-stream';
    sendText(res, 200, data, mime);
  });
}

const server = http.createServer(mainHandler);
server.listen(config.port, '0.0.0.0', () => {
  console.log(`YunLevel server listening on http://0.0.0.0:${config.port}`);
  console.log(`engine: ${config.enginePath}`);
  console.log(`classes: ${roster.listSummaries().length}`);
  console.log('teacher code: ' + (config.teacherCode === 'CHANGE_ME_BEFORE_DEPLOY' ? '[未设置！请设置环境变量 YUN_TEACHER_CODE]' : '[已设置]'));
});

setInterval(() => {
  for (const engine of enginesByKey.values()) {
    const state = engine.lastState;
    if (!state) continue;
    const score = state.score || {};
    const running = !!state.running && !state.paused;
    if (!running && !score.active) continue;
    engine.tick(running ? 1 : 0).catch((err) => {
      console.error(`tick failed for ${engine.classId}/${engine.studentId}: ${err.message}`);
    });
  }
}, 1000).unref?.();

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [token, auth] of sessionsByToken) {
    if (now - auth.createdAt > TOKEN_TTL_MS) sessionsByToken.delete(token);
  }
}, 10 * 60 * 1000).unref?.();

function shutdown() {
  for (const engine of enginesByKey.values()) engine.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
