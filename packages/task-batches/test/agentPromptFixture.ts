/** Decode the native implementation command at the fake external agent boundary.
 * Kept independent of the production prompt formatter. */
export function stripImplementationInvocation(prompt: string): string {
  return prompt.replace(/^(?:\/skill:implement |\$implement\n\n)/, '');
}
