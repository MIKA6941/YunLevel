'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyDraft } = require('../public/parameter-feedback');
const input = value => ({ value, dataset:{ dirty:'1' } });

test('a late successful reply preserves edits made while the request is in flight', async () => {
  const field = input('0.50');
  let resolve;
  const pending = applyDraft([field], () => new Promise(done => { resolve = done; }));
  field.value = '0.66';
  delete field.dataset.dirty; // Existing callbacks may clear dirty markers.
  resolve();
  await pending;
  assert.equal(field.value, '0.66');
  assert.equal(field.dataset.dirty, '1');
});
test('failed or partially applied requests preserve the submitted draft', async () => {
  const field = input('65');
  await assert.rejects(applyDraft([field], async () => {
    delete field.dataset.dirty;
    throw new Error('gateway failure');
  }), /gateway failure/);
  assert.equal(field.value, '65');
  assert.equal(field.dataset.dirty, '1');
});
test('successful numeric normalization clears an unchanged draft', async () => {
  const field = input('0.50');
  await applyDraft([field], async () => { field.value = '0.500'; });
  assert.equal(field.dataset.dirty, undefined);
});
test('clearing a submitted field while waiting remains an unapplied draft', async () => {
  const field = input('60');
  await applyDraft([field], async () => { field.value = ''; });
  assert.equal(field.dataset.dirty, '1');
});
