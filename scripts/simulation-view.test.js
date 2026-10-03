'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bindPan } = require('../public/simulation-view');

function surface() {
  const events = new Map();
  const classes = new Set();
  const node = {
    classList: { add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name) },
    addEventListener(name, fn) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(fn);
    },
    fire(name, details = {}) {
      const event = { pointerId: 1, clientX: 100, clientY: 80, button: 0,
        buttons: 1, isPrimary: true, target: { closest: () => null },
        preventDefault() {}, ...details };
      for (const fn of events.get(name) || []) fn(event);
    },
    setPointerCapture(id) { node.captured = id; },
    releasePointerCapture() { node.captured = null; },
  };
  return node;
}
function fixture() {
  const viewport = surface();
  const host = surface();
  viewport.ownerDocument = { defaultView: host };
  let pan = { x: 20, y: -10 };
  const interaction = bindPan(viewport, { getPan: () => pan, onPan: next => { pan = next; } });
  return { viewport, host, interaction, pan: () => pan };
}
test('normal view pans by pointer displacement, including moves outside the viewport', () => {
  const f = fixture(); // There is intentionally no fullscreen class.
  f.viewport.fire('pointerdown');
  f.host.fire('pointermove', { clientX: 340, clientY: 120 });
  assert.deepEqual(f.pan(), { x: 260, y: 30 });
  assert.equal(f.viewport.captured, 1);
  f.host.fire('pointerup');
  assert.equal(f.viewport.captured, null);
  assert.equal(f.viewport.classList.contains('panning'), false);
});
test('right clicks, secondary touches and interactive controls cannot start panning', () => {
  for (const details of [{ button: 2 }, { isPrimary: false }, { target: { closest: () => ({}) } }]) {
    const f = fixture();
    f.viewport.fire('pointerdown', details);
    f.host.fire('pointermove', { clientX: 340 });
    assert.deepEqual(f.pan(), { x: 20, y: -10 });
  }
});
test('another pointer cannot interrupt or move an active drag', () => {
  const f = fixture();
  f.viewport.fire('pointerdown');
  f.viewport.fire('pointerdown', { pointerId: 2, clientX: 400 });
  f.host.fire('pointermove', { pointerId: 2, clientX: 500 });
  f.host.fire('pointerup', { pointerId: 2 });
  assert.deepEqual(f.pan(), { x: 20, y: -10 });
  f.host.fire('pointermove', { clientX: 150 });
  assert.equal(f.pan().x, 70);
});
test('cancel, lost capture, released buttons, blur and view changes stop dragging', () => {
  for (const reason of ['pointercancel', 'lostpointercapture', 'buttons', 'blur', 'view']) {
    const f = fixture();
    f.viewport.fire('pointerdown');
    if (reason === 'lostpointercapture') f.viewport.fire(reason);
    else if (reason === 'buttons') f.host.fire('pointermove', { buttons: 0 });
    else if (reason === 'view') f.interaction.cancel();
    else f.host.fire(reason);
    f.host.fire('pointermove', { clientX: 400 });
    assert.deepEqual(f.pan(), { x: 20, y: -10 });
    assert.equal(f.viewport.classList.contains('panning'), false);
  }
});
test('dragging still works when pointer capture is unavailable', () => {
  const f = fixture();
  f.viewport.setPointerCapture = () => { throw new Error('no capture'); };
  f.viewport.fire('pointerdown');
  f.host.fire('pointermove', { clientX: 150 });
  f.host.fire('pointerup');
  assert.equal(f.pan().x, 70);
  assert.equal(f.viewport.classList.contains('panning'), false);
});
