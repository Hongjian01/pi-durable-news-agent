/** Read a bounded, allowlisted error summary. Never retain a raw upstream body or credentials. */
export async function providerErrorDetails(response: Response, apiKey: string) {
  let text = "";
  try {
    const reader = response.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (bytes < 8192) {
          const part = await reader.read();
          if (part.done) break;
          const chunk = part.value.subarray(0, 8192 - bytes);
          chunks.push(chunk);
          bytes += chunk.length;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const data = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      text = new TextDecoder().decode(data);
    }
    const payload = JSON.parse(text),
      error = payload.error ?? payload;
    const redact = (value: unknown, max: number) =>
      typeof value === "string"
        ? value
            .replaceAll(apiKey, "[REDACTED]")
            .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
            .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
            .slice(0, max)
        : undefined;
    return {
      providerMessage: redact(error.message, 500),
      providerCode: typeof error.code === "number" ? error.code : redact(error.code, 80),
      limitSource: redact(error.metadata?.limit_source, 100),
    };
  } catch {
    return {};
  }
}
