export function assertOriginalBrowserSession(original, observed) {
  if (!original || !observed || typeof original.principalId !== 'string' || observed.sessionId !== original.principalId || observed.csrfToken !== original.csrf) {
    throw new Error('Original browser principal/CSRF no longer valid; refuse rebootstrap or ownership substitution');
  }
  return original;
}
