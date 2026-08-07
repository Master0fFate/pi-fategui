import type { CodeFont, InterfaceFont } from '../shared/contracts/ipc';

const notoSansFallback = '"Noto Sans Variable", "Noto Sans Hebrew Variable", "Noto Sans SC Variable", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const notoCodeFallback = '"Noto Sans Mono Variable", "Noto Sans Variable", "Noto Sans Hebrew Variable", "Noto Sans SC Variable", ui-monospace, SFMono-Regular, Consolas, monospace';

const interfaceFamilies: Record<InterfaceFont, string> = {
  'noto-sans': notoSansFallback,
  system: `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", ${notoSansFallback}`,
  inter: `"Inter Variable", ${notoSansFallback}`,
  poppins: `"Poppins", ${notoSansFallback}`,
  montserrat: `"Montserrat Variable", ${notoSansFallback}`,
  'jetbrains-mono': `"JetBrains Mono Variable", ${notoCodeFallback}`,
};

const codeFamilies: Record<CodeFont, string> = {
  'jetbrains-mono': `"JetBrains Mono Variable", ${notoCodeFallback}`,
  'noto-sans-mono': notoCodeFallback,
  'system-mono': `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, ${notoCodeFallback}`,
};

const optionalInterfaceFontLoaders: Partial<Record<InterfaceFont, () => Promise<unknown>>> = {
  inter: () => import('@fontsource-variable/inter/wght.css'),
  montserrat: () => import('@fontsource-variable/montserrat/wght.css'),
  poppins: () => import('./styles/poppins.css'),
};
const optionalInterfaceFontLoads = new Map<InterfaceFont, Promise<unknown>>();

function loadOptionalInterfaceFont(interfaceFont: InterfaceFont): void {
  const loader = optionalInterfaceFontLoaders[interfaceFont];
  if (!loader) return;
  let pending = optionalInterfaceFontLoads.get(interfaceFont);
  if (!pending) {
    pending = loader();
    optionalInterfaceFontLoads.set(interfaceFont, pending);
  }
  void pending.catch(() => {
    // The bundled Noto/system stack remains a complete deterministic fallback.
  });
}

export const interfaceFontOptions: ReadonlyArray<{ value: InterfaceFont; label: string; detail: string }> = [
  { value: 'noto-sans', label: 'Noto Sans', detail: 'Global default · extended Unicode' },
  { value: 'system', label: 'System UI', detail: 'Native platform font · Noto fallback' },
  { value: 'inter', label: 'Inter', detail: 'Neutral and highly legible' },
  { value: 'poppins', label: 'Poppins', detail: 'Geometric and friendly' },
  { value: 'montserrat', label: 'Montserrat', detail: 'Structured and distinctive' },
  { value: 'jetbrains-mono', label: 'JetBrains Mono', detail: 'Technical monospace interface' },
];

export const codeFontOptions: ReadonlyArray<{ value: CodeFont; label: string; detail: string }> = [
  { value: 'jetbrains-mono', label: 'JetBrains Mono', detail: 'Bundled developer default' },
  { value: 'noto-sans-mono', label: 'Noto Sans Mono', detail: 'Unicode-forward monospace' },
  { value: 'system-mono', label: 'System Mono', detail: 'Native console stack · Noto fallback' },
];

export function applyFonts(interfaceFont: InterfaceFont, codeFont: CodeFont): void {
  const root = document.documentElement;
  const codeFontChanged = root.dataset.codeFont !== codeFont;
  root.dataset.interfaceFont = interfaceFont;
  root.dataset.codeFont = codeFont;
  root.style.setProperty('--font-interface', interfaceFamilies[interfaceFont]);
  root.style.setProperty('--font-code', codeFamilies[codeFont]);
  loadOptionalInterfaceFont(interfaceFont);
  if (codeFontChanged) window.dispatchEvent(new CustomEvent('fate-font-change', { detail: { interfaceFont, codeFont } }));
}
