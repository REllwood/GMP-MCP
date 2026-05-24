import { describe, expect, it } from "vitest";

import { normaliseApiPath } from "./cm360Client.js";
import { validateApiBaseUrl } from "./config.js";
import {
  assertTrustedDownloadUrl,
  normaliseApiPath as normaliseGoogleApiPath
} from "./googleApiClient.js";

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
});
