'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EngineSession } = require('../server/engine-session');
const { ROOT, sleep, removeTestDir } = require('./test-support');
async function withEngine(model, run) {
  const dir = fs.mkdtempSync(path.join(ROOT, '.test-data-score-'));
  const enginePath = process.platform === 'win32'
    ? path.join(ROOT, model === 'hx' ? 'native-hx/build/HxEngine.exe' : 'native/build/YunEngine.exe')
    : path.join(ROOT, 'bin', model === 'hx' ? 'HxEngine' : 'YunEngine');
  const e = new EngineSession({ studentId: 'test', modelId: model, enginePath, dataDir: dir, stateDir: dir, historyDir: dir });
  try { await e.start(); await run(e); }
  finally {
    const child = e.child;
    if (child) {
      const closed = new Promise(resolve => child.once('exit', resolve));
      e.stop();
      await Promise.race([closed, sleep(2500)]);
      if (child.exitCode === null) { child.kill(); await closed; }
    }
    removeTestDir(dir);
  }
}
test('tank score start and reset preserve teacher duration and setpoints', async () => {
  await withEngine('tank', async e => {
    await e.send('SCORE_MODE 1');
    await e.send('SCORE_CFG 900 1800 3 5 200 2 -15');
    await e.send('SET_SP 0 65');
    await e.send('SCORE_TANK 0');
    await e.send('SCORE_START');
    assert.equal(e.lastState.sp1, 65);
    assert.equal(e.lastState.score.durationS, 900);
    await e.send('RESET');
    assert.equal(e.lastState.sp1, 65);
    assert.equal(e.lastState.score.durationS, 900);
  });
});
test('HX finishes each mode at its own default and custom deadline', async () => {
  for (const [mode, unit, system, deadline] of [[1,480,1500,480],[2,480,1500,1500],[1,60,120,60],[2,60,120,120]]) {
    await withEngine('hx', async e => {
      await e.send(`SCORE_CFG ${unit} ${system} 2 5 300 3 -20`);
      await e.send(`SCORE_MODE ${mode}`);
      await e.send('SCORE_START');
      for (let i = 0; i < deadline - 1; i++) await e.tick(false);
      assert.equal(e.lastState.score.finished, false);
      await e.tick(false);
      assert.equal(e.lastState.score.finished, true);
      assert.equal(e.lastState.score.sessionT, deadline);
      assert.equal(e.lastState.score.durationS, deadline);
      await e.tick(false);
      assert.equal(e.lastState.score.sessionT, deadline);
    });
  }
});
module.exports = { withEngine };
