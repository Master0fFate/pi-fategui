import type { SkinSurfaceName } from '../../shared/skinStyles';

export const skinSurfaceSelectors: Record<Exclude<SkinSurfaceName, 'global'>, string> = {
  shell: '.app-shell',
  sidebar: '.sidebar',
  conversation: '.conversation',
  composer: '.composer',
  queue: '.queued-messages, .goalmax-steering-messages',
  tasks: '.goalmax-task-strip',
  goal: '.goalmax-flight-deck, .goalmax-rail, .goalmax-editor-dialog, .goalmax-confirm-dialog',
  agents: '.subagent-sessions, .subagent-chat-preview, .agent-workspace-dialog',
  tools: '.tool-card, .tool-history, .subagent-tool',
  activity: '.activity-panel',
  notifications: '.app-toast, .settings-toast, .runtime-notice, .workspace-error, .project-reveal-error, .browser-error-strip, .subagent-error',
  context: '.context-dashboard',
  resources: '.resources-panel, .sidebar-resource-panel',
  music: '.music-dock',
  settings: '.settings-dialog',
  dialogs: ':where([role="dialog"], [role="alertdialog"], [role="menu"], .custom-select-content)',
  modelPicker: '.model-popover, .model-select-content, .provider-dialog-content',
  tooltips: '.tooltip, [role="tooltip"]',
  files: '.files-panel',
  changes: '.changes-panel',
  browser: '.browser-workspace, .browser-toolbar, .browser-annotation-editor',
  learning: '.learning-dialog',
  automations: '.sidebar-automation-panel, .automation-editor',
};

const suffixes = ['control-radius', 'surface-radius', 'padding', 'row-height', 'font-size', 'background', 'border'] as const;
export function surfaceRules(): string {
  return [
    `:root[data-skin-styled] { ${suffixes.map((suffix) => `--surface-${suffix}: var(--skin-global-${suffix});`).join(' ')} }`,
    ...Object.entries(skinSurfaceSelectors).map(([surface, selector]) => `:root[data-skin-styled] :is(${selector}) { ${suffixes.map((suffix) => `--surface-${suffix}: var(--skin-${surface}-${suffix}, var(--skin-global-${suffix}));`).join(' ')} }`),
  ].join('\n');
}
export function ensureSurfaceRules(): void {
  if (document.getElementById('skin-surface-rules')) return;
  const style = document.createElement('style');
  style.id = 'skin-surface-rules';
  style.textContent = surfaceRules();
  document.head.append(style);
}
