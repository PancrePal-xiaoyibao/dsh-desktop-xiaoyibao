/**
 * 解析 SSE（Server-Sent Events）流式响应，逐 token 回调
 *
 * 处理了跨 chunk 数据分割的边界情况
 */
export async function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onToken: (token: string) => void
): Promise<string> {
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');

    // 保留最后一行（可能不完整）
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;

      const dataStr = line.slice(6).trim();
      if (dataStr === '[DONE]') continue;

      try {
        const data = JSON.parse(dataStr);
        const content = data.choices?.[0]?.delta?.content || '';
        if (content) {
          fullText += content;
          onToken(content);
        }
      } catch {
        // 忽略无效 JSON（SSE 心跳等）
      }
    }
  }

  return fullText;
}
