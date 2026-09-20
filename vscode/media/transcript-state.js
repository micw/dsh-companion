(() => {
  /** Merges an older partial presentation of one Turn into its existing newer presentation. */
  function mergePrependedTurnState(older, newer) {
    const olderRows = [...older.rows.childNodes];
    if (olderRows.length > 0) newer.rows.prepend(...olderRows);
    newer.reasoning = new Map([...older.reasoning, ...newer.reasoning]);
    newer.statuses = new Map([...older.statuses, ...newer.statuses]);
    newer.toolCallIds = new Set([...older.toolCallIds, ...newer.toolCallIds]);
    newer.contextIds = new Set([...older.contextIds, ...newer.contextIds]);
    newer.toolCount = newer.toolCallIds.size;
    newer.contextCount = newer.contextIds.size;
    newer.startedAt = older.startedAt ?? newer.startedAt;
    newer.firstAssistantMessage = older.firstAssistantMessage ?? newer.firstAssistantMessage;
    newer.latestAssistantMessage ??= older.latestAssistantMessage;
    if (newer.rows.childNodes.length > 0 && newer.disclosureRoot !== undefined
      && newer.root !== newer.disclosureRoot) {
      newer.root.replaceWith(newer.disclosureRoot);
      newer.root = newer.disclosureRoot;
      newer.label = newer.disclosureLabel;
    }
    older.root.remove();
    return newer;
  }

  /** Places a Turn's aggregate process disclosure directly after its latest progress message. */
  function placeTurnProcessAfterMessage(turn) {
    const message = turn.latestAssistantMessage;
    if (message === undefined || message.parentNode === null || turn.root.parentNode !== message.parentNode) {
      return false;
    }
    message.after(turn.root);
    return true;
  }

  /** Places a Turn's canonical user message before every rendered item owned by that Turn. */
  function placeUserMessageBeforeTurn(turn, message) {
    const parent = turn.root.parentNode;
    if (parent === null) return false;
    const candidates = [turn.firstAssistantMessage, turn.root]
      .filter(node => node !== undefined && node.parentNode === parent);
    const anchor = [...parent.childNodes].find(node => candidates.includes(node));
    if (anchor === undefined) return false;
    anchor.before(message);
    return true;
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

  globalThis.dshCompanionTranscriptState = Object.freeze({
    activityStatusText,
    mergePrependedTurnState,
    placeTurnProcessAfterMessage,
    placeUserMessageBeforeTurn,
  });
})();
