import { afterEach, describe, expect, it, vi } from "vitest";

import { Cm360Client } from "./cm360Client.js";
import type { ServerConfig } from "./config.js";
import { GoogleApiClient } from "./googleApiClient.js";
import { runGuardedGoogleRequest } from "./toolHelpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API retry safety", () => {
  it("does not retry a non-idempotent Google API POST", async () => {
    const fetchMock = vi.fn(async () => new Response("failed", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GoogleApiClient(
      "Test API",
      "https://displayvideo.googleapis.com/v4",
      testConfig({ maxRetries: 3 }),
      { getAccessToken: async () => "token" }
    );

    await expect(
      client.request({ method: "POST", path: "/advertisers/1/campaigns", body: {} })
    ).rejects.toThrow(/HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-idempotent CM360 POST", async () => {
    const fetchMock = vi.fn(async () => new Response("failed", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new Cm360Client(testConfig({ maxRetries: 3 }), {
      getAccessToken: async () => "token"
    });

    await expect(
      client.request({ method: "POST", path: "/userprofiles/1/campaigns", body: {} })
    ).rejects.toThrow(/HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries an idempotent GET", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("busy", { status: 503, headers: { "retry-after": "0.001" } })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GoogleApiClient(
      "Test API",
      "https://displayvideo.googleapis.com/v4",
      testConfig({ maxRetries: 1 }),
      { getAccessToken: async () => "token" }
    );

    await expect(client.request({ method: "GET", path: "/advertisers/1" })).resolves.toEqual({
      ok: true
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("post-success audit handling", () => {
  it("returns the remote result with a warning when completion auditing fails", async () => {
    const config = testConfig({
      auditLogPath: `/tmp/gmp-mcp-audit-warning-${process.pid}.log`,
      productWritesEnabled: {
        cm360: true,
        dv360: false,
        bidManager: false,
        ga4: false,
        gtm: false,
        sa360: false
      }
    });
    const request = {
      method: "POST" as const,
      path: "/things",
      body: { name: "Reviewed" }
    };
    const client = {
      request: async () => {
        config.auditLogPath = "/dev/null/audit.log";
        return { id: "created" };
      }
    } as unknown as GoogleApiClient;

    await runGuardedGoogleRequest({
      client,
      config,
      product: "cm360",
      toolName: "test_audit_warning",
      dryRun: true,
      request
    });

    const result = await runGuardedGoogleRequest({
      client,
      config,
      product: "cm360",
      toolName: "test_audit_warning",
      dryRun: false,
      confirm: true,
      request
    });
    const payload = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}");

    expect(result.isError).not.toBe(true);
    expect(payload.result).toEqual({ id: "created" });
    expect(payload.warning.code).toBe("audit_log_failed");
  });
});

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const productFlags = {
    cm360: false,
    dv360: false,
    bidManager: false,
    ga4: false,
    gtm: false,
    sa360: false
  };

  return {
    apiBaseUrl: "https://dfareporting.googleapis.com/dfareporting/v5",
    dv360ApiBaseUrl: "https://displayvideo.googleapis.com/v4",
    bidManagerApiBaseUrl: "https://doubleclickbidmanager.googleapis.com/v2",
    ga4AdminApiBaseUrl: "https://analyticsadmin.googleapis.com/v1beta",
    ga4AdminAlphaApiBaseUrl: "https://analyticsadmin.googleapis.com/v1alpha",
    ga4DataApiBaseUrl: "https://analyticsdata.googleapis.com/v1beta",
    gtmApiBaseUrl: "https://tagmanager.googleapis.com/tagmanager/v2",
    sa360ApiBaseUrl: "https://searchads360.googleapis.com/v0",
    sa360LegacyApiBaseUrl: "https://www.googleapis.com/doubleclicksearch/v2",
    scopes: [],
    authMode: "auto",
    writesEnabled: false,
    rawRequestEnabled: false,
    productWritesEnabled: productFlags,
    productRawRequestEnabled: productFlags,
    allowedProfileIds: new Set(),
    allowedAdvertiserIds: new Set(),
    allowedCampaignIds: new Set(),
    allowedDv360PartnerIds: new Set(),
    allowedDv360AdvertiserIds: new Set(),
    allowedDv360CampaignIds: new Set(),
    allowedDv360InsertionOrderIds: new Set(),
    allowedDv360LineItemIds: new Set(),
    allowedBidManagerQueryIds: new Set(),
    allowedGa4AccountIds: new Set(),
    allowedGa4PropertyIds: new Set(),
    allowedGtmAccountIds: new Set(),
    allowedGtmContainerIds: new Set(),
    allowedSa360CustomerIds: new Set(),
    auditLogPath: "/tmp/gmp-mcp-client-test-audit.log",
    downloadDir: "/tmp/gmp-mcp-client-test-downloads",
    requestsPerSecond: 100_000,
    maxRetries: 0,
    requestTimeoutMs: 5_000,
    maxDownloadBytes: 1_024,
    allowUnsafeBaseUrls: false,
    ...overrides
  };
}
