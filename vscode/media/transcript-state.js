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

  globalThis.dshCompanionTranscriptState = Object.freeze({
    mergePrependedTurnState,
    placeTurnProcessAfterMessage,
  });
})();
