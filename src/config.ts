import "dotenv/config";
import path from "node:path";

export const GMP_SCOPES = [
  "https://www.googleapis.com/auth/dfareporting",
  "https://www.googleapis.com/auth/dfatrafficking",
  "https://www.googleapis.com/auth/ddmconversions",
  "https://www.googleapis.com/auth/display-video",
  "https://www.googleapis.com/auth/doubleclickbidmanager",
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/analytics.edit",
  "https://www.googleapis.com/auth/tagmanager.readonly",
  "https://www.googleapis.com/auth/tagmanager.edit.containers",
  "https://www.googleapis.com/auth/tagmanager.edit.containerversions",
  "https://www.googleapis.com/auth/tagmanager.manage.accounts",
  "https://www.googleapis.com/auth/tagmanager.manage.users",
  "https://www.googleapis.com/auth/tagmanager.publish",
  "https://www.googleapis.com/auth/doubleclicksearch"
] as const;

export const CM360_SCOPES = GMP_SCOPES;

export type AuthMode = "auto" | "oauth" | "service_account" | "application_default";

export type GmpProduct =
  | "cm360"
  | "dv360"
  | "bidManager"
  | "ga4"
  | "gtm"
  | "sa360";

export interface ServerConfig {
  apiBaseUrl: string;
  dv360ApiBaseUrl: string;
  bidManagerApiBaseUrl: string;
  ga4AdminApiBaseUrl: string;
  ga4AdminAlphaApiBaseUrl: string;
  ga4DataApiBaseUrl: string;
  gtmApiBaseUrl: string;
  sa360ApiBaseUrl: string;
  sa360LegacyApiBaseUrl: string;
  scopes: string[];
  authMode: AuthMode;
  serviceAccountKeyFile?: string;
  delegatedSubject?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthRefreshToken?: string;
  writesEnabled: boolean;
  rawRequestEnabled: boolean;
  productWritesEnabled: Record<GmpProduct, boolean>;
  productRawRequestEnabled: Record<GmpProduct, boolean>;
  allowedProfileIds: Set<string>;
  allowedAdvertiserIds: Set<string>;
  allowedCampaignIds: Set<string>;
  allowedDv360PartnerIds: Set<string>;
  allowedDv360AdvertiserIds: Set<string>;
  allowedDv360CampaignIds: Set<string>;
  allowedDv360InsertionOrderIds: Set<string>;
  allowedDv360LineItemIds: Set<string>;
  allowedBidManagerQueryIds: Set<string>;
  allowedGa4AccountIds: Set<string>;
  allowedGa4PropertyIds: Set<string>;
  allowedGtmAccountIds: Set<string>;
  allowedGtmContainerIds: Set<string>;
  allowedSa360CustomerIds: Set<string>;
  auditLogPath: string;
  downloadDir: string;
  requestsPerSecond: number;
  maxRetries: number;
  requestTimeoutMs: number;
  maxDownloadBytes: number;
  allowUnsafeBaseUrls: boolean;
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number,
  maximum: number
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    return fallback;
  }
  return parsed;
}

function parseCsvSet(value: string | undefined): Set<string> {
  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function parseScopes(value: string | undefined, fallback: readonly string[]): string[] {
  if (!value) {
    return [...fallback];
  }

  const scopes = value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  return scopes.length > 0 ? scopes : [...fallback];
}

function parseAuthMode(value: string | undefined): AuthMode {
  if (
    value === "auto" ||
    value === "oauth" ||
    value === "service_account" ||
    value === "application_default"
  ) {
    return value;
  }

  return "auto";
}

function resolveWorkspacePath(value: string | undefined, fallback: string): string {
  const target = value ?? fallback;
  return path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
}

function productFlag(productName: string, suffix: "ENABLE_WRITES" | "ENABLE_RAW_REQUEST", fallback: boolean): boolean {
  return parseBoolean(envValue(`${productName}_${suffix}`), fallback);
}

const trustedApiHosts = new Set([
  "analyticsadmin.googleapis.com",
  "analyticsdata.googleapis.com",
  "dfareporting.googleapis.com",
  "displayvideo.googleapis.com",
  "doubleclickbidmanager.googleapis.com",
  "searchads360.googleapis.com",
  "tagmanager.googleapis.com",
  "www.googleapis.com"
]);

export function validateApiBaseUrl(
  envName: string,
  value: string,
  allowUnsafeBaseUrls: boolean
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${envName} must be a valid absolute URL.`);
  }

  if (!allowUnsafeBaseUrls) {
    if (url.protocol !== "https:") {
      throw new Error(`${envName} must use HTTPS.`);
    }

    if (!trustedApiHosts.has(url.hostname)) {
      throw new Error(
        `${envName} must point to a trusted Google API host. Set GMP_ALLOW_UNSAFE_BASE_URLS=true only for local mocks or controlled test infrastructure.`
      );
    }
  }

  return value.replace(/\/+$/, "");
}

function apiBaseUrl(
  envName: string,
  fallback: string,
  allowUnsafeBaseUrls: boolean
): string {
  return validateApiBaseUrl(envName, envValue(envName) ?? fallback, allowUnsafeBaseUrls);
}

export function loadConfig(): ServerConfig {
  const globalWritesEnabled = parseBoolean(envValue("GMP_ENABLE_WRITES"), false);
  const cm360WritesEnabled = parseBoolean(envValue("CM360_ENABLE_WRITES"), globalWritesEnabled);
  const globalRawRequestEnabled = parseBoolean(envValue("GMP_ENABLE_RAW_REQUEST"), false);
  const cm360RawRequestEnabled = parseBoolean(envValue("CM360_ENABLE_RAW_REQUEST"), globalRawRequestEnabled);
  const allowUnsafeBaseUrls = parseBoolean(envValue("GMP_ALLOW_UNSAFE_BASE_URLS"), false);

  return {
    apiBaseUrl: apiBaseUrl(
      "CM360_API_BASE_URL",
      "https://dfareporting.googleapis.com/dfareporting/v5",
      allowUnsafeBaseUrls
    ),
    dv360ApiBaseUrl: apiBaseUrl(
      "DV360_API_BASE_URL",
      "https://displayvideo.googleapis.com/v4",
      allowUnsafeBaseUrls
    ),
    bidManagerApiBaseUrl: apiBaseUrl(
      "BID_MANAGER_API_BASE_URL",
      "https://doubleclickbidmanager.googleapis.com/v2",
      allowUnsafeBaseUrls
    ),
    ga4AdminApiBaseUrl: apiBaseUrl(
      "GA4_ADMIN_API_BASE_URL",
      "https://analyticsadmin.googleapis.com/v1beta",
      allowUnsafeBaseUrls
    ),
    ga4AdminAlphaApiBaseUrl: apiBaseUrl(
      "GA4_ADMIN_ALPHA_API_BASE_URL",
      "https://analyticsadmin.googleapis.com/v1alpha",
      allowUnsafeBaseUrls
    ),
    ga4DataApiBaseUrl: apiBaseUrl(
      "GA4_DATA_API_BASE_URL",
      "https://analyticsdata.googleapis.com/v1beta",
      allowUnsafeBaseUrls
    ),
    gtmApiBaseUrl: apiBaseUrl(
      "GTM_API_BASE_URL",
      "https://tagmanager.googleapis.com/tagmanager/v2",
      allowUnsafeBaseUrls
    ),
    sa360ApiBaseUrl: apiBaseUrl(
      "SA360_API_BASE_URL",
      "https://searchads360.googleapis.com/v0",
      allowUnsafeBaseUrls
    ),
    sa360LegacyApiBaseUrl: apiBaseUrl(
      "SA360_LEGACY_API_BASE_URL",
      "https://www.googleapis.com/doubleclicksearch/v2",
      allowUnsafeBaseUrls
    ),
    scopes: parseScopes(envValue("GMP_SCOPES"), GMP_SCOPES),
    authMode: parseAuthMode(envValue("GMP_AUTH_MODE") ?? envValue("CM360_AUTH_MODE")),
    serviceAccountKeyFile:
      envValue("GMP_SERVICE_ACCOUNT_KEY_FILE") ??
      envValue("CM360_SERVICE_ACCOUNT_KEY_FILE") ??
      envValue("GOOGLE_APPLICATION_CREDENTIALS"),
    delegatedSubject: envValue("GMP_DELEGATED_SUBJECT") ?? envValue("CM360_DELEGATED_SUBJECT"),
    oauthClientId: envValue("GMP_OAUTH_CLIENT_ID") ?? envValue("CM360_OAUTH_CLIENT_ID"),
    oauthClientSecret: envValue("GMP_OAUTH_CLIENT_SECRET") ?? envValue("CM360_OAUTH_CLIENT_SECRET"),
    oauthRefreshToken: envValue("GMP_OAUTH_REFRESH_TOKEN") ?? envValue("CM360_OAUTH_REFRESH_TOKEN"),
    writesEnabled: cm360WritesEnabled,
    rawRequestEnabled: cm360RawRequestEnabled,
    productWritesEnabled: {
      cm360: cm360WritesEnabled,
      dv360: productFlag("DV360", "ENABLE_WRITES", globalWritesEnabled),
      bidManager: productFlag("BID_MANAGER", "ENABLE_WRITES", globalWritesEnabled),
      ga4: productFlag("GA4", "ENABLE_WRITES", globalWritesEnabled),
      gtm: productFlag("GTM", "ENABLE_WRITES", globalWritesEnabled),
      sa360: productFlag("SA360", "ENABLE_WRITES", globalWritesEnabled)
    },
    productRawRequestEnabled: {
      cm360: cm360RawRequestEnabled,
      dv360: productFlag("DV360", "ENABLE_RAW_REQUEST", globalRawRequestEnabled),
      bidManager: productFlag("BID_MANAGER", "ENABLE_RAW_REQUEST", globalRawRequestEnabled),
      ga4: productFlag("GA4", "ENABLE_RAW_REQUEST", globalRawRequestEnabled),
      gtm: productFlag("GTM", "ENABLE_RAW_REQUEST", globalRawRequestEnabled),
      sa360: productFlag("SA360", "ENABLE_RAW_REQUEST", globalRawRequestEnabled)
    },
    allowedProfileIds: parseCsvSet(envValue("CM360_ALLOWED_PROFILE_IDS")),
    allowedAdvertiserIds: parseCsvSet(envValue("CM360_ALLOWED_ADVERTISER_IDS")),
    allowedCampaignIds: parseCsvSet(envValue("CM360_ALLOWED_CAMPAIGN_IDS")),
    allowedDv360PartnerIds: parseCsvSet(envValue("DV360_ALLOWED_PARTNER_IDS")),
    allowedDv360AdvertiserIds: parseCsvSet(envValue("DV360_ALLOWED_ADVERTISER_IDS")),
    allowedDv360CampaignIds: parseCsvSet(envValue("DV360_ALLOWED_CAMPAIGN_IDS")),
    allowedDv360InsertionOrderIds: parseCsvSet(envValue("DV360_ALLOWED_INSERTION_ORDER_IDS")),
    allowedDv360LineItemIds: parseCsvSet(envValue("DV360_ALLOWED_LINE_ITEM_IDS")),
    allowedBidManagerQueryIds: parseCsvSet(envValue("BID_MANAGER_ALLOWED_QUERY_IDS")),
    allowedGa4AccountIds: parseCsvSet(envValue("GA4_ALLOWED_ACCOUNT_IDS")),
    allowedGa4PropertyIds: parseCsvSet(envValue("GA4_ALLOWED_PROPERTY_IDS")),
    allowedGtmAccountIds: parseCsvSet(envValue("GTM_ALLOWED_ACCOUNT_IDS")),
    allowedGtmContainerIds: parseCsvSet(envValue("GTM_ALLOWED_CONTAINER_IDS")),
    allowedSa360CustomerIds: parseCsvSet(envValue("SA360_ALLOWED_CUSTOMER_IDS")),
    auditLogPath: resolveWorkspacePath(
      envValue("GMP_AUDIT_LOG_PATH") ?? envValue("CM360_AUDIT_LOG_PATH"),
      ".gmp-mcp/audit.log"
    ),
    downloadDir: resolveWorkspacePath(
      envValue("GMP_DOWNLOAD_DIR") ?? envValue("CM360_DOWNLOAD_DIR"),
      ".gmp-mcp/downloads"
    ),
    requestsPerSecond: parseNumber(envValue("GMP_REQUESTS_PER_SECOND") ?? envValue("CM360_REQUESTS_PER_SECOND"), 1),
    maxRetries: parseNonNegativeInteger(
      envValue("GMP_MAX_RETRIES") ?? envValue("CM360_MAX_RETRIES"),
      3,
      10
    ),
    requestTimeoutMs: Math.floor(
      parseNumber(envValue("GMP_REQUEST_TIMEOUT_MS") ?? envValue("CM360_REQUEST_TIMEOUT_MS"), 60_000)
    ),
    maxDownloadBytes: Math.floor(
      parseNumber(envValue("GMP_MAX_DOWNLOAD_BYTES") ?? envValue("CM360_MAX_DOWNLOAD_BYTES"), 100_000_000)
    ),
    allowUnsafeBaseUrls
  };
}
