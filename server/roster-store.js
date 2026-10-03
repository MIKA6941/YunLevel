const crypto = require('crypto');
const { ensureDir, readJson, writeJsonAtomic } = require('./storage');

class RosterError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'RosterError';
    this.statusCode = statusCode;
  }
}

function cleanText(value, max = 80) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeClassCode(value) {
  return cleanText(value, 32).toUpperCase();
}

function normalizeStudentId(value) {
  return cleanText(value, 80);
}

function validateClassCode(code) {
  return /^[0-9A-Z_-]{2,32}$/.test(code);
}

function validateStudentId(studentId) {
  return /^[0-9A-Za-z_\-.\u4e00-\u9fff]{1,80}$/.test(studentId);
}

function classId() {
  return `c_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class RosterStore {
  constructor(file, seedClassCode = 'CLASS01') {
    this.file = file;
    this.seedClassCode = normalizeClassCode(seedClassCode) || 'CLASS01';
    this.data = this._load();
    this._seedIfEmpty();
  }

  _load() {
    const raw = readJson(this.file, null);
    if (!raw || !Array.isArray(raw.classes)) {
      return { version: 1, classes: [] };
    }
    const classes = raw.classes.map((item) => ({
      id: cleanText(item.id, 80) || classId(),
      name: cleanText(item.name, 80) || '未命名班级',
      code: normalizeClassCode(item.code),
      enabled: item.enabled !== false,
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
      students: Array.isArray(item.students) ? item.students.map((student) => ({
        studentId: normalizeStudentId(student.studentId),
        name: cleanText(student.name, 80),
        enabled: student.enabled !== false,
        createdAt: student.createdAt || new Date().toISOString(),
        updatedAt: student.updatedAt || student.createdAt || new Date().toISOString(),
      })).filter((student) => student.studentId && student.name) : [],
    }));
    return { version: 1, classes };
  }

  _seedIfEmpty() {
    if (this.data.classes.length > 0) return;
    const now = new Date().toISOString();
    this.data.classes.push({
      id: classId(),
      name: '默认班级',
      code: this.seedClassCode,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      students: [],
    });
    this.save();
  }

  save() {
    ensureDir(require('path').dirname(this.file));
    writeJsonAtomic(this.file, this.data);
  }

  listClasses() {
    return clone(this.data.classes).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  summary(item) {
    return {
      id: item.id,
      name: item.name,
      code: item.code,
      enabled: item.enabled,
      studentCount: item.students.length,
      enabledStudentCount: item.students.filter((student) => student.enabled).length,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  listSummaries() {
    return this.listClasses().map((item) => this.summary(item));
  }

  findClassById(id) {
    return this.data.classes.find((item) => item.id === String(id || '')) || null;
  }

  findClassByCode(code) {
    const normalized = normalizeClassCode(code);
    return this.data.classes.find((item) => item.code === normalized) || null;
  }

  findStudent(classIdValue, studentIdValue) {
    const item = this.findClassById(classIdValue);
    if (!item) return null;
    const studentId = normalizeStudentId(studentIdValue);
    const student = item.students.find((entry) => entry.studentId === studentId) || null;
    return student ? { classInfo: item, student } : null;
  }

  createClass({ name, code, enabled = true }) {
    const className = cleanText(name, 80);
    const classCode = normalizeClassCode(code);
    if (!className) throw new RosterError('请输入班级名称');
    if (!validateClassCode(classCode)) {
      throw new RosterError('班级码只能使用 2-32 位字母、数字、下划线或短横线');
    }
    if (this.findClassByCode(classCode)) throw new RosterError('班级码已存在');
    const now = new Date().toISOString();
    const item = {
      id: classId(),
      name: className,
      code: classCode,
      enabled: enabled !== false,
      createdAt: now,
      updatedAt: now,
      students: [],
    };
    this.data.classes.push(item);
    this.save();
    return clone(item);
  }

  updateClass(id, patch) {
    const item = this.findClassById(id);
    if (!item) throw new RosterError('班级不存在', 404);
    const nextName = patch.name === undefined ? item.name : cleanText(patch.name, 80);
    const nextCode = patch.code === undefined ? item.code : normalizeClassCode(patch.code);
    if (!nextName) throw new RosterError('请输入班级名称');
    if (!validateClassCode(nextCode)) {
      throw new RosterError('班级码只能使用 2-32 位字母、数字、下划线或短横线');
    }
    const duplicate = this.data.classes.find((entry) => entry.id !== item.id && entry.code === nextCode);
    if (duplicate) throw new RosterError('班级码已存在');
    item.name = nextName;
    item.code = nextCode;
    if (patch.enabled !== undefined) item.enabled = patch.enabled !== false;
    item.updatedAt = new Date().toISOString();
    this.save();
    return clone(item);
  }

  deleteClass(id) {
    const index = this.data.classes.findIndex((item) => item.id === String(id || ''));
    if (index < 0) throw new RosterError('班级不存在', 404);
    const [removed] = this.data.classes.splice(index, 1);
    this.save();
    return clone(removed);
  }

  addStudent(classIdValue, { studentId, name, enabled = true }) {
    const item = this.findClassById(classIdValue);
    if (!item) throw new RosterError('班级不存在', 404);
    const id = normalizeStudentId(studentId);
    const studentName = cleanText(name, 80);
    if (!validateStudentId(id)) throw new RosterError('学号格式不正确');
    if (!studentName) throw new RosterError('请输入学生姓名');
    if (item.students.some((student) => student.studentId === id)) {
      throw new RosterError('该学号已在本班名单中');
    }
    const now = new Date().toISOString();
    const student = {
      studentId: id,
      name: studentName,
      enabled: enabled !== false,
      createdAt: now,
      updatedAt: now,
    };
    item.students.push(student);
    item.updatedAt = now;
    this.save();
    return clone(student);
  }

  updateStudent(classIdValue, studentIdValue, patch) {
    const found = this.findStudent(classIdValue, studentIdValue);
    if (!found) throw new RosterError('学生不在该班名单中', 404);
    const { classInfo, student } = found;
    const previousStudentId = student.studentId;
    const nextId = patch.studentId === undefined ? student.studentId : normalizeStudentId(patch.studentId);
    const nextName = patch.name === undefined ? student.name : cleanText(patch.name, 80);
    if (!validateStudentId(nextId)) throw new RosterError('学号格式不正确');
    if (!nextName) throw new RosterError('请输入学生姓名');
    const duplicate = classInfo.students.find((entry) => entry !== student && entry.studentId === nextId);
    if (duplicate) throw new RosterError('该学号已在本班名单中');
    student.studentId = nextId;
    student.name = nextName;
    if (patch.enabled !== undefined) student.enabled = patch.enabled !== false;
    student.updatedAt = new Date().toISOString();
    classInfo.updatedAt = student.updatedAt;
    this.save();
    return { previousStudentId, student: clone(student) };
  }

  deleteStudent(classIdValue, studentIdValue) {
    const item = this.findClassById(classIdValue);
    if (!item) throw new RosterError('班级不存在', 404);
    const id = normalizeStudentId(studentIdValue);
    const index = item.students.findIndex((student) => student.studentId === id);
    if (index < 0) throw new RosterError('学生不在该班名单中', 404);
    const [removed] = item.students.splice(index, 1);
    item.updatedAt = new Date().toISOString();
    this.save();
    return clone(removed);
  }

  importStudents(classIdValue, rows, mode = 'merge') {
    const item = this.findClassById(classIdValue);
    if (!item) throw new RosterError('班级不存在', 404);
    if (!Array.isArray(rows)) throw new RosterError('导入数据格式不正确');
    const normalizedRows = [];
    const seen = new Set();
    for (const raw of rows) {
      const source = Array.isArray(raw)
        ? { studentId: raw[0], name: raw[1], enabled: raw[2] !== false }
        : raw;
      if (Array.isArray(raw) && /^(学号|student\s*id)$/i.test(String(source.studentId || '').trim())) continue;
      const studentId = normalizeStudentId(source && source.studentId);
      const name = cleanText(source && source.name, 80);
      if (!validateStudentId(studentId)) {
        throw new RosterError(`学号格式不正确：${studentId || '(空)'}`);
      }
      if (!name) throw new RosterError(`学生姓名为空：${studentId}`);
      if (seen.has(studentId)) throw new RosterError(`导入数据中存在重复学号：${studentId}`);
      seen.add(studentId);
      normalizedRows.push({ studentId, name, enabled: source && source.enabled !== false });
    }

    const now = new Date().toISOString();
    const existingById = new Map(item.students.map((student) => [student.studentId, student]));
    const nextStudents = [];
    let added = 0;
    let updated = 0;
    for (const row of normalizedRows) {
      const existing = existingById.get(row.studentId);
      if (existing) {
        nextStudents.push({
          ...existing,
          name: row.name,
          enabled: row.enabled,
          updatedAt: now,
        });
        updated += 1;
      } else {
        nextStudents.push({
          studentId: row.studentId,
          name: row.name,
          enabled: row.enabled,
          createdAt: now,
          updatedAt: now,
        });
        added += 1;
      }
      existingById.delete(row.studentId);
    }

    if (mode !== 'replace') {
      for (const existing of existingById.values()) nextStudents.push(existing);
    }
    item.students = nextStudents;
    item.updatedAt = now;
    this.save();
    return { added, updated, total: item.students.length };
  }
}

module.exports = {
  RosterStore,
  RosterError,
  cleanText,
  normalizeClassCode,
  normalizeStudentId,
};
