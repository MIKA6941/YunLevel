(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProcessDevices = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const catalogs = {
    tank:[
      { id:'P101', name:'进水泵', key:'pump', unit:'%', manual:'pumpInput', badge:'pumpNode', box:[123,144,44,44] },
      { id:'FV101', name:'给水总阀', key:'fv101', unit:'%', mv:0, manual:'fv101Input', badge:'fv101Node', box:[193,144,44,44] },
      { id:'T1', name:'1#罐 · LI101', key:'h1', unit:'%', pv:0, sp:'sp1', box:[270,70,130,190] },
      { id:'FV102', name:'级间阀 1', key:'fv102', unit:'%', mv:1, manual:'fv102Input', badge:'fv102Node', box:[453,178,44,44] },
      { id:'T2', name:'2#罐 · LI102', key:'h2', unit:'%', pv:1, sp:'sp2', box:[530,70,130,190] },
      { id:'FV103', name:'级间阀 2', key:'fv103', unit:'%', mv:2, manual:'fv103Input', badge:'fv103Node', box:[713,178,44,44] },
      { id:'T3', name:'3#罐 · LI103', key:'h3', unit:'%', pv:2, sp:'sp3', box:[790,70,130,190] },
      { id:'FV104', name:'出口阀', key:'fv104', unit:'%', mv:3, manual:'fv104Input', badge:'fv104Node', box:[973,178,44,44] },
    ],
    hx:[
      { id:'TI1103', name:'入口蒸汽温度', key:'ti1103', unit:'℃', manual:'inletTempInput', badge:'hxInstTi1103', box:[96,88,44,44] },
      { id:'E1102', name:'换热器', key:'ti1104', unit:'℃', pv:0, sp:'sp', box:[250,40,320,170] },
      { id:'TI1104', name:'出口温度', key:'ti1104', unit:'℃', pv:0, sp:'sp', badge:'hxInstTi1104', box:[626,88,44,44] },
      { id:'FI1105', name:'蒸汽流量', key:'fi1105', unit:'kg/s', pv:1, sp:'spf', badge:'hxInstFi1105', box:[720,88,44,44] },
      { id:'FV1105', name:'蒸汽出口阀', key:'fv1105', unit:'%', mv:2, manual:'fv1105Input', badge:'hxFV1105Node', box:[830,80,44,52] },
      { id:'FV1102', name:'冷却水阀', key:'fv1102', unit:'%', mv:0, manual:'fv1102Input', badge:'hxFV1102Node', box:[100,274,44,48] },
      { id:'FI1102', name:'冷却水流量', key:'mw', unit:'kg/s', relatedMv:0, badge:'hxInstFi1102', box:[216,278,44,44] },
    ],
  };
  function devices(model) { return catalogs[model] || []; }
  function related(device, entries) {
    return entries.filter(entry => {
      const value = entry.value;
      if (device.mv !== undefined || device.relatedMv !== undefined) return Number(value.mv) === Number(device.mv ?? device.relatedMv);
      if (device.pv === undefined) return false;
      return entry.kind === 'loop' ? Number(value.pv) === device.pv
        : Number(value.outer) === device.pv || Number(value.inner) === device.pv;
    });
  }
  function reading(device, state) {
    const raw = state?.[device.key];
    const valid = raw !== null && raw !== undefined && String(raw).trim() !== '' && Number.isFinite(Number(raw));
    return valid ? `${Number(raw).toFixed(device.unit === 'kg/s' ? 2 : 1)} ${device.unit}` : '—';
  }
  function place(anchor, size, viewport) {
    const pad = 12;
    const maxX = Math.max(pad, viewport.width - size.width - pad);
    const right = anchor.right + pad;
    const left = right + size.width <= viewport.width - pad ? right : anchor.left - size.width - pad;
    return { left:Math.max(pad, Math.min(maxX, left)),
      top:viewport.top + Math.max(pad, Math.min(viewport.height - size.height - pad, anchor.top - viewport.top)) };
  }
  function bind(doc, options) {
    const view = doc.defaultView;
    const panel = doc.createElement('section');
    panel.id = 'processDevicePanel'; panel.className = 'process-device-panel'; panel.hidden = true;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'processDeviceTitle');
    panel.innerHTML = '<header><div><h2 id="processDeviceTitle"></h2><p class="device-description"></p></div>' +
      '<button type="button" class="device-close" aria-label="关闭设备操作"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></header>' +
      '<div class="device-reading"><span>当前测量值</span><strong></strong></div><p class="device-ownership"></p><div class="device-content"></div>';
    doc.body.append(panel);
    const nodes = [];
    let active = null, gesture = null;
    function context() { return options.getContext(); }
    function close({ restoreFocus = false } = {}) {
      const previous = active;
      active = null; panel.hidden = true;
      nodes.forEach(node => node.setAttribute('aria-pressed', 'false'));
      if (restoreFocus && previous?.anchor.isConnected) previous.anchor.focus({ preventScroll:true });
    }
    function position() {
      if (!active) return;
      const anchor = active.anchor.getBoundingClientRect();
      const viewport = view.visualViewport;
      const width = viewport?.width || view.innerWidth, height = viewport?.height || view.innerHeight;
      const top = viewport?.offsetTop || 0;
      panel.style.maxHeight = Math.max(120, height - 24) + 'px';
      if (width < 900) {
        panel.style.left = (viewport?.offsetLeft || 0) + 'px';
        panel.style.top = ''; panel.style.bottom = Math.max(0, view.innerHeight - top - height) + 'px';
        return;
      }
      panel.style.bottom = '';
      const xy = place(anchor, panel.getBoundingClientRect(), { width, height, top });
      panel.style.left = xy.left + 'px'; panel.style.top = xy.top + 'px';
    }
    function refresh() {
      if (!active) return;
      const ctx = context();
      if (ctx.model !== active.model || !ctx.account || ctx.view !== 'control' || !active.anchor.getClientRects().length) { close(); return; }
      panel.querySelector('.device-reading strong').textContent = reading(active.device, ctx.state);
      const owners = related(active.device, ctx.entries || []);
      panel.querySelector('.device-ownership').textContent = ctx.account.viewOnly
        ? '观察窗口 · 仅可查看'
        : owners.length ? `关联 ${owners.length} 个回路，调节通过回路生效。` : active.device.manual ? '独立手操 · 应用后生效' : '尚未连接回路';
      position();
    }
    function open(node) {
      const ctx = context();
      const device = devices(ctx.model).find(item => item.id === node?.dataset.processDevice);
      if (!device || !ctx.account || ctx.view !== 'control') return;
      active = { device, anchor:node, model:ctx.model };
      panel.querySelector('h2').textContent = device.id;
      panel.querySelector('.device-description').textContent = device.name;
      panel.hidden = false;
      nodes.forEach(item => item.setAttribute('aria-pressed', String(item.dataset.processDevice === device.id && item.dataset.deviceModel === ctx.model)));
      refresh();
      panel.querySelector('.device-close').focus({ preventScroll:true });
    }
    for (const model of ['tank', 'hx']) {
      const svg = doc.querySelector(model === 'tank' ? '#processVisual .hx-svg' : '#hxProcessVisual .hx-svg');
      if (!svg) continue;
      svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', model === 'tank' ? '液位设备操作' : '换热器设备操作');
      for (const device of devices(model)) {
        const hit = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
        const [x,y,width,height] = device.box;
        Object.entries({ x,y,width,height,rx:8,role:'button',tabindex:0,'aria-label':`${device.id} ${device.name}，查看与操作`,
          'aria-pressed':'false','aria-haspopup':'dialog' }).forEach(([key,value]) => hit.setAttribute(key, value));
        hit.dataset.processDevice = device.id; hit.dataset.deviceModel = model; hit.classList.add('device-hit');
        svg.append(hit); nodes.push(hit);
        const badge = device.badge && doc.getElementById(device.badge);
        if (badge) { badge.dataset.processDevice = device.id; badge.dataset.deviceModel = model; badge.classList.add('device-badge'); }
      }
    }
    const viewport = doc.querySelector('.process-viewport');
    viewport?.addEventListener('simulation:activate', event => open(event.detail.target.closest?.('[data-process-device]')));
    viewport?.addEventListener('simulation:panstart', () => close());
    // The standalone UI branch also works with the incumbent fullscreen pan handler.
    viewport?.addEventListener('pointerdown', event => {
      if (viewport.dataset.simulationGestures === 'true' || event.button !== 0 || event.isPrimary === false || gesture) return;
      const node = event.target.closest?.('[data-process-device]');
      if (!node) return;
      event.stopPropagation(); event.preventDefault();
      gesture = { id:event.pointerId, x:event.clientX, y:event.clientY, node, moved:false, origin:options.getPan?.() };
      try { viewport.setPointerCapture(event.pointerId); } catch {}
    }, true);
    view.addEventListener('pointermove', event => {
      if (!gesture || gesture.id !== event.pointerId) return;
      if (!event.buttons) { gesture = null; return; }
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 6) {
        if (!gesture.moved) close();
        gesture.moved = true;
        if (gesture.origin) options.panTo?.({ x:gesture.origin.x + event.clientX - gesture.x, y:gesture.origin.y + event.clientY - gesture.y });
      }
    });
    view.addEventListener('pointerup', event => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const saved = gesture; gesture = null;
      try { viewport.releasePointerCapture(event.pointerId); } catch {}
      const rect = viewport.getBoundingClientRect();
      if (!saved.moved && Math.hypot(event.clientX - saved.x,event.clientY - saved.y) < 6 &&
        event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) open(saved.node);
    });
    const cancel = () => { if (gesture) { try { viewport.releasePointerCapture(gesture.id); } catch {} gesture = null; } };
    view.addEventListener('pointercancel', cancel); viewport?.addEventListener('lostpointercapture', cancel);
    view.addEventListener('blur', cancel);
    doc.addEventListener('keydown', event => {
      const node = event.target.closest?.('[data-process-device]');
      if (node && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(node); }
      if (event.key === 'Escape' && active && !event.defaultPrevented) { event.preventDefault(); event.stopImmediatePropagation(); close({ restoreFocus:true }); }
    });
    doc.addEventListener('pointerdown', event => {
      if (active && !panel.contains(event.target) && !event.target.closest?.('[data-process-device]')) close();
    }, true);
    panel.querySelector('.device-close').onclick = () => close({ restoreFocus:true });
    view.addEventListener('resize', position); view.addEventListener('scroll', position, true);
    view.visualViewport?.addEventListener('resize', position); view.visualViewport?.addEventListener('scroll', position);
    const observer = new view.MutationObserver(() => { if (active) refresh(); });
    if (viewport) observer.observe(viewport, { subtree:true, attributes:true, attributeFilter:['style','class'] });
    return { refresh, close, position };
  }
  return { devices, related, reading, place, bind };
});
