import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { HttpMethod, QueryParams } from "./cm360Client.js";
import type { GmpProduct, ServerConfig } from "./config.js";

export interface MutationRequestPreview {
  method: HttpMethod;
  path: string;
  query?: QueryParams;
  body?: unknown;
}

export interface MutationGuardInput {
  product?: GmpProduct;
  toolName: string;
  profileId?: string;
  advertiserId?: string;
  campaignId?: string;
  partnerId?: string;
  insertionOrderId?: string;
  lineItemId?: string;
  bidManagerQueryId?: string;
  ga4AccountId?: string;
  ga4PropertyId?: string;
  gtmAccountId?: string;
  gtmContainerId?: string;
  sa360CustomerId?: string;
  dryRun?: boolean;
  confirm?: boolean;
  request: MutationRequestPreview;
}

export interface MutationGuardResult {
  dryRun: boolean;
  preview?: {
    status: "dry_run";
    message: string;
    request: MutationRequestPreview;
  };
}

export class SafetyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SafetyError";
  }
}

const redacted = "[redacted]";
const circularReference = "[circular]";
const maxAuditStringLength = 2048;
const maxAuditDepth = 8;
const sensitiveAuditKeyPattern =
  /(authori[sz]ation|cookie|token|secret|password|private.?key|client.?secret|refresh|email|phone|user.?id|user.?identifier|mobile.?device|gclid|dclid|gbraid|wbraid|match.?id|ip.?address)/i;

export async function guardMutation(
  config: ServerConfig,
  input: MutationGuardInput
): Promise<MutationGuardResult> {
  const product = input.product ?? "cm360";
  assertAllowedEntities(config, input);

  const dryRun = input.dryRun ?? true;

  if (dryRun) {
    await auditMutation(config, input, "dry_run");
    return {
      dryRun: true,
      preview: {
        status: "dry_run",
        message: `No ${product.toUpperCase()} change was made. Re-run with dryRun=false and confirm=true to execute.`,
        request: input.request
      }
    };
  }

  if (!writesEnabled(config, product)) {
    throw new SafetyError(
      `Live ${product.toUpperCase()} writes are disabled. Set GMP_ENABLE_WRITES=true or the product-specific write flag to allow write tools.`
    );
  }

  if (!input.confirm) {
    throw new SafetyError("Live write blocked. Re-run with confirm=true after reviewing the payload.");
  }

  await auditMutation(config, input, "live_requested");
  return { dryRun: false };
}

export function assertEntityAllowed(
  entityName: string,
  id: string | undefined,
  allowlist: Set<string>
): void {
  if (!id || allowlist.size === 0) {
    return;
  }

  if (!allowlist.has(id)) {
    throw new SafetyError(
      `${entityName} ${id} is not in the configured allowlist for this MCP server.`
    );
  }
}

export function assertEntityIdsAllowed(
  entityName: string,
  ids: readonly string[] | undefined,
  allowlist: Set<string>,
  options: { requireWhenAllowlisted?: boolean } = {}
): void {
  if (allowlist.size === 0) {
    return;
  }

  if (!ids?.length) {
    if (options.requireWhenAllowlisted) {
      throw new SafetyError(
        `${entityName} IDs are required when an allowlist is configured for this MCP server.`
      );
    }

    return;
  }

  for (const id of ids) {
    assertEntityAllowed(entityName, id, allowlist);
  }
}

export function assertBroadListAllowed(entityName: string, allowlist: Set<string>): void {
  if (allowlist.size === 0) {
    return;
  }

  throw new SafetyError(
    `Broad ${entityName} listing is blocked because an allowlist is configured. Use a get tool for a known allowed ID, or temporarily remove the allowlist for discovery.`
  );
}

export function assertAllowedEntities(config: ServerConfig, input: MutationGuardInput): void {
  const product = input.product ?? "cm360";

  if (product === "cm360") {
    assertEntityAllowed("profile", input.profileId, config.allowedProfileIds);
    assertEntityAllowed("advertiser", input.advertiserId, config.allowedAdvertiserIds);
    assertEntityAllowed("campaign", input.campaignId, config.allowedCampaignIds);
    return;
  }

  if (product === "dv360" || product === "bidManager") {
    assertEntityAllowed("DV360 partner", input.partnerId, config.allowedDv360PartnerIds);
    assertEntityAllowed("DV360 advertiser", input.advertiserId, config.allowedDv360AdvertiserIds);
    assertEntityAllowed("DV360 campaign", input.campaignId, config.allowedDv360CampaignIds);
    assertEntityAllowed(
      "DV360 insertion order",
      input.insertionOrderId,
      config.allowedDv360InsertionOrderIds
    );
    assertEntityAllowed("DV360 line item", input.lineItemId, config.allowedDv360LineItemIds);
    if (product === "bidManager") {
      assertEntityAllowed("Bid Manager query", input.bidManagerQueryId, config.allowedBidManagerQueryIds);
    }
    return;
  }

  if (product === "ga4") {
    assertEntityAllowed("GA4 account", input.ga4AccountId, config.allowedGa4AccountIds);
    assertEntityAllowed("GA4 property", input.ga4PropertyId, config.allowedGa4PropertyIds);
    return;
  }

  if (product === "gtm") {
    assertEntityAllowed("GTM account", input.gtmAccountId, config.allowedGtmAccountIds);
    assertEntityAllowed("GTM container", input.gtmContainerId, config.allowedGtmContainerIds);
    return;
  }

  if (product === "sa360") {
    assertEntityAllowed("SA360 customer", input.sa360CustomerId, config.allowedSa360CustomerIds);
  }
}

export function assertRawRequestAllowedEntities(config: ServerConfig, input: MutationGuardInput): void {
  const product = input.product ?? "cm360";

  if (product === "cm360") {
    assertRawEntityAllowed("profile", input.profileId, config.allowedProfileIds);
    assertRawEntityAllowed("advertiser", input.advertiserId, config.allowedAdvertiserIds);
    assertRawEntityAllowed("campaign", input.campaignId, config.allowedCampaignIds);
    return;
  }

  if (product === "dv360" || product === "bidManager") {
    assertRawEntityAllowed("DV360 partner", input.partnerId, config.allowedDv360PartnerIds);
    assertRawEntityAllowed("DV360 advertiser", input.advertiserId, config.allowedDv360AdvertiserIds);
    assertRawEntityAllowed("DV360 campaign", input.campaignId, config.allowedDv360CampaignIds);
    assertRawEntityAllowed(
      "DV360 insertion order",
      input.insertionOrderId,
      config.allowedDv360InsertionOrderIds
    );
    assertRawEntityAllowed("DV360 line item", input.lineItemId, config.allowedDv360LineItemIds);
    if (product === "bidManager") {
      assertRawEntityAllowed("Bid Manager query", input.bidManagerQueryId, config.allowedBidManagerQueryIds);
    }
    return;
  }

  if (product === "ga4") {
    assertRawEntityAllowed("GA4 account", input.ga4AccountId, config.allowedGa4AccountIds);
    assertRawEntityAllowed("GA4 property", input.ga4PropertyId, config.allowedGa4PropertyIds);
    return;
  }

  if (product === "gtm") {
    assertRawEntityAllowed("GTM account", input.gtmAccountId, config.allowedGtmAccountIds);
    assertRawEntityAllowed("GTM container", input.gtmContainerId, config.allowedGtmContainerIds);
    return;
  }

  if (product === "sa360") {
    assertRawEntityAllowed("SA360 customer", input.sa360CustomerId, config.allowedSa360CustomerIds);
  }
}

function assertRawEntityAllowed(
  entityName: string,
  id: string | undefined,
  allowlist: Set<string>
): void {
  if (allowlist.size === 0) {
    return;
  }

  if (!id) {
    throw new SafetyError(
      `${entityName} ID must be supplied to use a raw request tool when that allowlist is configured.`
    );
  }

  assertEntityAllowed(entityName, id, allowlist);
}

export function writesEnabled(config: ServerConfig, product: GmpProduct): boolean {
  return config.productWritesEnabled[product] ?? config.writesEnabled;
}

export function rawRequestEnabled(config: ServerConfig, product: GmpProduct): boolean {
  return config.productRawRequestEnabled[product] ?? config.rawRequestEnabled;
}

export async function auditMutation(
  config: ServerConfig,
  input: MutationGuardInput,
  event: "dry_run" | "live_requested" | "live_completed"
): Promise<void> {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    product: input.product ?? "cm360",
    toolName: input.toolName,
    profileId: input.profileId,
    advertiserId: input.advertiserId,
    campaignId: input.campaignId,
    partnerId: input.partnerId,
    insertionOrderId: input.insertionOrderId,
    lineItemId: input.lineItemId,
    bidManagerQueryId: input.bidManagerQueryId,
    ga4AccountId: input.ga4AccountId,
    ga4PropertyId: input.ga4PropertyId,
    gtmAccountId: input.gtmAccountId,
    gtmContainerId: input.gtmContainerId,
    sa360CustomerId: input.sa360CustomerId,
    request: redactForAudit(input.request)
  });

  await mkdir(path.dirname(config.auditLogPath), { recursive: true });
  await appendFile(config.auditLogPath, `${line}\n`, "utf8");
}

export function redactForAudit(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet<object>());
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return truncateAuditString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return circularReference;
  }

  if (depth >= maxAuditDepth) {
    return "[max-depth]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    output[key] = sensitiveAuditKeyPattern.test(key)
      ? redacted
      : redactValue(nestedValue, depth + 1, seen);
  }

  return output;
}

function truncateAuditString(value: string): string {
  if (value.length <= maxAuditStringLength) {
    return value;
  }

  return `${value.slice(0, maxAuditStringLength)}...`;
}
