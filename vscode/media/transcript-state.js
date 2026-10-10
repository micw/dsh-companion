(() => {
  /** Merges adjacent history-page process segments without crossing an Assistant message. */
  function mergePrependedTurnState(older, newer) {
    const first = newer.segments[0];
    const olderLast = older.segments.at(-1);
    const parent = first.root.parentNode;
    const siblings = parent === null ? [] : [...parent.childNodes];
    const newerMessageBeforeProcess = parent !== null
      && newer.firstAssistantMessage?.parentNode === parent
      && siblings.indexOf(newer.firstAssistantMessage) < siblings.indexOf(first.root);
    const join = !older.pendingProcessSegment && !newerMessageBeforeProcess;
    if (join) {
      first.rows.prepend(...olderLast.rows.childNodes);
      first.reasoning = new Map([...older.reasoning, ...first.reasoning]);
      first.statuses = new Map([...older.statuses, ...first.statuses]);
      first.toolCallIds = new Set([...older.toolCallIds, ...first.toolCallIds]);
      first.contextIds = new Set([...older.contextIds, ...first.contextIds]);
      first.toolCount = first.toolCallIds.size;
      first.contextCount = first.contextIds.size;
      if (first.rows.childNodes.length > 0 && first.disclosureRoot !== undefined
        && first.root !== first.disclosureRoot) {
        first.root.replaceWith(first.disclosureRoot);
        first.root = first.disclosureRoot;
        first.label = first.disclosureLabel;
      }
      olderLast.root.remove();
    }
    newer.segments = [...older.segments.slice(0, join ? -1 : undefined), ...newer.segments];
    for (const [index, segment] of newer.segments.entries()) {
      if (segment.root.dataset?.turn === undefined) continue;
      const id = `turn:${segment.root.dataset.turn}${index === 0 ? '' : `:process:${String(index)}`}`;
      segment.root.dataset.disclosureId = id;
      if (segment.disclosureRoot !== undefined) segment.disclosureRoot.dataset.disclosureId = id;
    }
    const active = newer.segments.at(-1);
    Object.assign(newer, active);
    newer.startedAt = older.startedAt ?? newer.startedAt;
    newer.firstAssistantMessage = older.firstAssistantMessage ?? newer.firstAssistantMessage;
    newer.latestAssistantMessage ??= older.latestAssistantMessage;
    return newer;
  }

  /** Starts a new process disclosure after text without moving earlier process rows. */
  function advanceTurnProcessSegment(turn, createSegment) {
    if (!turn.pendingProcessSegment) return false;
    Object.assign(turn.segments.at(-1), {
      toolCount: turn.toolCount, contextCount: turn.contextCount,
      reasoning: turn.reasoning, statuses: turn.statuses,
      toolCallIds: turn.toolCallIds, contextIds: turn.contextIds,
    });
    const segment = createSegment();
    turn.segments.push(segment);
    Object.assign(turn, segment);
    turn.pendingProcessSegment = false;
    return true;
  }

  /** Keeps later process rows below a durable within-Turn boundary. */
  function splitTurnProcessAtBoundary(turn, boundary) {
    if (turn === undefined || turn.completed || turn.root.parentNode !== boundary.parentNode) return false;
    if (turn.rows.childNodes.length === 0) {
      boundary.after(turn.root);
    } else {
      turn.pendingProcessSegment = true;
    }
    return true;
  }

  /** Resolves a Step's settled status to its original process segment, even after live text. */
  function selectReasoningStatusSegment(turn, event, advance) {
    const existing = turn.segments.find(segment => segment.statuses.has(event.id));
    if (existing !== undefined) return existing;
    const message = turn.latestAssistantMessage;
    if (event.retroactive === true && Number.isSafeInteger(event.step)
      && message?.dataset.assistantStep === String(event.step) && message.parentNode !== null) {
      const siblings = [...message.parentNode.childNodes];
      const messageIndex = siblings.indexOf(message);
      const preceding = turn.segments.findLast(segment => segment.root.parentNode === message.parentNode
        && siblings.indexOf(segment.root) >= 0 && siblings.indexOf(segment.root) < messageIndex);
      if (preceding !== undefined) {
        if (preceding === turn.segments.at(-1)) turn.pendingProcessSegment = true;
        return preceding;
      }
    }
    advance();
    return turn.segments.at(-1);
  }

  /** Places only an empty process disclosure after its preceding Assistant text. */
  function placeEmptyTurnProcessAfterMessage(turn) {
    const message = turn.latestAssistantMessage;
    const parent = turn.root.parentNode;
    if (turn.rows.childNodes.length !== 0 || message?.parentNode !== parent || parent === null) return false;
    const siblings = [...parent.childNodes];
    if (siblings.indexOf(turn.root) > siblings.indexOf(message)) return false;
    message.after(turn.root);
    return true;
  }

  /** First-step input precedes the Turn; later steering remains at its committed Step position. */
  function placeUserMessageBeforeTurn(turn, message, step) {
    if (step > 1) return false;
    const root = turn.segments?.[0]?.root ?? turn.root;
    const parent = root.parentNode;
    if (parent === null) return false;
    const candidates = [turn.firstAssistantMessage, root]
      .filter(node => node !== undefined && node.parentNode === parent);
    const anchor = [...parent.childNodes].find(node => candidates.includes(node));
    if (anchor === undefined) return false;
    anchor.before(message);
    return true;
  }

  /** Describes the send action selected by the draft prefix or held modifier. */
  function sendActionForGesture(running, controlHeld, draft = '', compacting = false) {
    if (compacting && !running) return { mode: 'queue', label: 'Queue',
      title: draft.startsWith('!')
        ? 'Queue after compaction; leading ! is not sent'
        : 'Queue after compaction (Enter or click)' };
    if (draft.startsWith('!')) {
      return { mode: 'steer', label: 'Steer', title: running
        ? 'Steer into the current Turn; leading ! is not sent'
        : 'Send immediately in a new Turn; leading ! is not sent' };
    }
    if (!running) return { mode: 'send', label: 'Send', title: 'Send message (Enter or click)' };
    if (controlHeld) {
      return { mode: 'steer', label: 'Steer', title: 'Steer into the current Turn (Ctrl+Enter or Ctrl+click)' };
    }
    return { mode: 'queue', label: 'Queue', title: 'Queue for the next Turn (Enter or click)' };
  }

  /** Derives the visible activity line without letting connection readiness hide active work. */
  function activityStatusText({ running, compacting, hostStatus }) {
    if (compacting) return 'Compacting context…';
    if (running) {
      return /responding…$/u.test(hostStatus)
        || hostStatus === 'Reconnecting to DSH…'
        || hostStatus === 'Disconnected; retrying…'
        ? hostStatus
        : 'Running…';
    }
    return /responding…$/u.test(hostStatus) ? 'Connected' : hostStatus;
  }

  /** A downward gesture may finish at the bottom after its first native scroll event. */
  function scrollModeAfterScroll(mode, nearBottom, userGesture, awayGesture = false, recentDownGesture = false) {
    if (userGesture) return awayGesture || !nearBottom ? 'sticky' : 'follow';
    return mode === 'sticky' && nearBottom && recentDownGesture ? 'follow' : mode;
  }

  /** Commits Chromium's scroll bounds once when a growing transcript first overflows. */
  function createScrollBoundsRefresher(container, scheduleFrame, observe = () => {}) {
    let framePending = false;
    let wasScrollable = false;
    const refresh = () => {
      if (framePending) return;
      framePending = true;
      scheduleFrame(() => {
        framePending = false;
        const scrollable = container.scrollHeight - container.clientHeight > 1;
        if (scrollable === wasScrollable) return;
        wasScrollable = scrollable;
        if (!scrollable) return;
        const top = container.scrollTop;
        const display = container.style.display;
        observe('bounds-before');
        container.style.display = 'none';
        void container.offsetHeight;
        container.style.display = display;
        container.scrollTop = top;
        observe('bounds-after');
      });
    };
    refresh.invalidate = () => { wasScrollable = false; };
    return refresh;
  }

  /** Retains unchanged Markdown nodes while applying the newest streamed HTML tree. */
  function reconcileTranscriptNodes(parent, incoming) {
    let current = parent.firstChild;
    for (const nextNode of [...incoming.childNodes]) {
      if (current === null) {
        parent.append(nextNode);
        continue;
      }
      const following = current.nextSibling;
      if (current.nodeType !== nextNode.nodeType || current.nodeName !== nextNode.nodeName) {
        current.replaceWith(nextNode);
      } else if (current.nodeType === 1) {
        for (const name of current.getAttributeNames()) {
          if (!nextNode.hasAttribute(name)) current.removeAttribute(name);
        }
        for (const name of nextNode.getAttributeNames()) {
          const value = nextNode.getAttribute(name);
          if (current.getAttribute(name) !== value) current.setAttribute(name, value);
        }
        reconcileTranscriptNodes(current, nextNode);
      } else if (current.data !== nextNode.data) {
        if (nextNode.data.startsWith(current.data)) current.appendData(nextNode.data.slice(current.data.length));
        else current.data = nextNode.data;
      }
      current = following;
    }
    while (current !== null) {
      const following = current.nextSibling;
      current.remove();
      current = following;
    }
  }

  /** Keeps a live text selection attached to its existing Assistant nodes. */
  function selectionTouchesNode(node, selection, pointerActive = false) {
    if (selection === null || (!pointerActive && selection.isCollapsed)) return false;
    return node.contains(selection.anchorNode) || node.contains(selection.focusNode);
  }

  /** Relocate selected text after a Markdown block changes its DOM structure. */
  function relocateSelectionRange(snapshot, text) {
    if (snapshot.selected.length === 0) return undefined;
    if (text.slice(snapshot.start, snapshot.end) === snapshot.selected) {
      return { start: snapshot.start, end: snapshot.end };
    }
    const candidates = [];
    let offset = 0;
    while (offset < text.length) {
      const start = text.indexOf(snapshot.selected, offset);
      if (start < 0) break;
      const before = text.slice(Math.max(0, start - snapshot.before.length), start);
      const after = text.slice(start + snapshot.selected.length,
        start + snapshot.selected.length + snapshot.after.length);
      let prefix = 0;
      while (prefix < Math.min(after.length, snapshot.after.length)
        && after[prefix] === snapshot.after[prefix]) prefix += 1;
      let suffix = 0;
      while (suffix < Math.min(before.length, snapshot.before.length)
        && before[before.length - suffix - 1] === snapshot.before[snapshot.before.length - suffix - 1]) suffix += 1;
      candidates.push({ start, end: start + snapshot.selected.length,
        score: prefix + suffix, distance: Math.abs(start - snapshot.start) });
      offset = start + Math.max(1, snapshot.selected.length);
    }
    candidates.sort((left, right) => right.score - left.score || left.distance - right.distance);
    if (candidates.length === 0 || (candidates.length > 1 && candidates[0].score === candidates[1].score
      && candidates[0].distance === candidates[1].distance)) return undefined;
    return { start: candidates[0].start, end: candidates[0].end };
  }

  /** Removes only an abandoned live Assistant article, leaving durable transcript nodes mounted. */
  function removeAbandonedAssistant(turn, article, body, pendingRenders) {
    if (article?.dataset.liveAssistant !== 'true') return false;
    if (body !== undefined) pendingRenders.delete(body);
    article.remove();
    if (turn !== undefined) {
      if (turn.firstAssistantMessage === article) turn.firstAssistantMessage = undefined;
      if (turn.latestAssistantMessage === article) turn.latestAssistantMessage = turn.firstAssistantMessage;
      turn.pendingProcessSegment = turn.latestAssistantMessage !== undefined && turn.rows.childElementCount > 0;
    }
    return true;
  }

  /** Rebuilds one prepend result from its older fragment and the complete retained tail. */
  function reattachTranscriptTail(output, prependedNodes, tailNodes) {
    output.replaceChildren(...prependedNodes, ...tailNodes);
  }

  /** Builds a host action from the file identity stored on one rendered link. */
  function fileLinkRequest(dataset, action = 'open') {
    const path = dataset?.filePath;
    if (typeof path !== 'string' || path.length === 0
      || !['open', 'openBeside', 'copyPath'].includes(action)) return undefined;
    const line = dataset.fileLine;
    const endLine = dataset.fileEndLine;
    if (line !== undefined && (!Number.isSafeInteger(Number(line)) || Number(line) <= 0)) return undefined;
    if (endLine !== undefined && (line === undefined || !Number.isSafeInteger(Number(endLine))
      || Number(endLine) < Number(line))) return undefined;
    return {
      type: 'openFile', path, action,
      ...(line === undefined ? {} : { line: Number(line) }),
      ...(endLine === undefined ? {} : { endLine: Number(endLine) }),
    };
  }

  /** Projects DSH inbox rows and local submissions without resurrecting committed or removed messages. */
  function projectQueueDock(hostQueue, pendingSubmissions, committedIds, removedIds) {
    const visibleHostQueue = hostQueue.filter((item) => !removedIds.has(item.id)
      && (typeof item.requestId !== 'string' || !committedIds.has(item.requestId)));
    const represented = new Set(visibleHostQueue.map((item) => item.requestId).filter(Boolean));
    return {
      lastQueuedId: visibleHostQueue.filter((item) => item.placement === 'queued' && item.sourceKind === 'user').at(-1)?.id,
      items: [
        ...visibleHostQueue.map((item) => ({ ...item, state: item.sourceKind !== 'user'
          ? `${item.contextLabel ?? 'Context update'} · ${item.placement === 'queued' ? 'Queued' : 'Next step'}`
          : item.placement === 'steering' ? 'Steering' : item.placement === 'context' ? 'Next step' : 'Queued' })),
        ...[...pendingSubmissions].filter((item) => !represented.has(item.requestId)
          && !committedIds.has(item.requestId))
          .map((item) => ({ ...item, state: item.mode === 'steer' ? 'Submitting steering' : 'Submitting' })),
      ],
    };
  }

  /** Retire one provisional subagent row by DSH message id without replacing its DOM identity. */
  function takePendingAgentRow(pendingRows, committedIds, messageId) {
    if (typeof messageId !== 'string' || messageId.length === 0) return undefined;
    committedIds.add(messageId);
    const pending = pendingRows.get(messageId);
    pendingRows.delete(messageId);
    return pending?.row;
  }

  /** Place each still-waiting non-user message in the running Turn once, not in the composer queue. */
  function appendPendingAgentRows(turn, turnNumber, items, pendingRows, committedIds, activate, createRow) {
    if (turn === undefined || turn.completed) return false;
    let added = false;
    for (const item of items) {
      if (item.sourceKind === 'user' || item.placement !== 'steering'
        || committedIds.has(item.id) || pendingRows.has(item.id)) continue;
      activate(turn);
      const row = createRow(item);
      row.root.dataset.state = 'pending';
      turn.rows.append(row.root);
      pendingRows.set(item.id, { row, turnNumber });
      added = true;
    }
    return added;
  }

  /** Replace a provisional row's status and move that same disclosure to its committed Step. */
  function settleAgentMessageRow(pendingRows, committedIds, messageId, turnRows, label, detail, createRow, summary = 'Delivered') {
    const pending = takePendingAgentRow(pendingRows, committedIds, messageId);
    const row = pending ?? createRow();
    if (pending !== undefined) {
      delete row.root.dataset.state;
      row.root.querySelector('.row-title').textContent = label;
      row.summary.textContent = summary;
      row.detail.textContent = detail;
    }
    turnRows.append(row.root);
    return row;
  }

  /** Drop provisional disclosures for an ended Turn or a transcript reset. */
  function clearPendingAgentRows(pendingRows, turnNumber) {
    for (const [id, pending] of pendingRows) {
      if (turnNumber !== undefined && pending.turnNumber !== turnNumber) continue;
      pending.row.root.remove();
      pendingRows.delete(id);
    }
  }

  /** A next-Turn occurrence can move into the current running Turn. */
  function canSteerQueued(item, running) {
    return running && item?.placement === 'queued';
  }

  /** The draft prefix steers even at idle; Ctrl steers only during a running Turn. */
  function submitModeForGesture(running, ctrlKey, draft = '', compacting = false) {
    if (compacting && !running) return 'queue';
    return draft.startsWith('!') || running && ctrlKey ? 'steer' : 'queue';
  }

  /** Holds a local compact request until a live DSH start marker or settlement. */
  function createCompactionSubmitGate() {
    let awaitingStart = false;
    return {
      get locked() { return awaitingStart; },
      request() { awaitingStart = true; },
      observe(event) {
        if (!awaitingStart || event.type !== 'start' || event.live !== true) return false;
        awaitingStart = false;
        return true;
      },
      settle() {
        const wasLocked = awaitingStart;
        awaitingStart = false;
        return wasLocked;
      },
    };
  }

  /** Remove only the leading steering marker before DSH receives the prompt. */
  function submittedPromptText(draft) {
    return (draft.startsWith('!') ? draft.slice(1) : draft).trim();
  }

  /** Projects only actionable fields from a Tool call; never echoes file content or infers shell effects. */
  function approvalOperation(toolName, detail) {
    const action = toolName === 'write' ? 'Write file (write)'
      : toolName === 'edit' ? 'Edit file (edit)'
        : toolName === 'bash' ? 'Run Bash command (bash)'
          : toolName === 'pwsh' ? 'Run PowerShell command (pwsh)' : toolName;
    const base = { action };
    if (typeof detail !== 'string') return base;
    let args;
    try {
      args = JSON.parse(detail);
    } catch (_error) {
      return base;
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return base;
    const path = (toolName === 'write' || toolName === 'edit')
      && typeof args.file_path === 'string' && args.file_path.length > 0
      ? { targetLabel: 'Requested path', target: args.file_path } : {};
    const command = (toolName === 'bash' || toolName === 'pwsh')
      && typeof args.command === 'string' && args.command.length > 0
      ? { targetLabel: 'Command', target: args.command } : {};
    const access = args.sandbox_permissions === 'workspace-write' ? 'Workspace write for this call'
      : args.sandbox_permissions === 'danger-full-access' ? 'Full access for this call' : undefined;
    return { ...base, ...path, ...command, ...(access === undefined ? {} : { access }) };
  }

  globalThis.dshCompanionTranscriptState = Object.freeze({
    activityStatusText,
    advanceTurnProcessSegment,
    appendPendingAgentRows,
    approvalOperation,
    canSteerQueued,
    clearPendingAgentRows,
    createCompactionSubmitGate,
    createScrollBoundsRefresher,
    fileLinkRequest,
    mergePrependedTurnState,
    placeEmptyTurnProcessAfterMessage,
    placeUserMessageBeforeTurn,
    projectQueueDock,
    takePendingAgentRow,
    reconcileTranscriptNodes,
    removeAbandonedAssistant,
    reattachTranscriptTail,
    relocateSelectionRange,
    scrollModeAfterScroll,
    selectReasoningStatusSegment,
    selectionTouchesNode,
    sendActionForGesture,
    settleAgentMessageRow,
    splitTurnProcessAtBoundary,
    submitModeForGesture,
    submittedPromptText,
  });
})();
