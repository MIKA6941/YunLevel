'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { criticalReadouts } = require('../public/control-workspace');

test('tank readouts retain model precision and percentage units', () => {
  const tags = ['h1','h2','h3'].map((key, index) => ({ key, label:`LI10${index + 1}(%)`, digits:2 }));
  assert.deepEqual(criticalReadouts('tank', tags, { h1:55.126, h2:0, h3:'31.8' }), [
    { key:'h1', label:'LI101', unit:'%', value:'55.13' },
    { key:'h2', label:'LI102', unit:'%', value:'0.00' },
    { key:'h3', label:'LI103', unit:'%', value:'31.80' },
  ]);
});
test('HX distinguishes inlet, outlet, teacher target and steam flow', () => {
  const tags = [
    { key:'ti1104', label:'TI1104 出口(℃)', digits:2 },
    { key:'sp', label:'出口给定(℃)', digits:2 },
    { key:'ti1103', label:'TI1103 入口(℃)', digits:2 },
    { key:'fi1105', label:'FI1105(kg/s)', digits:3 },
  ];
  const rows = criticalReadouts('hx', tags, { ti1104:420, sp:450, ti1103:400, fi1105:1.2354 });
  assert.deepEqual(rows.map(row => [row.key, row.unit, row.value]), [
    ['ti1104','℃','420.00'], ['sp','℃','450.00'], ['ti1103','℃','400.00'], ['fi1105','kg/s','1.235'],
  ]);
});
test('missing, empty and invalid measurements are never presented as zero', () => {
  for (const raw of [undefined, null, '', ' ', false, [], NaN, Infinity, 'bad']) {
    assert.equal(criticalReadouts('tank', [], { h1:raw })[0].value, '—');
  }
  assert.equal(criticalReadouts('tank', [], null)[0].value, '—');
});
test('a model switch rebuilds the presentation from that model only', () => {
  assert.deepEqual(criticalReadouts('hx', [], { h1:65 }).map(row => row.key), ['ti1104','sp','ti1103','fi1105']);
  assert.ok(criticalReadouts('hx', [], { h1:65 }).every(row => row.value === '—'));
});
