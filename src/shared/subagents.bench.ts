import { bench, describe } from 'vitest';
import { MAX_SUBAGENT_IMAGE_CHARACTERS, type RuntimeMessage, type RuntimeTool, type SubagentRun } from './contracts/ipc';
import {
  MAX_SUBAGENT_ACTIVITY,
  MAX_SUBAGENT_FIELD_CHARACTERS,
  MAX_SUBAGENT_TRANSCRIPT_CHARACTERS,
  applySubagentChildEvent,
  boundSubagentRun,
} from './subagents';

const TRUNCATED = '\n… subagent transcript truncated …\n';

function legacyBoundField(value: string, maximum = MAX_SUBAGENT_FIELD_CHARACTERS): { value: string; truncated: boolean } {
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

function legacyTextCost(run: SubagentRun): number {
  return run.messages.reduce((total, message) => total + message.text.length + (message.reasoning?.length ?? 0), 0)
    + run.tools.reduce((total, tool) => total + tool.input.length + tool.output.length, 0)
    + (run.error?.length ?? 0);
}

function legacyBoundActivityImages(
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

/** The pre-optimization implementation, retained only as the benchmark control. */
function legacyBoundSubagentRun(input: SubagentRun): SubagentRun {
  let truncated = input.transcriptTruncated;
  let messages = input.messages.map((message) => {
    const text = legacyBoundField(message.text);
    const reasoning = message.reasoning === undefined ? undefined : legacyBoundField(message.reasoning);
    truncated ||= text.truncated || reasoning?.truncated === true;
    return {
      ...message,
      text: text.value,
      ...(reasoning === undefined ? {} : { reasoning: reasoning.value }),
    };
  });
  let tools = input.tools.map((tool) => {
    const toolInput = legacyBoundField(tool.input);
    const output = legacyBoundField(tool.output);
    truncated ||= toolInput.truncated || output.truncated;
    return {
      ...tool,
      input: toolInput.value,
      output: output.value,
      outputTruncated: tool.outputTruncated || output.truncated,
    };
  });
  const error = input.error === undefined ? undefined : legacyBoundField(input.error, 4_000);
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

  const boundedImages = legacyBoundActivityImages(messages, tools, MAX_SUBAGENT_IMAGE_CHARACTERS);
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

  if (legacyTextCost(bounded) <= MAX_SUBAGENT_TRANSCRIPT_CHARACTERS) return bounded;

  let budget = MAX_SUBAGENT_TRANSCRIPT_CHARACTERS;
  const spend = (value: string): string => {
    if (!value) return value;
    if (budget <= TRUNCATED.length) return '';
    const allowed = Math.min(value.length, budget);
    budget -= allowed;
    if (allowed === value.length) return value;
    truncated = true;
    return legacyBoundField(value, allowed).value;
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

function makeRun(withImages: boolean): SubagentRun {
  const imageData = 'a'.repeat(220_000);
  const messages: RuntimeMessage[] = Array.from({ length: 60 }, (_, index) => ({
    id: `message-${index}`,
    role: 'assistant',
    text: `message ${index}`,
    reasoning: index % 4 === 0 ? `reasoning ${index}` : undefined,
    timestamp: index * 2,
    timelinePosition: index * 2,
    ...(withImages && index % 3 === 0 ? { images: [{ data: imageData, mimeType: 'image/png' as const }] } : {}),
  }));
  const tools: RuntimeTool[] = Array.from({ length: 60 }, (_, index) => ({
    id: `tool-${index}`,
    name: index % 2 === 0 ? 'read' : 'grep',
    input: `input ${index}`,
    output: `output ${index}`,
    outputTruncated: false,
    status: 'succeeded',
    startedAt: index * 2 + 1,
    updatedAt: index * 2 + 1,
    timelinePosition: index * 2 + 1,
    ...(withImages && index % 3 === 1 ? { images: [{ data: imageData, mimeType: 'image/png' as const }] } : {}),
  }));
  return {
    id: 'benchmark', parentSessionId: 'parent', parentToolCallId: 'parent-tool', task: 'benchmark',
    role: 'worker', agentName: 'worker', agentSource: 'direct', permissionLevel: 'read-only',
    enabledTools: ['read', 'grep'], skills: [], skillMode: 'all', preloadedSkills: [], status: 'running',
    model: { provider: 'test', id: 'test', name: 'test', reasoning: true, contextWindow: 100_000, supportsImages: true },
    routingModels: [], thinkingLevel: 'medium', executionMode: 'managed', controlCount: 0, attempt: 1,
    maxAttempts: 1, mailbox: { state: 'disabled', ttlMs: 0, followUpCount: 0 }, notification: 'never',
    dependsOn: [], createdAt: 1, updatedAt: 120, messages, tools, omittedActivity: 0,
    transcriptTruncated: false,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
}

function legacyTextUpdate(run: SubagentRun): SubagentRun {
  const messages = [...run.messages];
  const existing = messages[59]!;
  messages[59] = { ...existing, text: `${existing.text}.` };
  return legacyBoundSubagentRun({ ...run, updatedAt: 121, messages });
}

function candidateTextUpdate(run: SubagentRun): SubagentRun {
  return applySubagentChildEvent(run, {
    type: 'assistant.text', messageId: 'message-59', delta: '.', timestamp: 121,
  });
}

const textRun = makeRun(false);
const imageRun = makeRun(true);
const legacyTextResult = legacyTextUpdate(textRun);
const candidateTextResult = candidateTextUpdate(textRun);
const legacyImageResult = legacyBoundSubagentRun(imageRun);
const candidateImageResult = boundSubagentRun(imageRun);

if (JSON.stringify(legacyTextResult) !== JSON.stringify(candidateTextResult)
  || JSON.stringify(legacyImageResult) !== JSON.stringify(candidateImageResult)) {
  throw new Error('Benchmark control and candidate results differ.');
}

function retainedActivityReferences(input: SubagentRun, output: SubagentRun): number {
  const messages = new Map(input.messages.map((message) => [message.id, message]));
  const tools = new Map(input.tools.map((tool) => [tool.id, tool]));
  return output.messages.filter((message) => messages.get(message.id) === message).length
    + output.tools.filter((tool) => tools.get(tool.id) === tool).length;
}

function cpuMillisecondsPerOperation(operation: () => void, iterations: number): number {
  const start = process.cpuUsage();
  for (let iteration = 0; iteration < iterations; iteration += 1) operation();
  const usage = process.cpuUsage(start);
  return (usage.user + usage.system) / 1_000 / iterations;
}

function pairedCpuSamples(original: () => void, candidate: () => void): { original: number[]; candidate: number[] } {
  const iterations = 10_000;
  const originalSamples: number[] = [];
  const candidateSamples: number[] = [];
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    original();
    candidate();
  }
  for (let repetition = 0; repetition < 5; repetition += 1) {
    if (repetition % 2 === 0) {
      originalSamples.push(cpuMillisecondsPerOperation(original, iterations));
      candidateSamples.push(cpuMillisecondsPerOperation(candidate, iterations));
    } else {
      candidateSamples.push(cpuMillisecondsPerOperation(candidate, iterations));
      originalSamples.push(cpuMillisecondsPerOperation(original, iterations));
    }
  }
  return { original: originalSamples, candidate: candidateSamples };
}

function median(samples: number[]): number {
  return [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)]!;
}

const textCpu = pairedCpuSamples(() => { legacyTextUpdate(textRun); }, () => { candidateTextUpdate(textRun); });
const imageCpu = pairedCpuSamples(() => { legacyBoundSubagentRun(imageRun); }, () => { boundSubagentRun(imageRun); });

console.log(JSON.stringify({
  note: 'CPU is process user+system time. Retained object identities are an allocation proxy; heap bytes are not measured.',
  cpuMillisecondsPerOperation: {
    textUpdate: { originalMedian: median(textCpu.original), candidateMedian: median(textCpu.candidate), repetitions: 5, iterationsPerRepetition: 10_000 },
    imageBounding: { originalMedian: median(imageCpu.original), candidateMedian: median(imageCpu.candidate), repetitions: 5, iterationsPerRepetition: 10_000 },
  },
  textUpdateRetainedReferences: {
    original: retainedActivityReferences(textRun, legacyTextResult),
    candidate: retainedActivityReferences(textRun, candidateTextResult),
    total: 120,
  },
  imageBoundingRetainedReferences: {
    original: retainedActivityReferences(imageRun, legacyImageResult),
    candidate: retainedActivityReferences(imageRun, candidateImageResult),
    total: 120,
  },
}));

const options = { time: 1_000, warmupTime: 250 };

describe('120 mixed activity text-only child update', () => {
  bench('original', () => { legacyTextUpdate(textRun); }, options);
  bench('candidate', () => { candidateTextUpdate(textRun); }, options);
});

describe('120 mixed activity image bounding', () => {
  bench('original', () => { legacyBoundSubagentRun(imageRun); }, options);
  bench('candidate', () => { boundSubagentRun(imageRun); }, options);
});
