'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { withServer } = require('./test-support');
test('merged versioned rules preserve targets, select system fields and defer active attempts', async () => {
  await withServer(async ({ api, cmd, teacher, dataDir }) => {
    const t = await teacher();
    const cls = (await api('/api/teacher/classes', undefined, t.cookie)).json.classes[0];
    for (const [studentId,name] of [['S1','One'],['S2','Two']]) await api(`/api/teacher/classes/${cls.id}/students`, { studentId,name }, t.cookie);
    let result = await api('/api/teacher/settings', { openModels: { hx: true }, scoreSystemOn: true,
      scoreConfig: { sp1:65, spHx:450, initTempHx:400, durationUnit:900, sysSp1:70, sysSpHx:460 } }, t.cookie);
    assert.equal(result.json.settings.scoreSystemOn, true);
    const student = await api('/api/login', { classCode:'CORE26', studentId:'S1', name:'One', model:'tank' });
    const hx = await api('/api/login', { classCode:'CORE26', studentId:'S2', name:'Two', model:'hx' });
    assert.equal(hx.json.state.sp, 450);
    assert.equal(hx.json.state.ti1103, 400);
    const revision = result.json.settings.scoreConfigRevision;
    result = await api('/api/teacher/settings', { scoreConfig:{ durationUnit:1000 } }, t.cookie);
    assert.equal(result.json.settings.scoreConfig.sp1, 65);
    assert.equal((await api('/api/state', undefined, student.cookie)).json.state.sp1, 65);
    assert.equal(result.json.settings.scoreConfigRevision, revision + 1);
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir,'settings.json'),'utf8'));
    assert.equal(persisted.scoreSystemOn, true);
    assert.equal((await api('/api/teacher/settings', { scoreConfig:{ bandTank:0 } }, t.cookie)).status, 400);
    assert.equal((await api('/api/projects', undefined, t.cookie)).json.settings.scoreConfigRevision, revision + 1);
    await api('/api/teacher/settings', { scoreConfig:{ modeTank:2, modeHx:2 } }, t.cookie);
    assert.equal((await api('/api/state', undefined, student.cookie)).json.state.sp1, 70);
    assert.equal((await api('/api/state', undefined, hx.cookie)).json.state.sp, 460);
    await cmd(student.cookie,'SCORE_START');
    const current = (await api('/api/state', undefined, student.cookie)).json.state;
    result = await api('/api/teacher/settings', { scoreConfig:{ sysSp1:80, durationSystem:1800 } }, t.cookie);
    assert.ok(result.json.applications.some(item => item.studentId === 'S1' && item.status === 'pending'));
    const unchanged = (await api('/api/state', undefined, student.cookie)).json.state;
    assert.equal(unchanged.sp1, current.sp1);
    assert.equal(unchanged.score.durationS, current.score.durationS);
  });
});
