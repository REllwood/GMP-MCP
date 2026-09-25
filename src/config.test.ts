import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Cm360Client, normaliseApiPath } from "./cm360Client.js";
import { ALL_GMP_PRODUCTS, loadConfig, parseEnabledProducts, validateApiBaseUrl, type ServerConfig } from "./config.js";
import {
  assertTrustedDownloadUrl,
  GoogleApiClient,
  normaliseApiPath as normaliseGoogleApiPath
} from "./googleApiClient.js";
import { idString } from "./schemas.js";

describe("normaliseApiPath", () => {
  it("accepts paths with or without a leading slash", () => {
    expect(normaliseApiPath("userprofiles")).toBe("/userprofiles");
    expect(normaliseApiPath("/userprofiles")).toBe("/userprofiles");
  });

  it("strips the dfareporting v5 prefix when users provide a full API path", () => {
    expect(normaliseApiPath("/dfareporting/v5/userprofiles/123/campaigns")).toBe(
      "/userprofiles/123/campaigns"
    );
  });
});

describe("googleApiClient normaliseApiPath", () => {
  it("accepts service-relative paths", () => {
    expect(normaliseGoogleApiPath("advertisers")).toBe("/advertisers");
    expect(normaliseGoogleApiPath("/advertisers")).toBe("/advertisers");
  });

  it("extracts the pathname from absolute URLs", () => {
    expect(normaliseGoogleApiPath("https://analyticsdata.googleapis.com/v1beta/properties/123:runReport")).toBe(
      "/v1beta/properties/123:runReport"
    );
  });
});

describe("API base URL validation", () => {
  it("allows expected Google API hosts", () => {
    expect(
      validateApiBaseUrl("DV360_API_BASE_URL", "https://displayvideo.googleapis.com/v4/", false)
    ).toBe("https://displayvideo.googleapis.com/v4");
  });

  it("blocks non-Google API hosts unless explicitly unsafe", () => {
    expect(() =>
      validateApiBaseUrl("DV360_API_BASE_URL", "https://example.com/v4", false)
    ).toThrow(/trusted Google API host/);

    expect(
      validateApiBaseUrl("DV360_API_BASE_URL", "http://localhost:8080/v4", true)
    ).toBe("http://localhost:8080/v4");
  });
});

describe("report download URL validation", () => {
  it("allows trusted Google download hosts", () => {
    expect(() =>
      assertTrustedDownloadUrl(new URL("https://storage.googleapis.com/example/report.csv"))
    ).not.toThrow();
  });

  it("blocks non-Google and non-HTTPS download URLs", () => {
    expect(() => assertTrustedDownloadUrl(new URL("https://example.com/report.csv"))).toThrow(
      /trusted Google download host/
    );
    expect(() => assertTrustedDownloadUrl(new URL("http://storage.googleapis.com/report.csv"))).toThrow(
      /HTTPS/
    );
  });

  it("blocks other Google API hosts that would accept the OAuth token", () => {
    for (const url of [
      "https://displayvideo.googleapis.com/v4/advertisers/1/lineItems",
      "https://www.googleapis.com/doubleclicksearch/v2/conversion"
    ]) {
      expect(() => assertTrustedDownloadUrl(new URL(url)), url).toThrow(/trusted Google download host/);
    }
  });
});

describe("Google API identifiers", () => {
  it("accepts normal IDs and rejects path-changing values", () => {
    expect(idString.safeParse("GTM-ABC_123").success).toBe(true);
    expect(idString.safeParse("../advertisers/2").success).toBe(false);
    expect(idString.safeParse("1%2Fcampaigns%2F2").success).toBe(false);
    expect(idString.safeParse("1?alt=media").success).toBe(false);
  });
});

describe("API client paths", () => {
  it("rejects a query string or fragment embedded in a path", () => {
    const token = { getAccessToken: async () => "token" };
    const google = new GoogleApiClient("Test", "https://displayvideo.googleapis.com/v4", {} as ServerConfig, token);
    const cm360 = new Cm360Client(
      { apiBaseUrl: "https://dfareporting.googleapis.com/dfareporting/v5" } as ServerConfig,
      token
    );

    expect(() => google.buildUrl("/advertisers/1?filter=x")).toThrow(/query string/);
    expect(() => google.buildUrl("https://displayvideo.googleapis.com/v4/advertisers/1#x")).toThrow(/query string/);
    expect(() => cm360.buildUrl("/userprofiles/1/campaigns?id=2", { id: "3" })).toThrow(/query string/);
    expect(cm360.buildUrl("/userprofiles/1/campaigns", { id: "3" }).search).toBe("?id=3");
  });
});

describe("GMP_PRODUCTS", () => {
  it("registers every product when unset", () => {
    expect(parseEnabledProducts(undefined)).toEqual(new Set(ALL_GMP_PRODUCTS));
  });

  it("accepts a subset, mixed separators and the Bid Manager alias", () => {
    expect(parseEnabledProducts("ga4, BidManager gtm")).toEqual(new Set(["ga4", "bidManager", "gtm"]));
  });

  it("rejects unknown product names instead of silently dropping them", () => {
    expect(() => parseEnabledProducts("ga4,dv3600")).toThrow(/unknown product "dv3600"/);
  });
});

describe("local data paths", () => {
  it("default under the home directory so a client's working directory does not matter", () => {
    const names = ["GMP_AUDIT_LOG_PATH", "CM360_AUDIT_LOG_PATH", "GMP_DOWNLOAD_DIR", "CM360_DOWNLOAD_DIR"];
    const saved = names.map((name) => [name, process.env[name]] as const);
    for (const name of names) {
      delete process.env[name];
    }

    try {
      const config = loadConfig();
      expect(config.auditLogPath).toBe(path.join(os.homedir(), ".gmp-mcp", "audit.log"));
      expect(config.downloadDir).toBe(path.join(os.homedir(), ".gmp-mcp", "downloads"));
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});
