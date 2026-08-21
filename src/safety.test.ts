import { describe, expect, it } from "vitest";

import type { ServerConfig } from "./config.js";
import {
  assertAllowedEntities,
  assertEntityAllowed,
  assertEntityIdsAllowed,
  assertRawRequestAllowedEntities,
  guardMutation,
  rawRequestEnabled,
  redactForAudit,
  SafetyError,
  writesEnabled
} from "./safety.js";

describe("assertEntityAllowed", () => {
  it("allows any ID when allowlist is empty", () => {
    expect(() => assertEntityAllowed("campaign", "123", new Set())).not.toThrow();
  });

  it("allows IDs present in the allowlist", () => {
    expect(() => assertEntityAllowed("campaign", "123", new Set(["123"]))).not.toThrow();
  });

  it("blocks IDs missing from the allowlist", () => {
    expect(() => assertEntityAllowed("campaign", "456", new Set(["123"]))).toThrow(SafetyError);
  });
});

describe("product safety", () => {
  it("checks product-specific DV360 allowlists", () => {
    const config = testConfig({
      allowedDv360AdvertiserIds: new Set(["111"])
    });

    expect(() =>
      assertAllowedEntities(config, {
        product: "dv360",
        toolName: "dv360_get_advertiser",
        advertiserId: "111",
        request: { method: "GET", path: "/advertisers/111" }
      })
    ).not.toThrow();

    expect(() =>
      assertAllowedEntities(config, {
        product: "dv360",
        toolName: "dv360_get_advertiser",
        advertiserId: "222",
        request: { method: "GET", path: "/advertisers/222" }
      })
    ).toThrow(SafetyError);
  });

  it("derives raw request targets from the path and rejects false metadata", () => {
    const config = testConfig({
      allowedGa4PropertyIds: new Set(["123"])
    });

    expect(() =>
      assertRawRequestAllowedEntities(config, {
        product: "ga4",
        toolName: "ga4_api_request",
        request: { method: "GET", path: "/properties/123/dataStreams" }
      })
    ).not.toThrow();

    expect(() =>
      assertRawRequestAllowedEntities(config, {
        product: "ga4",
        toolName: "ga4_api_request",
        ga4PropertyId: "123",
        request: { method: "GET", path: "/properties/123/dataStreams" }
      })
    ).not.toThrow();

    expect(() =>
      assertRawRequestAllowedEntities(config, {
        product: "ga4",
        toolName: "ga4_api_request",
        ga4PropertyId: "123",
        request: { method: "GET", path: "/properties/456/dataStreams" }
      })
    ).toThrow(/does not match/);

    expect(() =>
      assertRawRequestAllowedEntities(config, {
        product: "ga4",
        toolName: "ga4_api_request",
        ga4PropertyId: "123",
        request: { method: "GET", path: "/accountSummaries" }
      })
    ).toThrow(/cannot be verified/);
  });

  it("requires bulk IDs when a bulk allowlist is configured", () => {
    expect(() =>
      assertEntityIdsAllowed("DV360 line item", undefined, new Set(["111"]), {
        requireWhenAllowlisted: true
      })
    ).toThrow(SafetyError);

    expect(() =>
      assertEntityIdsAllowed("DV360 line item", ["111"], new Set(["111"]), {
        requireWhenAllowlisted: true
      })
    ).not.toThrow();
  });

  it("uses product-specific write and raw-request flags", () => {
    const config = testConfig({
      productWritesEnabled: {
        cm360: false,
        dv360: true,
        bidManager: false,
        ga4: false,
        gtm: false,
        sa360: false
      },
      productRawRequestEnabled: {
        cm360: false,
        dv360: false,
        bidManager: false,
        ga4: true,
        gtm: false,
        sa360: false
      }
    });

    expect(writesEnabled(config, "dv360")).toBe(true);
    expect(writesEnabled(config, "ga4")).toBe(false);
    expect(rawRequestEnabled(config, "ga4")).toBe(true);
    expect(rawRequestEnabled(config, "gtm")).toBe(false);
  });
});

describe("mutation previews", () => {
  it("requires an exact prior preview and consumes it after one live request", async () => {
    const config = testConfig({
      productWritesEnabled: {
        cm360: true,
        dv360: false,
        bidManager: false,
        ga4: false,
        gtm: false,
        sa360: false
      }
    });
    const input = {
      toolName: "test_exact_preview",
      profileId: "1",
      request: {
        method: "POST" as const,
        path: "/userprofiles/1/campaigns",
        body: { name: "Reviewed campaign", advertiserId: "2" }
      }
    };

    await expect(
      guardMutation(config, { ...input, dryRun: false, confirm: true })
    ).rejects.toThrow(/Preview this exact request/);

    const preview = await guardMutation(config, { ...input, dryRun: true });
    expect(preview.preview?.expiresAt).toBeTruthy();

    await expect(
      guardMutation(config, { ...input, dryRun: false, confirm: true })
    ).resolves.toEqual({ dryRun: false });

    await expect(
      guardMutation(config, { ...input, dryRun: false, confirm: true })
    ).rejects.toThrow(/Preview this exact request/);
  });

  it("rejects a live payload that differs from the reviewed preview", async () => {
    const config = testConfig({
      productWritesEnabled: {
        cm360: true,
        dv360: false,
        bidManager: false,
        ga4: false,
        gtm: false,
        sa360: false
      }
    });
    const baseInput = {
      toolName: "test_changed_preview",
      profileId: "1",
      request: {
        method: "PATCH" as const,
        path: "/userprofiles/1/campaigns",
        query: { id: "2" },
        body: { name: "Reviewed name" }
      }
    };

    await guardMutation(config, { ...baseInput, dryRun: true });
    await expect(
      guardMutation(config, {
        ...baseInput,
        dryRun: false,
        confirm: true,
        request: { ...baseInput.request, body: { name: "Different name" } }
      })
    ).rejects.toThrow(/Preview this exact request/);
  });
});

describe("audit redaction", () => {
  it("redacts sensitive fields before audit logging", () => {
    const redacted = redactForAudit({
      method: "POST",
      body: {
        email: "person@example.com",
        token: "secret-token",
        advertiserId: "123",
        nested: {
          gclid: "click-id",
          safeName: "Campaign"
        }
      }
    });

    expect(redacted).toMatchObject({
      method: "POST",
      body: {
        email: "[redacted]",
        token: "[redacted]",
        advertiserId: "123",
        nested: {
          gclid: "[redacted]",
          safeName: "Campaign"
        }
      }
    });
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
    auditLogPath: "/tmp/gmp-audit.log",
    downloadDir: "/tmp/gmp-downloads",
    requestsPerSecond: 1,
    maxRetries: 3,
    requestTimeoutMs: 60_000,
    maxDownloadBytes: 100_000_000,
    allowUnsafeBaseUrls: false,
    ...overrides
  };
}
