/** Local speech PCM is always 16 kHz mono Float32. */
export const SPEECH_SAMPLE_RATE = 16_000;
export const SPEECH_PCM_BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT;

/** One IPC/native stream feed can contain at most two seconds of PCM. */
export const MAX_SPEECH_STREAM_FEED_SAMPLES = SPEECH_SAMPLE_RATE * 2;

/**
 * A continuously slow streaming engine cannot retain an unlimited recording.
 * Keep at most five bounded feeds (ten seconds) at either async boundary,
 * including the feed being processed. Exceeding this is a clear failure, never
 * silent audio loss; normal stop still drains every accepted sample in order.
 */
export const MAX_SPEECH_STREAM_BACKLOG_SAMPLES = MAX_SPEECH_STREAM_FEED_SAMPLES * 5;
