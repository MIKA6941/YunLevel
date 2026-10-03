const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.YUN_DATA_DIR
  ? path.resolve(process.env.YUN_DATA_DIR)
  : path.join(rootDir, 'data');
const publicDir = path.join(rootDir, 'public');
const nativeDir = path.join(rootDir, 'native', 'build');
const defaultEngine = process.platform === 'win32'
  ? path.join(nativeDir, 'YunEngine.exe')
  : path.join(rootDir, 'bin', 'YunEngine');

// 多模型：每个模型一个内核。tank 沿用原路径，行为不变。
const defaultEngineHx = process.platform === 'win32'
  ? path.join(rootDir, 'native-hx', 'build', 'HxEngine.exe')
  : path.join(rootDir, 'bin', 'HxEngine');

const engines = {
  tank: process.env.YUN_ENGINE ? path.resolve(process.env.YUN_ENGINE) : defaultEngine,
  hx: process.env.YUN_ENGINE_HX ? path.resolve(process.env.YUN_ENGINE_HX) : defaultEngineHx,
};

// 每个模型的运行期目录。tank 保持改造前的值不变。
const modelDirs = {
  tank: {
    stateDir: path.join(dataDir, 'state'),
    historyDir: path.join(dataDir, 'history'),
    submissionsDir: path.join(dataDir, 'submissions'),
    teacherBackupsDir: path.join(dataDir, 'teacher_backups'),
  },
  hx: {
    stateDir: path.join(dataDir, 'hx-state'),
    historyDir: path.join(dataDir, 'hx-history'),
    submissionsDir: path.join(dataDir, 'hx-submissions'),
    teacherBackupsDir: path.join(dataDir, 'hx-teacher_backups'),
  },
};

function dirsForModel(modelId) {
  return Object.prototype.hasOwnProperty.call(modelDirs, modelId) ? modelDirs[modelId] : modelDirs.tank;
}

function engineForModel(modelId) {
  return Object.prototype.hasOwnProperty.call(engines, modelId) ? engines[modelId] : engines.tank;
}

module.exports = {
  rootDir,
  dataDir,
  publicDir,
  engines,
  modelDirs,
  dirsForModel,
  engineForModel,
  defaultModelId: 'tank',
  enginePath: engines.tank,
  port: Number(process.env.PORT || 8080),
  classesFile: path.join(dataDir, 'classes.json'),
  classCode: process.env.YUN_CLASS_CODE || 'CHANGE_ME_BEFORE_DEPLOY',
  teacherCode: process.env.YUN_TEACHER_CODE || 'CHANGE_ME_BEFORE_DEPLOY',
  cookieSecure: process.env.YUN_COOKIE_SECURE === '1',
  maxSessions: Number(process.env.YUN_MAX_SESSIONS || 120),
  stateDir: path.join(dataDir, 'state'),
  historyDir: path.join(dataDir, 'history'),
  recordsFile: path.join(dataDir, 'score_records.jsonl'),
  runtimeDir: path.join(dataDir, 'runtime'),
  settingsFile: path.join(dataDir, 'settings.json'),
  submissionsDir: path.join(dataDir, 'submissions'),
  teacherBackupsDir: path.join(dataDir, 'teacher_backups'),
};
