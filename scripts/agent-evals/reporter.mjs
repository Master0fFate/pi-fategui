export default async function* report(events) {
  for await (const event of events) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      yield `${JSON.stringify({ type: event.type, name: event.data.name, ...(event.type === 'test:fail' ? { error: String(event.data.details?.error ?? 'failed') } : {}) })}\n`;
    }
  }
}
