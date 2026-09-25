import { describe, expect, it } from "vitest";

import { readResponseBytes, retryDelayMs } from "./http.js";

describe("readResponseBytes", () => {
  it("stops a chunked response as soon as it exceeds the configured limit", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
          controller.close();
        }
      })
    );

    await expect(readResponseBytes(response, 5, "Test service")).rejects.toThrow(
      /GMP_MAX_DOWNLOAD_BYTES/
    );
  });

  it("returns a bounded response without relying on content-length", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]));
    const result = await readResponseBytes(response, 3, "Test service");
    expect([...new Uint8Array(result)]).toEqual([1, 2, 3]);
  });
});

describe("retryDelayMs", () => {
  it("honours short Retry-After values and caps long ones", () => {
    expect(retryDelayMs(0, "2")).toBe(2_000);
    expect(retryDelayMs(0, "3600")).toBe(30_000);
  });

  it("understands HTTP-date Retry-After values", () => {
    const now = Date.parse("2026-09-25T12:00:00Z");
    expect(retryDelayMs(0, "Fri, 25 Sep 2026 12:00:05 GMT", now)).toBe(5_000);
    expect(retryDelayMs(0, "Fri, 25 Sep 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("falls back to capped exponential backoff", () => {
    expect(retryDelayMs(2, null)).toBe(4_000);
    expect(retryDelayMs(10, "soon")).toBe(30_000);
    expect(retryDelayMs(1, "-5")).toBe(2_000);
    expect(retryDelayMs(1, "12 13")).toBe(2_000);
  });
});
