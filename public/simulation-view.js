'use strict';

// Pointer interaction shared by the tank and heat exchanger diagrams.
(function (root) {
  function bindPan(viewport, { getPan, onPan }) {
    const host = viewport.ownerDocument?.defaultView || viewport;
    let drag = null;
    function cancel() {
      if (!drag) return;
      const pointerId = drag.pointerId;
      drag = null;
      viewport.classList.remove('panning');
      try { viewport.releasePointerCapture(pointerId); } catch {}
    }
    function finish(event) {
      if (drag && event.pointerId === drag.pointerId) cancel();
    }
    viewport.addEventListener('pointerdown', (event) => {
      if (drag || event.button !== 0 || event.isPrimary === false) return;
      if (event.target.closest?.('button, input, select, textarea, a')) return;
      const origin = getPan();
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        originX: origin.x, originY: origin.y };
      viewport.classList.add('panning');
      try { viewport.setPointerCapture(event.pointerId); } catch {}
      event.preventDefault();
    });
    host.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (event.buttons === 0) { cancel(); return; }
      onPan({ x: drag.originX + event.clientX - drag.startX,
        y: drag.originY + event.clientY - drag.startY });
      event.preventDefault();
    });
    host.addEventListener('pointerup', finish);
    host.addEventListener('pointercancel', finish);
    viewport.addEventListener('lostpointercapture', finish);
    host.addEventListener('blur', cancel);
    return { cancel };
  }
  const api = { bindPan };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SimulationView = api;
})(typeof window === 'object' ? window : globalThis);
