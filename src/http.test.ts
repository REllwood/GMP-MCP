import { describe, expect, it } from "vitest";

import { readResponseBytes } from "./http.js";

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
