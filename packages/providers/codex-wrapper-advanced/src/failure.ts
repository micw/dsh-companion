/** Classify the wrapper's legacy unstructured upstream transport failures. */

/**
 * Recognize only known network-read failures when the wrapper did not mark an
 * event retryable. Authentication, protocol, and arbitrary provider errors stay terminal.
 */
export function codexFailureCode(message: string, retryable: boolean): string {
  if (retryable) return 'PROVIDER_UNAVAILABLE'
  if (/^stream error: Transport error: network error: error decoding response body$/u.test(message)) {
    return 'TRANSPORT'
  }
  return 'PROVIDER_ERROR'
}
