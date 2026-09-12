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
  messages: RuntimeMessage[],
  tools: RuntimeTool[],
  maximum: number,
): { messages: RuntimeMessage[]; tools: RuntimeTool[]; remaining: number; truncated: boolean } {
  let hasImages = false;
  for (const message of messages) {
    if (message.images?.length) {
      hasImages = true;
      break;
    }
  }
  if (!hasImages) {
    for (const tool of tools) {
      if (tool.images?.length) {
        hasImages = true;
        break;
      }
    }
  }
  if (!hasImages) return { messages, tools, remaining: maximum, truncated: false };

  const firstMessageIndex = new Map<string, number>();
  const firstToolIndex = new Map<string, number>();
  const ordered = [
    ...messages.map((item, index) => {
      if (!firstMessageIndex.has(item.id)) firstMessageIndex.set(item.id, index);
      return { kind: 'message' as const, id: item.id, position: positionOf(item) };
    }),
    ...tools.map((item, index) => {
      if (!firstToolIndex.has(item.id)) firstToolIndex.set(item.id, index);
      return { kind: 'tool' as const, id: item.id, position: positionOf(item) };
    }),
  ].sort((left, right) => right.position - left.position);
  let nextMessages = messages;
  let nextTools = tools;
  let remaining = maximum;
  let truncated = false;

  for (const activity of ordered) {
    if (activity.kind === 'message') {
      const index = firstMessageIndex.get(activity.id);
      if (index === undefined) continue;
      const message = nextMessages[index];
      if (!message?.images?.length) continue;
      let images: NonNullable<RuntimeMessage['images']> | undefined;
      for (let imageIndex = 0; imageIndex < message.images.length; imageIndex += 1) {
        const image = message.images[imageIndex]!;
        if (image.data.length > remaining) {
          images ??= message.images.slice(0, imageIndex);
        } else {
          remaining -= image.data.length;
          images?.push(image);
        }
      }
      if (images === undefined) continue;
      const { images: _images, ...withoutImages } = message;
      const nextMessage = {
        ...withoutImages,
        text: withoutImages.text || (!withoutImages.reasoning && images.length === 0 ? '[Image omitted from bounded child transcript.]' : ''),
        ...(images.length ? { images } : {}),
      };
      if (nextMessages === messages) nextMessages = messages.slice();
      nextMessages[index] = nextMessage;
      truncated = true;
    } else {
      const index = firstToolIndex.get(activity.id);
      if (index === undefined) continue;
      const tool = nextTools[index];
      if (!tool?.images?.length) continue;
      let images: NonNullable<RuntimeTool['images']> | undefined;
      for (let imageIndex = 0; imageIndex < tool.images.length; imageIndex += 1) {
        const image = tool.images[imageIndex]!;
        if (image.data.length > remaining) {
          images ??= tool.images.slice(0, imageIndex);
        } else {
          remaining -= image.data.length;
          images?.push(image);
        }
      }
      if (images === undefined) continue;
      const { images: _images, ...withoutImages } = tool;
      const nextTool = {
        ...withoutImages,
        output: withoutImages.output || (images.length === 0 ? '[Image omitted from bounded child transcript.]' : ''),
        outputTruncated: true,
        ...(images.length ? { images } : {}),
      };
      if (nextTools === tools) nextTools = tools.slice();
      nextTools[index] = nextTool;
      truncated = true;
    }
  }

  return { messages: nextMessages, tools: nextTools, remaining, truncated };
}

/** Keep child transcripts safe for IPC, renderer memory, and parent-session tool details. */
export function boundSubagentRun(input: SubagentRun): SubagentRun {
  let truncated = input.transcriptTruncated;
  let messages = input.messages;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const text = boundField(message.text);
    const reasoning = message.reasoning === undefined ? undefined : boundField(message.reasoning);
    const fieldTruncated = text.truncated || reasoning?.truncated === true;
    truncated ||= fieldTruncated;
    if (!fieldTruncated) continue;
    if (messages === input.messages) messages = input.messages.slice();
    messages[index] = {
      ...message,
      text: text.value,
      ...(reasoning === undefined ? {} : { reasoning: reasoning.value }),
    };
  }
  let tools = input.tools;
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index]!;
    const toolInput = boundField(tool.input);
    const output = boundField(tool.output);
    const outputTruncated = tool.outputTruncated || output.truncated;
    const fieldTruncated = toolInput.truncated || output.truncated;
    truncated ||= fieldTruncated;
    if (!fieldTruncated && outputTruncated === tool.outputTruncated) continue;
    if (tools === input.tools) tools = input.tools.slice();
    tools[index] = {
      ...tool,
      input: toolInput.value,
      output: output.value,
      outputTruncated,
    };
  }
  const error = input.error === undefined ? undefined : boundField(input.error, 4_000);
  truncated ||= error?.truncated === true;

  const removed = Math.max(0, messages.length + tools.length - MAX_SUBAGENT_ACTIVITY);
  if (removed > 0) {
    const ordered = [
      ...messages.map((item) => ({ kind: 'message' as const, id: item.id, position: positionOf(item) })),
      ...tools.map((item) => ({ kind: 'tool' as const, id: item.id, position: positionOf(item) })),
    ].sort((left, right) => left.position - right.position);
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
