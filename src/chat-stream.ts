export async function readChatStream<Result>(response: Response, onDelta: (text: string, mode: string) => void): Promise<Result> {
  if (!response.ok) throw new Error(`Node chat request failed: HTTP ${response.status}`);
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('The node does not support chat streaming; update ainize-node');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: Result | undefined;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) throw new Error('Node chat stream ended unexpectedly');
      buffer += decoder.decode(part.value, { stream: true });
      if (buffer.length > 8388608) throw new Error('Node chat frame exceeds size limit');
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = frame.split(/\r?\n/);
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        if (data === '[DONE]') {
          if (result === undefined) throw new Error('Node omitted the final chat result');
          return result;
        }
        const parsed = JSON.parse(data);
        if (parsed.error) throw new Error(typeof parsed.error === 'string' ? parsed.error : parsed.error.message || 'Node chat stream failed');
        if (lines.some(line => line === 'event: ainize.result')) { result = parsed as Result; continue; }
        if (parsed.object !== 'chat.completion.chunk' || !Array.isArray(parsed.choices)) throw new Error('Invalid node chat chunk');
        for (const choice of parsed.choices) {
          if (typeof choice.delta?.content === 'string') onDelta(choice.delta.content, parsed.ainize_mode ?? 'patched');
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
