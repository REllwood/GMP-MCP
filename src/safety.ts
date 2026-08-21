import { createHash } from "node:crypto";
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
    expiresAt: string;
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
const previewTtlMs = 15 * 60 * 1000;
const maxPendingPreviews = 1_000;
const pendingPreviews = new Map<string, number>();
const sensitiveAuditKeyPattern =
  /(authori[sz]ation|cookie|token|secret|password|private.?key|client.?secret|refresh|email|phone|user.?id|user.?identifier|mobile.?device|gclid|dclid|gbraid|wbraid|match.?id|ip.?address)/i;

export async function guardMutation(
  config: ServerConfig,
  input: MutationGuardInput
): Promise<MutationGuardResult> {
  const product = input.product ?? "cm360";
  assertAllowedEntities(config, input);

  const dryRun = input.dryRun ?? true;
  const previewFingerprint = mutationFingerprint(product, input.toolName, input.request);

  if (dryRun) {
    await auditMutation(config, input, "dry_run");
    const expiresAt = Date.now() + previewTtlMs;
    rememberPreview(previewFingerprint, expiresAt);
    return {
      dryRun: true,
      preview: {
        status: "dry_run",
        message: `No ${product.toUpperCase()} change was made. Re-run this exact request with dryRun=false and confirm=true before the preview expires.`,
        expiresAt: new Date(expiresAt).toISOString(),
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

  consumePreview(previewFingerprint);
  await auditMutation(config, input, "live_requested");
  return { dryRun: false };
}

function mutationFingerprint(
  product: GmpProduct,
  toolName: string,
  request: MutationRequestPreview
): string {
  return createHash("sha256")
    .update(stableStringify({ product, toolName, request }))
    .digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForFingerprint(value));
}

function sortForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortForFingerprint(item));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, sortForFingerprint(nestedValue)])
  );
}

function rememberPreview(fingerprint: string, expiresAt: number): void {
  pruneExpiredPreviews(Date.now());
  pendingPreviews.delete(fingerprint);
  pendingPreviews.set(fingerprint, expiresAt);

  while (pendingPreviews.size > maxPendingPreviews) {
    const oldest = pendingPreviews.keys().next().value as string | undefined;
    if (!oldest) {
      break;
    }
    pendingPreviews.delete(oldest);
  }
}

function consumePreview(fingerprint: string): void {
  const now = Date.now();
  pruneExpiredPreviews(now);
  const expiresAt = pendingPreviews.get(fingerprint);

  if (!expiresAt || expiresAt <= now) {
    throw new SafetyError(
      "Live write blocked. Preview this exact request with dryRun=true before confirming it."
    );
  }

  pendingPreviews.delete(fingerprint);
}

function pruneExpiredPreviews(now: number): void {
  for (const [fingerprint, expiresAt] of pendingPreviews) {
    if (expiresAt <= now) {
      pendingPreviews.delete(fingerprint);
    }
  }
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
  const path = rawRequestPath(input.request.path);

  if (product === "cm360") {
    assertRawPathEntityAllowed("profile", input.profileId, config.allowedProfileIds, path, ["userprofiles"], input.request.query);
    assertRawPathEntityAllowed("advertiser", input.advertiserId, config.allowedAdvertiserIds, path, ["advertisers"], input.request.query);
    assertRawPathEntityAllowed("campaign", input.campaignId, config.allowedCampaignIds, path, ["campaigns"], input.request.query);
    return;
  }

  if (product === "dv360" || product === "bidManager") {
    assertRawPathEntityAllowed("DV360 partner", input.partnerId, config.allowedDv360PartnerIds, path, ["partners"], input.request.query);
    assertRawPathEntityAllowed("DV360 advertiser", input.advertiserId, config.allowedDv360AdvertiserIds, path, ["advertisers"], input.request.query);
    assertRawPathEntityAllowed("DV360 campaign", input.campaignId, config.allowedDv360CampaignIds, path, ["campaigns"], input.request.query);
    assertRawPathEntityAllowed(
      "DV360 insertion order",
      input.insertionOrderId,
      config.allowedDv360InsertionOrderIds,
      path,
      ["insertionOrders"],
      input.request.query
    );
    assertRawPathEntityAllowed("DV360 line item", input.lineItemId, config.allowedDv360LineItemIds, path, ["lineItems"], input.request.query);
    if (product === "bidManager") {
      assertRawPathEntityAllowed("Bid Manager query", input.bidManagerQueryId, config.allowedBidManagerQueryIds, path, ["queries"], input.request.query);
    }
    return;
  }

  if (product === "ga4") {
    assertRawPathEntityAllowed("GA4 account", input.ga4AccountId, config.allowedGa4AccountIds, path, ["accounts"], input.request.query);
    assertRawPathEntityAllowed("GA4 property", input.ga4PropertyId, config.allowedGa4PropertyIds, path, ["properties"], input.request.query);
    return;
  }

  if (product === "gtm") {
    assertRawPathEntityAllowed("GTM account", input.gtmAccountId, config.allowedGtmAccountIds, path, ["accounts"], input.request.query);
    assertRawPathEntityAllowed("GTM container", input.gtmContainerId, config.allowedGtmContainerIds, path, ["containers"], input.request.query);
    return;
  }

  if (product === "sa360") {
    assertRawPathEntityAllowed("SA360 customer", input.sa360CustomerId, config.allowedSa360CustomerIds, path, ["customers"], input.request.query);
  }
}

function assertRawPathEntityAllowed(
  entityName: string,
  declaredId: string | undefined,
  allowlist: Set<string>,
  requestPath: string,
  resourceNames: readonly string[],
  query: QueryParams | undefined
): void {
  const targetIds = extractPathEntityIds(requestPath, resourceNames, query);

  if (declaredId && targetIds.size > 0 && !targetIds.has(declaredId)) {
    throw new SafetyError(
      `${entityName} metadata ${declaredId} does not match the target encoded in the raw request path.`
    );
  }

  if (allowlist.size === 0) {
    return;
  }

  if (targetIds.size === 0) {
    throw new SafetyError(
      `${entityName} allowlist cannot be verified from this raw request path. Use a first-class tool or disable the raw request.`
    );
  }

  for (const targetId of targetIds) {
    assertEntityAllowed(entityName, targetId, allowlist);
  }
}

function rawRequestPath(requestPath: string): string {
  try {
    return new URL(requestPath, "https://mcp.invalid").pathname;
  } catch {
    throw new SafetyError("Raw request path must be a valid API path.");
  }
}

function extractPathEntityIds(
  requestPath: string,
  resourceNames: readonly string[],
  query: QueryParams | undefined
): Set<string> {
  const ids = new Set<string>();
  const segments = requestPath.split("/").filter(Boolean);

  for (let index = 0; index < segments.length; index += 1) {
    const resourceSegment = segments[index]?.split(":", 1)[0];
    if (!resourceSegment || !resourceNames.includes(resourceSegment)) {
      continue;
    }

    const rawId = segments[index + 1];
    if (rawId) {
      const id = rawId.split(":", 1)[0];
      if (id) {
        ids.add(id);
      }
      continue;
    }

    const queryIds = query?.id;
    for (const queryId of Array.isArray(queryIds) ? queryIds : [queryIds]) {
      if (typeof queryId === "string" || typeof queryId === "number") {
        ids.add(String(queryId));
      }
    }
  }

  return ids;
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

export async function auditLiveCompletion(
  config: ServerConfig,
  input: MutationGuardInput
): Promise<{ code: "audit_log_failed"; message: string } | undefined> {
  try {
    await auditMutation(config, input, "live_completed");
    return undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      code: "audit_log_failed",
      message: `The Google request succeeded, but the local completion audit record could not be written: ${detail}`
    };
  }
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
