/** Validated one-shot approval answers from the chat Webview. */

export interface AnswerApprovalMessage {
  readonly type: 'answerApproval';
  readonly token: string;
  readonly outcome: 'allowed-once' | 'rejected';
}

/** Accept only one answer for a process-local pending approval token. */
export function isAnswerApprovalMessage(value: unknown): value is AnswerApprovalMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 3
    && Reflect.get(value, 'type') === 'answerApproval'
    && typeof Reflect.get(value, 'token') === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(Reflect.get(value, 'token'))
    && (Reflect.get(value, 'outcome') === 'allowed-once' || Reflect.get(value, 'outcome') === 'rejected');
}
