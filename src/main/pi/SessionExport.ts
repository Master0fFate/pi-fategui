export const SESSION_EXPORT_FIELD_LIMIT = 8_000;

export interface SessionExportMessage {
  role: string;
  text: string;
}

export interface SessionExportTool {
  name: string;
  status: string;
  output: string;
}

export interface SessionExportInput {
  sessionId: string | null;
  title?: string | null;
  projectPath?: string | null;
  model?: string | null;
  permissionLevel?: string | null;
  messages: readonly SessionExportMessage[];
  tools: readonly SessionExportTool[];
  error?: string | null;
}

export interface SessionExportArtifact {
  markdown: string;
  json: string;
}

export function boundExportText(value: string, limit = SESSION_EXPORT_FIELD_LIMIT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… truncated …`;
}

export function sessionExportOutcome(input: SessionExportInput): string {
  if (input.error) return boundExportText(input.error);
  const lastAssistant = [...input.messages].reverse().find((message) => message.role === 'assistant' && message.text.trim());
  if (lastAssistant) return boundExportText(lastAssistant.text.trim());
  return 'No assistant outcome yet.';
}

export function buildSessionExport(input: SessionExportInput): SessionExportArtifact {
  const payload = {
    sessionId: input.sessionId,
    title: input.title ?? null,
    projectPath: input.projectPath ?? null,
    model: input.model ?? null,
    permissionLevel: input.permissionLevel ?? null,
    outcome: sessionExportOutcome(input),
    messages: input.messages.map((message) => ({ role: message.role, text: boundExportText(message.text) })),
    tools: input.tools.map((tool) => ({
      name: tool.name,
      status: tool.status,
      output: boundExportText(tool.output),
    })),
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const lines = [
    '# Fate UI session export',
    '',
    `- Session: ${payload.sessionId ?? 'none'}`,
    `- Title: ${payload.title ?? 'untitled'}`,
    `- Project: ${payload.projectPath ?? 'none'}`,
    `- Model: ${payload.model ?? 'none'}`,
    `- Permission: ${payload.permissionLevel ?? 'none'}`,
    `- Outcome: ${payload.outcome}`,
    '',
    '## Messages',
  ];
  if (payload.messages.length === 0) lines.push('', '_No messages._');
  for (const message of payload.messages) {
    lines.push('', `### ${message.role}`, '', message.text || '_empty_');
  }
  lines.push('', '## Tools');
  if (payload.tools.length === 0) lines.push('', '_No tools._');
  for (const tool of payload.tools) {
    lines.push('', `### ${tool.name} (${tool.status})`, '', tool.output || '_no output_');
  }
  lines.push('');
  return { markdown: lines.join('\n'), json };
}
