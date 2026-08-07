import { MAX_SUBAGENT_IMAGE_CHARACTERS } from './contracts/ipc';
import type {
  RuntimeMessage,
  RuntimeTool,
  SubagentChildEvent,
  SubagentRun,
} from './contracts/ipc';

export const MAX_SUBAGENT_ACTIVITY = 120;
export const MAX_SUBAGENT_FIELD_CHARACTERS = 32_000;
export const MAX_SUBAGENT_TRANSCRIPT_CHARACTERS = 256_000;

const TRUNCATED = '\n… subagent transcript truncated …\n';

function boundField(value: string, maximum = MAX_SUBAGENT_FIELD_CHARACTERS): { value: string; truncated: boolean } {
  if (value.length <= maximum) return { value, truncated: false };
  if (maximum <= 0) return { value: '', truncated: true };
  if (maximum <= TRUNCATED.length) return { value: TRUNCATED.slice(0, maximum), truncated: true };
  const available = maximum - TRUNCATED.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return { value: `${value.slice(0, head)}${TRUNCATED}${tail > 0 ? value.slice(-tail) : ''}`, truncated: true };
}

function positionOf(item: RuntimeMessage | RuntimeTool): number {
  if ('startedAt' in item) return item.timelinePosition ?? item.startedAt;
  return item.timelinePosition ?? item.timestamp;
}

function nextPosition(run: SubagentRun): number {
  let maximum = -1;
  for (const message of run.messages) maximum = Math.max(maximum, positionOf(message));
  for (const tool of run.tools) maximum = Math.max(maximum, positionOf(tool));
  return maximum + 1;
}

function textCost(run: SubagentRun): number {
  return run.messages.reduce((total, message) => total + message.text.length + (message.reasoning?.length ?? 0), 0)
    + run.tools.reduce((total, tool) => total + tool.input.length + tool.output.length, 0)
    + (run.error?.length ?? 0);
}

function boundActivityImages(
  inputMessages: readonly RuntimeMessage[],
  inputTools: readonly RuntimeTool[],
  maximum: number,
): { messages: RuntimeMessage[]; tools: RuntimeTool[]; remaining: number; truncated: boolean } {
  const messages = inputMessages.map((message) => ({ ...message }));
  const tools = inputTools.map((tool) => ({ ...tool }));
  const ordered = [
    ...messages.map((item) => ({ kind: 'message' as const, id: item.id, position: positionOf(item) })),
    ...tools.map((item) => ({ kind: 'tool' as const, id: item.id, position: positionOf(item) })),
  ].sort((left, right) => right.position - left.position);
  let remaining = maximum;
  let truncated = false;

  for (const activity of ordered) {
    if (activity.kind === 'message') {
      const index = messages.findIndex((message) => message.id === activity.id);
      const message = messages[index];
      if (!message?.images?.length) continue;
      const images = message.images.filter((image) => {
        if (image.data.length > remaining) return false;
        remaining -= image.data.length;
        return true;
      });
      if (images.length === message.images.length) continue;
      const { images: _images, ...withoutImages } = message;
      messages[index] = {
        ...withoutImages,
        text: withoutImages.text || (!withoutImages.reasoning && images.length === 0 ? '[Image omitted from bounded child transcript.]' : ''),
        ...(images.length ? { images } : {}),
      };
      truncated = true;
    } else {
      const index = tools.findIndex((tool) => tool.id === activity.id);
      const tool = tools[index];
      if (!tool?.images?.length) continue;
      const images = tool.images.filter((image) => {
        if (image.data.length > remaining) return false;
        remaining -= image.data.length;
        return true;
      });
      if (images.length === tool.images.length) continue;
      const { images: _images, ...withoutImages } = tool;
      tools[index] = {
        ...withoutImages,
        output: withoutImages.output || (images.length === 0 ? '[Image omitted from bounded child transcript.]' : ''),
        outputTruncated: true,
        ...(images.length ? { images } : {}),
      };
      truncated = true;
    }
  }

  return { messages, tools, remaining, truncated };
}

/** Keep child transcripts safe for IPC, renderer memory, and parent-session tool details. */
export function boundSubagentRun(input: SubagentRun): SubagentRun {
  let truncated = input.transcriptTruncated;
  let messages = input.messages.map((message) => {
    const text = boundField(message.text);
    const reasoning = message.reasoning === undefined ? undefined : boundField(message.reasoning);
    truncated ||= text.truncated || reasoning?.truncated === true;
    return {
      ...message,
      text: text.value,
      ...(reasoning === undefined ? {} : { reasoning: reasoning.value }),
    };
  });
  let tools = input.tools.map((tool) => {
    const toolInput = boundField(tool.input);
    const output = boundField(tool.output);
    truncated ||= toolInput.truncated || output.truncated;
    return {
      ...tool,
      input: toolInput.value,
      output: output.value,
      outputTruncated: tool.outputTruncated || output.truncated,
    };
  });
  const error = input.error === undefined ? undefined : boundField(input.error, 4_000);
  truncated ||= error?.truncated === true;

  const ordered = [
    ...messages.map((item) => ({ kind: 'message' as const, id: item.id, position: positionOf(item) })),
    ...tools.map((item) => ({ kind: 'tool' as const, id: item.id, position: positionOf(item) })),
  ].sort((left, right) => left.position - right.position);
  const removed = Math.max(0, ordered.length - MAX_SUBAGENT_ACTIVITY);
  if (removed > 0) {
    const retained = new Set(ordered.slice(removed).map((item) => `${item.kind}:${item.id}`));
    messages = messages.filter((item) => retained.has(`message:${item.id}`));
    tools = tools.filter((item) => retained.has(`tool:${item.id}`));
    truncated = true;
  }

  const boundedImages = boundActivityImages(messages, tools, MAX_SUBAGENT_IMAGE_CHARACTERS);
  messages = boundedImages.messages;
  tools = boundedImages.tools;
  truncated ||= boundedImages.truncated;

  let bounded: SubagentRun = {
    ...input,
    messages,
    tools,
    ...(error === undefined ? {} : { error: error.value }),
    omittedActivity: input.omittedActivity + removed,
    transcriptTruncated: truncated,
  };

  if (textCost(bounded) <= MAX_SUBAGENT_TRANSCRIPT_CHARACTERS) return bounded;

  let budget = MAX_SUBAGENT_TRANSCRIPT_CHARACTERS;
  const spend = (value: string): string => {
    if (!value) return value;
    if (budget <= TRUNCATED.length) return '';
    const allowed = Math.min(value.length, budget);
    budget -= allowed;
    if (allowed === value.length) return value;
    truncated = true;
    return boundField(value, allowed).value;
  };
  const newest = [
    ...bounded.messages.map((item) => ({ kind: 'message' as const, item, position: positionOf(item) })),
    ...bounded.tools.map((item) => ({ kind: 'tool' as const, item, position: positionOf(item) })),
  ].sort((left, right) => right.position - left.position);
  const nextMessages = new Map<string, RuntimeMessage>();
  const nextTools = new Map<string, RuntimeTool>();

  if (bounded.error) bounded = { ...bounded, error: spend(bounded.error) };
  for (const activity of newest) {
    if (activity.kind === 'message') {
      nextMessages.set(activity.item.id, {
        ...activity.item,
        text: spend(activity.item.text),
        ...(activity.item.reasoning === undefined ? {} : { reasoning: spend(activity.item.reasoning) }),
      });
    } else {
      const output = spend(activity.item.output);
      nextTools.set(activity.item.id, {
        ...activity.item,
        output,
        input: spend(activity.item.input),
        outputTruncated: activity.item.outputTruncated || output.length < activity.item.output.length,
      });
    }
  }
  return {
    ...bounded,
    messages: bounded.messages.map((item) => nextMessages.get(item.id) ?? item),
    tools: bounded.tools.map((item) => nextTools.get(item.id) ?? item),
    transcriptTruncated: true,
  };
}

/** Share one image-memory budget across all child runs in a parent session. */
export function boundSubagentRuns(inputs: readonly SubagentRun[]): SubagentRun[] {
  const runs = inputs.map(boundSubagentRun);
  const newestFirst = runs
    .map((run, index) => ({ index, updatedAt: run.updatedAt, createdAt: run.createdAt }))
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.index - left.index);
  let remaining = MAX_SUBAGENT_IMAGE_CHARACTERS;
  for (const entry of newestFirst) {
    const run = runs[entry.index]!;
    const boundedImages = boundActivityImages(run.messages, run.tools, remaining);
    remaining = boundedImages.remaining;
    if (!boundedImages.truncated) continue;
    runs[entry.index] = boundSubagentRun({
      ...run,
      messages: boundedImages.messages,
      tools: boundedImages.tools,
      transcriptTruncated: true,
    });
  }
  return runs;
}

export function applySubagentChildEvent(input: SubagentRun, event: SubagentChildEvent): SubagentRun {
  let run = input;
  const updatedAt = Math.max(input.updatedAt, event.timestamp);
  const messageIndex = 'messageId' in event ? input.messages.findIndex((message) => message.id === event.messageId) : -1;
  const toolIndex = 'toolCallId' in event ? input.tools.findIndex((tool) => tool.id === event.toolCallId) : -1;

  if (event.type === 'message.started') {
    if (messageIndex === -1 && event.role !== 'tool') {
      run = {
        ...run,
        updatedAt,
        messages: [...run.messages, {
          id: event.messageId,
          role: event.role,
          text: '',
          timestamp: event.timestamp,
          timelinePosition: nextPosition(run),
        }],
      };
    }
  } else if (event.type === 'assistant.text' || event.type === 'assistant.reasoning') {
    const existing = messageIndex >= 0 ? run.messages[messageIndex]! : {
      id: event.messageId,
      role: 'assistant' as const,
      text: '',
      timestamp: event.timestamp,
      timelinePosition: nextPosition(run),
    };
    const messages = [...run.messages];
    const next = event.type === 'assistant.text'
      ? { ...existing, text: existing.text + event.delta }
      : { ...existing, reasoning: (existing.reasoning ?? '') + event.delta };
    if (messageIndex >= 0) messages[messageIndex] = next;
    else messages.push(next);
    run = { ...run, updatedAt, messages };
  } else if (event.type === 'message.completed') {
    if (event.role !== 'tool') {
      const existing = messageIndex >= 0 ? run.messages[messageIndex] : undefined;
      const messages = [...run.messages];
      const next: RuntimeMessage = {
        id: event.messageId,
        role: event.role,
        text: event.text,
        timestamp: existing?.timestamp ?? event.timestamp,
        timelinePosition: existing?.timelinePosition ?? nextPosition(run),
        ...(existing?.reasoning === undefined ? {} : { reasoning: existing.reasoning }),
        ...(event.images === undefined ? {} : { images: event.images }),
        ...(event.error === undefined ? {} : { error: event.error }),
      };
      if (messageIndex >= 0) messages[messageIndex] = next;
      else messages.push(next);
      run = { ...run, updatedAt, messages };
    }
  } else if (event.type === 'tool.started') {
    const tools = [...run.tools];
    const next: RuntimeTool = {
      id: event.toolCallId,
      name: event.name,
      input: event.input,
      output: '',
      outputTruncated: false,
      status: 'running',
      startedAt: event.timestamp,
      updatedAt: event.timestamp,
      timelinePosition: toolIndex >= 0 ? tools[toolIndex]?.timelinePosition : nextPosition(run),
      ...(event.subagentRunIds === undefined ? {} : { subagentRunIds: event.subagentRunIds }),
      ...(event.provenance === undefined ? {} : { provenance: event.provenance }),
    };
    if (toolIndex >= 0) tools[toolIndex] = next;
    else tools.push(next);
    run = { ...run, updatedAt, tools };
  } else if (event.type === 'tool.updated') {
    const existing = toolIndex >= 0 ? run.tools[toolIndex]! : {
      id: event.toolCallId,
      name: 'Tool',
      input: '',
      output: '',
      outputTruncated: false,
      status: 'running' as const,
      startedAt: event.timestamp,
      updatedAt: event.timestamp,
      timelinePosition: nextPosition(run),
    };
    const tools = [...run.tools];
    const next = {
      ...existing,
      output: event.output,
      updatedAt: event.timestamp,
      ...(event.subagentRunIds === undefined ? {} : { subagentRunIds: event.subagentRunIds }),
      ...((event.provenance ?? existing.provenance) === undefined ? {} : { provenance: event.provenance ?? existing.provenance }),
    };
    if (toolIndex >= 0) tools[toolIndex] = next;
    else tools.push(next);
    run = { ...run, updatedAt, tools };
  } else if (event.type === 'tool.completed') {
    const existing = toolIndex >= 0 ? run.tools[toolIndex] : undefined;
    const tools = [...run.tools];
    const next: RuntimeTool = {
      id: event.toolCallId,
      name: event.name,
      input: existing?.input ?? '',
      output: event.output,
      outputTruncated: false,
      status: event.error ? 'error' : 'succeeded',
      startedAt: existing?.startedAt ?? event.timestamp,
      updatedAt: event.timestamp,
      endedAt: event.timestamp,
      timelinePosition: existing?.timelinePosition ?? nextPosition(run),
      ...(event.images === undefined ? {} : { images: event.images }),
      ...(event.subagentRunIds === undefined ? {} : { subagentRunIds: event.subagentRunIds }),
      ...((event.provenance ?? existing?.provenance) === undefined ? {} : { provenance: event.provenance ?? existing?.provenance }),
    };
    if (toolIndex >= 0) tools[toolIndex] = next;
    else tools.push(next);
    run = { ...run, updatedAt, tools };
  } else if (event.type === 'error') {
    run = { ...run, updatedAt, error: event.error.message };
  } else {
    run = { ...run, updatedAt };
  }

  return boundSubagentRun(run);
}
