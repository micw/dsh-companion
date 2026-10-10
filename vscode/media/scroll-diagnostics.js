(() => {
  const MAX_SAMPLES = 48;
  const MAX_AGE_MS = 120_000;
  const JUMP_VIEWPORTS = 0.75;
  const KINDS = new Set([
    'wheel-up', 'wheel-armed', 'native-scroll', 'frame-one', 'frame-two',
    'host-assistant-before', 'host-assistant-after', 'host-process-before', 'host-process-after',
    'host-message-before', 'host-message-after', 'host-reset-before', 'host-reset-after',
    'host-prepend-before', 'host-prepend-after', 'render-before', 'render-after',
    'render-write-before', 'render-write-after', 'bounds-before', 'bounds-after',
    'follow-write-before', 'follow-write-after',
    'prepend-write-before', 'prepend-write-after', 'mode-follow', 'mode-sticky',
    'resize', 'reset-before', 'reset-after', 'prepend-start', 'prepend-end',
  ]);

  /** Captures one bounded, content-free wheel-to-jump trace without changing scrolling. */
  function createScrollTrace(output, state, report, frame = requestAnimationFrame, now = performance.now.bind(performance)) {
    let active;
    let reported = false;
    let framePending = false;
    let batchId = 0;

    function snapshot(kind, target = null) {
      const view = state();
      return {
        kind,
        ms: Math.max(0, Math.round(now() - active.startedAt)),
        top: Math.round(output.scrollTop),
        height: Math.round(output.scrollHeight),
        viewport: Math.round(output.clientHeight),
        mode: view.mode,
        intent: view.intent === true,
        pointer: view.pointer === true,
        batchId,
        target: target === null ? null : Math.round(target),
      };
    }

    function record(kind, target = null) {
      if (active === undefined || reported || !KINDS.has(kind)) return;
      if (now() - active.startedAt > MAX_AGE_MS) { active = undefined; return; }
      const entry = snapshot(kind, target);
      active.samples.push(entry);
      if (active.samples.length > MAX_SAMPLES) active.samples.shift();
      const drop = active.previousTop - entry.top;
      active.previousTop = entry.top;
      const limit = Math.max(128, entry.viewport * JUMP_VIEWPORTS);
      if (drop < limit) return;
      reported = true;
      report({ type: 'diagnosticScroll', reason: kind, startTop: Math.round(active.startTop), samples: [...active.samples] });
      active = undefined;
    }

    function afterMutation(kind) {
      record(kind);
      if (active === undefined || framePending) return;
      framePending = true;
      frame(() => {
        record('frame-one');
        frame(() => {
          framePending = false;
          record('frame-two');
        });
      });
    }

    return Object.freeze({
      arm() {
        if (reported || active !== undefined) return;
        active = { startedAt: now(), startTop: output.scrollTop, previousTop: output.scrollTop, samples: [] };
        record('wheel-up');
        afterMutation('wheel-armed');
      },
      record,
      afterMutation,
      setBatch(id) { batchId = id; },
    });
  }

  globalThis.dshCompanionScrollDiagnostics = Object.freeze({ createScrollTrace });
})();
