import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { HttpMethod, QueryParams } from "./cm360Client.js";
import type { GmpProduct, ServerConfig } from "./config.js";
import type { GoogleApiClient } from "./googleApiClient.js";
import { errorResult, jsonResult } from "./response.js";
import { assertRawRequestAllowedEntities, auditMutation, guardMutation, rawRequestEnabled } from "./safety.js";

export interface GuardedRequestArgs {
  client: GoogleApiClient;
  config: ServerConfig;
  product: GmpProduct;
  toolName: string;
  profileId?: string;
  partnerId?: string;
  advertiserId?: string;
  campaignId?: string;
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
  request: {
    method: HttpMethod;
    path: string;
    query?: QueryParams;
    body?: unknown;
  };
}

export async function runGuardedGoogleRequest(args: GuardedRequestArgs): Promise<CallToolResult> {
  return safeRun(async () => {
    const guard = await guardMutation(args.config, {
      product: args.product,
      toolName: args.toolName,
      profileId: args.profileId,
      partnerId: args.partnerId,
      advertiserId: args.advertiserId,
      campaignId: args.campaignId,
      insertionOrderId: args.insertionOrderId,
      lineItemId: args.lineItemId,
      bidManagerQueryId: args.bidManagerQueryId,
      ga4AccountId: args.ga4AccountId,
      ga4PropertyId: args.ga4PropertyId,
      gtmAccountId: args.gtmAccountId,
      gtmContainerId: args.gtmContainerId,
      sa360CustomerId: args.sa360CustomerId,
      dryRun: args.dryRun,
      confirm: args.confirm,
      request: args.request
    });

    if (guard.dryRun) {
      return jsonResult(guard.preview);
    }

    const result = await args.client.request(args.request);
    await auditMutation(args.config, {
      product: args.product,
      toolName: args.toolName,
      profileId: args.profileId,
      partnerId: args.partnerId,
      advertiserId: args.advertiserId,
      campaignId: args.campaignId,
      insertionOrderId: args.insertionOrderId,
      lineItemId: args.lineItemId,
      bidManagerQueryId: args.bidManagerQueryId,
      ga4AccountId: args.ga4AccountId,
      ga4PropertyId: args.ga4PropertyId,
      gtmAccountId: args.gtmAccountId,
      gtmContainerId: args.gtmContainerId,
      sa360CustomerId: args.sa360CustomerId,
      request: args.request
    }, "live_completed");

    return jsonResult(result);
  });
}

export async function runRawGoogleRequest(args: GuardedRequestArgs): Promise<CallToolResult> {
  return safeRun(async () => {
    if (!rawRequestEnabled(args.config, args.product)) {
      throw new Error(
        `Raw ${args.product.toUpperCase()} requests are disabled. Set GMP_ENABLE_RAW_REQUEST=true or the product-specific raw request flag to enable this tool.`
      );
    }

    assertRawRequestAllowedEntities(args.config, {
      product: args.product,
      toolName: args.toolName,
      profileId: args.profileId,
      partnerId: args.partnerId,
      advertiserId: args.advertiserId,
      campaignId: args.campaignId,
      insertionOrderId: args.insertionOrderId,
      lineItemId: args.lineItemId,
      bidManagerQueryId: args.bidManagerQueryId,
      ga4AccountId: args.ga4AccountId,
      ga4PropertyId: args.ga4PropertyId,
      gtmAccountId: args.gtmAccountId,
      gtmContainerId: args.gtmContainerId,
      sa360CustomerId: args.sa360CustomerId,
      request: args.request
    });

    if (args.request.method === "GET") {
      return jsonResult(await args.client.request(args.request));
    }

    return runGuardedGoogleRequest(args);
  });
}

export async function safeRun<T extends CallToolResult>(
  fn: () => Promise<T>
): Promise<T | CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    return errorResult(error);
  }
}

export function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const fieldValue = value[key];
  if (typeof fieldValue === "string") {
    return fieldValue;
  }

  if (typeof fieldValue === "number") {
    return String(fieldValue);
  }

  return undefined;
}
