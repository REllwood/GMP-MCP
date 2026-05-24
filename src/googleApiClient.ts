import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getAccessToken, type AccessTokenProvider } from "./auth.js";
import type { HttpMethod, QueryParams } from "./cm360Client.js";
import type { ServerConfig } from "./config.js";

export interface GoogleApiRequestOptions {
  method: HttpMethod;
  path: string;
  query?: QueryParams;
  body?: unknown;
  responseType?: "json" | "text" | "bytes";
}

export interface GoogleApiErrorDetails {
  method: HttpMethod;
  url: string;
  status: number;
  responseBody: string;
}

export class GoogleApiError extends Error {
  public readonly details: GoogleApiErrorDetails;

  public constructor(serviceName: string, details: GoogleApiErrorDetails) {
    super(`${serviceName} API request failed with HTTP ${details.status}.`);
    this.name = "GoogleApiError";
    this.details = details;
  }
}

export interface DownloadedFile {
  filePath: string;
  sizeBytes: number;
  contentType: string | null;
  preview: string;
}

const retryableStatuses = new Set([429, 500, 502, 503, 504]);
const maxErrorPreviewBytes = 65_536;

const trustedDownloadHostSuffixes = [".googleapis.com"];
const trustedDownloadHosts = new Set([
  "googleapis.com",
  "storage.googleapis.com",
  "www.googleapis.com"
]);

export class GoogleApiClient {
  private nextRequestAt = 0;

  public constructor(
    private readonly serviceName: string,
    private readonly baseUrl: string,
    private readonly config: ServerConfig,
    private readonly authClient: AccessTokenProvider
  ) {}

  public async request<T = unknown>(options: GoogleApiRequestOptions): Promise<T> {
    const url = this.buildUrl(options.path, options.query);
    return this.fetchUrl<T>(url, options);
  }

  public async download(args: {
    path: string;
    query?: QueryParams;
    fileName: string;
    maxPreviewBytes?: number;
  }): Promise<DownloadedFile> {
    const bytes = await this.request<ArrayBuffer>({
      method: "GET",
      path: args.path,
      query: args.query,
      responseType: "bytes"
    });

    return this.writeDownload(bytes, args.fileName, args.maxPreviewBytes);
  }

  public async downloadFromUrl(args: {
    url: string;
    fileName: string;
    maxPreviewBytes?: number;
  }): Promise<DownloadedFile> {
    const url = new URL(args.url);
    assertTrustedDownloadUrl(url);

    const bytes = await this.fetchUrl<ArrayBuffer>(url, {
      method: "GET",
      path: args.url,
      responseType: "bytes"
    });

    return this.writeDownload(bytes, args.fileName, args.maxPreviewBytes);
  }

  public buildUrl(requestPath: string, query: QueryParams = {}): URL {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl.slice(0, -1) : this.baseUrl;
    const baseUrl = new URL(base);
    const normalisedPath = stripBasePath(normaliseApiPath(requestPath), baseUrl.pathname);
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

  private async fetchUrl<T>(url: URL, options: GoogleApiRequestOptions): Promise<T> {
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

      if (!retryableStatuses.has(response.status) || attempt === this.config.maxRetries) {
        const responseBody = await safeReadResponseText(response);
        throw new GoogleApiError(this.serviceName, {
          method: options.method,
          url: url.toString(),
          status: response.status,
          responseBody
        });
      }

      await sleep(backoffMs(attempt, response));
    }

    throw new Error(`${this.serviceName} API request exited retry loop unexpectedly.`);
  }

  private async writeDownload(
    bytes: ArrayBuffer,
    fileName: string,
    maxPreviewBytes = 4096
  ): Promise<DownloadedFile> {
    const buffer = Buffer.from(bytes);
    if (buffer.byteLength > this.config.maxDownloadBytes) {
      throw new Error(
        `${this.serviceName} download exceeded GMP_MAX_DOWNLOAD_BYTES (${this.config.maxDownloadBytes}).`
      );
    }

    const filePath = path.join(this.config.downloadDir, safeFileName(fileName));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);

    return {
      filePath,
      sizeBytes: buffer.byteLength,
      contentType: null,
      preview: buffer.subarray(0, maxPreviewBytes).toString("utf8")
    };
  }

  private async parseResponse<T>(
    response: Response,
    responseType: GoogleApiRequestOptions["responseType"] = "json"
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
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const sizeBytes = Number(contentLength);
      if (Number.isFinite(sizeBytes) && sizeBytes > this.config.maxDownloadBytes) {
        throw new Error(
          `${this.serviceName} download content-length exceeded GMP_MAX_DOWNLOAD_BYTES (${this.config.maxDownloadBytes}).`
        );
      }
    }

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > this.config.maxDownloadBytes) {
      throw new Error(
        `${this.serviceName} download exceeded GMP_MAX_DOWNLOAD_BYTES (${this.config.maxDownloadBytes}).`
      );
    }

    return bytes;
  }
}

export function normaliseApiPath(requestPath: string): string {
  if (URL.canParse(requestPath)) {
    return new URL(requestPath).pathname;
  }

  if (!requestPath.startsWith("/")) {
    return `/${requestPath}`;
  }

  return requestPath;
}

function stripBasePath(requestPath: string, basePath: string): string {
  if (basePath === "/" || !requestPath.startsWith(`${basePath}/`)) {
    return requestPath;
  }

  return requestPath.slice(basePath.length);
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  return cleaned || "gmp-download";
}

export function assertTrustedDownloadUrl(url: URL): void {
  if (url.protocol !== "https:") {
    throw new Error("Report download URLs must use HTTPS.");
  }

  const hostname = url.hostname.toLowerCase();
  const isTrustedHost =
    trustedDownloadHosts.has(hostname) ||
    trustedDownloadHostSuffixes.some((suffix) => hostname.endsWith(suffix));

  if (!isTrustedHost) {
    throw new Error("Report download URL must point to a trusted Google download host.");
  }
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
