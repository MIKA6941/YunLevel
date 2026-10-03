(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ParameterFeedback = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function sameValue(a, b) {
    const left = String(a).trim().toLowerCase().replace('∞', 'inf');
    const right = String(b).trim().toLowerCase().replace('∞', 'inf');
    if (left === right) return true;
    return left !== '' && right !== '' && Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Number(left) === Number(right);
  }

  // A reply must never clear a newer edit or discard a draft after a partial failure.
  async function applyDraft(inputs, action) {
    const snapshot = inputs.map(input => ({ input, value:input.value, dirty:input.dataset.dirty === '1' }));
    try {
      const result = await action();
      snapshot.forEach(({ input, value }) => {
        if (sameValue(input.value, value)) delete input.dataset.dirty;
        else input.dataset.dirty = '1';
      });
      return result;
    } catch (error) {
      snapshot.forEach(({ input, value, dirty }) => {
        if (dirty || !sameValue(input.value, value)) input.dataset.dirty = '1';
      });
      throw error;
    }
  }

  function bind(doc) {
    const selector = '[data-loop-card], [data-casc-card], #manualControls';
    const states = new WeakMap();
    function state(root) {
      if (!states.has(root)) states.set(root, { pending:false, error:'', applied:false });
      return states.get(root);
    }
    function refresh(root) {
      const inputs = Array.from(root.querySelectorAll('input'));
      if (!inputs.length) return;
      const current = state(root);
      const dirty = inputs.some(input => input.dataset.dirty === '1');
      const editable = inputs.some(input => !input.disabled && !input.readOnly);
      if (root.id !== 'manualControls') setReadonlyActions(Array.from(root.querySelectorAll('button')), !editable);
      let phase = 'idle';
      let message = '修改后点击应用，参数才会生效。';
      if (current.pending) { phase = 'pending'; message = '正在应用参数…'; }
      else if (!editable) { phase = 'readonly'; message = '当前参数只读，不能应用修改。'; }
      else if (current.error) { phase = 'error'; message = `应用未完成：${current.error}。草稿已保留，请检查后重试。`; }
      else if (dirty) { phase = 'draft'; message = '有未应用的草稿。'; }
      else if (current.applied) { phase = 'applied'; message = '参数已应用。'; }
      let output = root.querySelector('.parameter-feedback');
      if (!output) {
        output = doc.createElement('p');
        output.className = 'parameter-feedback';
        output.setAttribute('role', 'status');
        output.setAttribute('aria-live', 'polite');
        root.insertBefore(output, root.querySelector('.button-row'));
      }
      if (output.textContent !== message) output.textContent = message;
      if (output.dataset.phase !== phase) output.dataset.phase = phase;
      root.setAttribute('aria-busy', String(current.pending));
    }
    function refreshAll() { doc.querySelectorAll(selector).forEach(refresh); }
    function onInput(event) {
      const input = event.target;
      const root = input.closest?.(selector);
      if (!root || input.tagName !== 'INPUT' || input.disabled || input.readOnly) return;
      input.dataset.dirty = '1';
      state(root).error = '';
      refresh(root);
    }
    doc.addEventListener('input', onInput);
    const observer = new MutationObserver(refreshAll);
    for (const id of ['loopCards', 'manualControls']) {
      const container = doc.getElementById(id);
      if (container) observer.observe(container, { subtree:true, childList:true, attributes:true,
        attributeFilter:['data-dirty', 'disabled', 'readonly'] });
    }
    refreshAll();
    return {
      refresh:refreshAll,
      async submit(button, action) {
        const root = button.closest(selector);
        if (!root || button.disabled || state(root).pending) return;
        const current = state(root);
        const label = button.textContent;
        current.pending = true;
        current.error = '';
        button.dataset.submitting = '1';
        button.setAttribute('aria-disabled', 'true');
        button.textContent = '应用中…';
        refresh(root);
        try {
          await applyDraft(Array.from(root.querySelectorAll('input')).filter(input => !input.disabled && !input.readOnly), action);
          current.applied = true;
        } catch (error) {
          current.error = error.message || '请求失败';
        } finally {
          current.pending = false;
          delete button.dataset.submitting;
          button.removeAttribute('aria-disabled');
          button.textContent = label;
          if (root.isConnected) refresh(root);
        }
      },
      destroy() { observer.disconnect(); doc.removeEventListener('input', onInput); },
    };
  }
  function setReadonlyActions(buttons, readonly) {
    buttons.forEach(button => {
      if (readonly) {
        if (button.dataset.feedbackDisabled === undefined) button.dataset.feedbackDisabled = String(button.disabled);
        if (!button.disabled) button.disabled = true;
      } else if (button.dataset.feedbackDisabled !== undefined) {
        button.disabled = button.dataset.feedbackDisabled === 'true';
        delete button.dataset.feedbackDisabled;
      }
    });
  }
  return { applyDraft, bind, setReadonlyActions };
});
