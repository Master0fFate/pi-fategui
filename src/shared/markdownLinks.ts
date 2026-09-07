export function isLocalMarkdownLink(value: string): boolean {
  const link = value.trim();
  if (!link || link.startsWith('#') || /^[/\\]{2}/u.test(link)) return false;
  return /^(?:file:|sandbox:|[a-z]:[\\/])/iu.test(link)
    || !/^[a-z][a-z\d+.-]*:/iu.test(link);
}
