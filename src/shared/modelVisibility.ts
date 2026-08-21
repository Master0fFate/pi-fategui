export function modelIdentity(provider: string, id: string): string {
  return `${provider}/${id}`;
}

export function enabledModelIdentity(
  disabledModels: readonly string[] | undefined,
  identity: string | null | undefined,
): string | null {
  if (!identity) return null;
  if (!disabledModels?.length) return identity;
  return disabledModels.includes(identity) ? null : identity;
}

export function isModelDisabled(
  disabledModels: readonly string[] | undefined,
  provider: string,
  id: string,
): boolean {
  return Boolean(disabledModels?.includes(modelIdentity(provider, id)));
}

export function disabledModelMessage(provider: string, id: string): string {
  return `Model ${provider}/${id} is disabled in Fate UI settings. Call subagent_catalog for enabled models.`;
}

export function visibleModels<T extends { provider: string; id: string }>(
  models: readonly T[],
  disabledModels: readonly string[] | undefined,
): T[] {
  if (!disabledModels?.length) return models as T[];
  const hidden = new Set(disabledModels);
  return models.filter((model) => !hidden.has(modelIdentity(model.provider, model.id)));
}
