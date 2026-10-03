const fs = require('fs');
const path = require('path');
const {
  ensureDir,
  hashId,
  readJson,
  writeJsonAtomic,
} = require('./storage');

function copyFile(source, target) {
  if (!source || !target || !fs.existsSync(source)) return false;
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
  return true;
}

function summarizeEngine(engine) {
  const state = engine.lastState || {};
  const score = state.score || {};
  return {
    classId: engine.classId,
    studentId: engine.studentId,
    name: engine.name,
    className: engine.className,
    simTime: Number(state.sim_time || 0),
    running: !!state.running,
    paused: !!state.paused,
    h1: Number(state.h1 || 0),
    h2: Number(state.h2 || 0),
    h3: Number(state.h3 || 0),
    loops: Array.isArray(state.loops) ? state.loops.length : 0,
    cascades: Array.isArray(state.cascades) ? state.cascades.length : 0,
    scoreMode: Number(score.mode || 0),
    scoreTotal: Number(score.total || 0),
  };
}

class SnapshotStore {
  constructor(options) {
    this.settingsFile = options.settingsFile;
    this.submissionsDir = options.submissionsDir;
    this.teacherBackupsDir = options.teacherBackupsDir;
    ensureDir(this.submissionsDir);
    ensureDir(this.teacherBackupsDir);
    const saved = readJson(this.settingsFile, {});
    this.settings = {
      allowStudentUpload: saved.allowStudentUpload === true,
      updatedAt: saved.updatedAt || null,
    };
  }

  getSettings() {
    return { ...this.settings };
  }

  setSettings(patch = {}) {
    if (Object.prototype.hasOwnProperty.call(patch, 'allowStudentUpload')) {
      this.settings.allowStudentUpload = patch.allowStudentUpload === true;
    }
    this.settings.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.settingsFile, this.settings);
    return this.getSettings();
  }

  submissionDir(classId, studentId) {
    return path.join(this.submissionsDir, hashId(classId), hashId(studentId));
  }

  submissionFiles(classId, studentId) {
    const dir = this.submissionDir(classId, studentId);
    return {
      dir,
      state: path.join(dir, 'state.bin'),
      history: path.join(dir, 'history.json'),
      meta: path.join(dir, 'meta.json'),
    };
  }

  saveSubmission(engine, reason = 'manual') {
    const files = this.submissionFiles(engine.classId, engine.studentId);
    ensureDir(files.dir);
    const stateOk = copyFile(engine.stateFile, files.state);
    engine.saveHistory();
    const historyOk = copyFile(engine.historyFile, files.history);
    if (!stateOk) throw new Error('当前仿真状态文件不存在，无法上传');
    const meta = {
      ...summarizeEngine(engine),
      uploadedAt: new Date().toISOString(),
      reason,
      hasState: true,
      hasHistory: historyOk,
    };
    writeJsonAtomic(files.meta, meta);
    return meta;
  }

  getSubmission(classId, studentId) {
    const files = this.submissionFiles(classId, studentId);
    const meta = readJson(files.meta, null);
    if (!meta || !fs.existsSync(files.state)) return null;
    return { ...files, meta };
  }

  listSubmissions(classId = '') {
    const out = [];
    if (!fs.existsSync(this.submissionsDir)) return out;
    const filter = String(classId || '');
    for (const classHash of fs.readdirSync(this.submissionsDir)) {
      const classDir = path.join(this.submissionsDir, classHash);
      if (!fs.statSync(classDir).isDirectory()) continue;
      for (const studentHash of fs.readdirSync(classDir)) {
        const dir = path.join(classDir, studentHash);
        if (!fs.statSync(dir).isDirectory()) continue;
        const meta = readJson(path.join(dir, 'meta.json'), null);
        if (!meta || (filter && meta.classId !== filter)) continue;
        out.push(meta);
      }
    }
    return out.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  }

  saveTeacherBackup(engine, reason = 'before-load') {
    const dir = path.join(this.teacherBackupsDir, 'latest');
    ensureDir(dir);
    const state = path.join(dir, 'state.bin');
    const history = path.join(dir, 'history.json');
    const metaFile = path.join(dir, 'meta.json');
    const stateOk = copyFile(engine.stateFile, state);
    engine.saveHistory();
    const historyOk = copyFile(engine.historyFile, history);
    if (!stateOk) throw new Error('教师当前仿真状态不存在，无法自动备份');
    const meta = {
      ...summarizeEngine(engine),
      backedUpAt: new Date().toISOString(),
      reason,
      hasState: true,
      hasHistory: historyOk,
    };
    writeJsonAtomic(metaFile, meta);
    return meta;
  }

  getTeacherBackup() {
    const dir = path.join(this.teacherBackupsDir, 'latest');
    const meta = readJson(path.join(dir, 'meta.json'), null);
    if (!meta || !fs.existsSync(path.join(dir, 'state.bin'))) return null;
    return {
      dir,
      state: path.join(dir, 'state.bin'),
      history: path.join(dir, 'history.json'),
      meta,
    };
  }

  copySubmissionToEngine(submission, engine) {
    const copiedState = copyFile(submission.state, engine.stateFile);
    const copiedHistory = copyFile(submission.history, engine.historyFile);
    if (!copiedState) throw new Error('云端状态文件缺失，无法下载');
    return { copiedState, copiedHistory };
  }

  copyTeacherBackupToEngine(backup, engine) {
    const copiedState = copyFile(backup.state, engine.stateFile);
    const copiedHistory = copyFile(backup.history, engine.historyFile);
    if (!copiedState) throw new Error('教师备份状态缺失，无法恢复');
    return { copiedState, copiedHistory };
  }
}

module.exports = { SnapshotStore, summarizeEngine };
