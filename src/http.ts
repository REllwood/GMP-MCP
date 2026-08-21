export async function readResponseBytes(
  response: Response,
  maxBytes: number,
  serviceName: string
): Promise<ArrayBuffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const sizeBytes = Number(contentLength);
    if (Number.isFinite(sizeBytes) && sizeBytes > maxBytes) {
      throw new Error(
        `${serviceName} download content-length exceeded GMP_MAX_DOWNLOAD_BYTES (${maxBytes}).`
      );
    }
  }

  if (!response.body) {
    return new ArrayBuffer(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(
          `${serviceName} download exceeded GMP_MAX_DOWNLOAD_BYTES (${maxBytes}).`
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}
