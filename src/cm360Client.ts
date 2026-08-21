import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getAccessToken, type AccessTokenProvider } from "./auth.js";
import type { ServerConfig } from "./config.js";
import { readResponseBytes } from "./http.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type QueryValue = string | number | boolean | Array<string | number | boolean> | undefined;
export type QueryParams = Record<string, QueryValue>;

export interface Cm360RequestOptions {
  method: HttpMethod;
  path: string;
  query?: QueryParams;
  body?: unknown;
  responseType?: "json" | "text" | "bytes";
}

export interface Cm360ErrorDetails {
  method: HttpMethod;
  url: string;
  status: number;
  responseBody: string;
}

export class Cm360ApiError extends Error {
  public readonly details: Cm360ErrorDetails;

  public constructor(message: string, details: Cm360ErrorDetails) {
    super(message);
    this.name = "Cm360ApiError";
    this.details = details;
  }
}

export interface DownloadedReportFile {
  filePath: string;
  sizeBytes: number;
  contentType: string | null;
  preview: string;
}

const retryableStatuses = new Set([429, 500, 502, 503, 504]);
const retryableMethods = new Set<HttpMethod>(["GET", "PUT", "DELETE"]);
const maxErrorPreviewBytes = 65_536;

export class Cm360Client {
  private nextRequestAt = 0;

  public constructor(
    private readonly config: ServerConfig,
    private readonly authClient: AccessTokenProvider
  ) {}

  public async request<T = unknown>(options: Cm360RequestOptions): Promise<T> {
    const url = this.buildUrl(options.path, options.query);
    const token = await getAccessToken(this.authClient);
    const headers = new Headers({
      Authorization: `Bearer ${token}`
    });

    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      await this.waitForRateLimit();

      const response = await fetch(url, {
        method: options.method,
        headers,
        body,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs)
      });

      if (response.ok) {
        return this.parseResponse<T>(response, options.responseType);
      }

      if (
        !retryableMethods.has(options.method) ||
        !retryableStatuses.has(response.status) ||
        attempt === this.config.maxRetries
      ) {
        const responseBody = await safeReadResponseText(response);
        throw new Cm360ApiError(
          `CM360 API request failed with HTTP ${response.status}.`,
          {
            method: options.method,
            url: url.toString(),
            status: response.status,
            responseBody
          }
        );
      }

      await sleep(backoffMs(attempt, response));
    }

    throw new Error("CM360 API request exited retry loop unexpectedly.");
  }

  public async downloadReportFile(args: {
    profileId: string;
    reportId: string;
    fileId: string;
    fileName?: string;
    maxPreviewBytes?: number;
  }): Promise<DownloadedReportFile> {
    const bytes = await this.request<ArrayBuffer>({
      method: "GET",
      path: `/userprofiles/${args.profileId}/reports/${args.reportId}/files/${args.fileId}`,
      query: { alt: "media" },
      responseType: "bytes"
    });

    const buffer = Buffer.from(bytes);
    if (buffer.byteLength > this.config.maxDownloadBytes) {
      throw new Error(`CM360 download exceeded GMP_MAX_DOWNLOAD_BYTES (${this.config.maxDownloadBytes}).`);
    }

    const fileName = safeFileName(args.fileName ?? `cm360-report-${args.reportId}-${args.fileId}`);
    const filePath = path.join(this.config.downloadDir, fileName);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);

    const maxPreviewBytes = args.maxPreviewBytes ?? 4096;
    return {
      filePath,
      sizeBytes: buffer.byteLength,
      contentType: null,
      preview: buffer.subarray(0, maxPreviewBytes).toString("utf8")
    };
  }

  public buildUrl(requestPath: string, query: QueryParams = {}): URL {
    const normalisedPath = normaliseApiPath(requestPath);
    const base = this.config.apiBaseUrl.endsWith("/")
      ? this.config.apiBaseUrl.slice(0, -1)
      : this.config.apiBaseUrl;
    const url = new URL(`${base}${normalisedPath}`);

    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) {
        continue;
      }

      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        url.searchParams.append(key, String(item));
      }
    }

    return url;
  }

  private async parseResponse<T>(
    response: Response,
    responseType: Cm360RequestOptions["responseType"] = "json"
  ): Promise<T> {
    if (responseType === "bytes") {
      return this.readBytes(response) as Promise<T>;
    }

    if (responseType === "text") {
      return response.text() as Promise<T>;
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }

    return JSON.parse(text) as T;
  }

  private async waitForRateLimit(): Promise<void> {
    const intervalMs = 1000 / this.config.requestsPerSecond;
    const now = Date.now();
    const waitMs = Math.max(0, this.nextRequestAt - now);
    this.nextRequestAt = Math.max(now, this.nextRequestAt) + intervalMs;

    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }

  private async readBytes(response: Response): Promise<ArrayBuffer> {
    return readResponseBytes(response, this.config.maxDownloadBytes, "CM360");
  }
}

export function normaliseApiPath(requestPath: string): string {
  if (URL.canParse(requestPath)) {
    return normaliseApiPath(new URL(requestPath).pathname);
  }

  if (!requestPath.startsWith("/")) {
    return `/${requestPath}`;
  }

  if (requestPath.startsWith("/dfareporting/v5/")) {
    return requestPath.replace("/dfareporting/v5", "");
  }

  return requestPath;
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  return cleaned || "cm360-report";
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text.length > maxErrorPreviewBytes) {
      return `${text.slice(0, maxErrorPreviewBytes)}...`;
    }

    return text;
  } catch {
    return "";
  }
}

function backoffMs(attempt: number, response: Response): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }

  return Math.min(30_000, 1000 * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
