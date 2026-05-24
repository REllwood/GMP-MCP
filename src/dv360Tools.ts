import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { HttpMethod } from "./cm360Client.js";
import type { ServerConfig } from "./config.js";
import type { GoogleApiClient } from "./googleApiClient.js";
import { jsonResult } from "./response.js";
import { confirmSchema, dryRunSchema, idString, jsonObject, mutationControls, querySchema } from "./schemas.js";
import {
  assertAllowedEntities,
  assertBroadListAllowed,
  assertEntityAllowed,
  assertEntityIdsAllowed
} from "./safety.js";
import { runGuardedGoogleRequest, runRawGoogleRequest, safeRun, stringField } from "./toolHelpers.js";

interface Dv360ToolContext {
  dv360Client: GoogleApiClient;
  bidManagerClient: GoogleApiClient;
  config: ServerConfig;
}

const advertiserInput = z.object({
  advertiserId: idString
});

const advertiserListInput = z.object({
  advertiserId: idString,
  query: querySchema
});

export function registerDv360Tools(server: McpServer, context: Dv360ToolContext): void {
  registerDv360ReadTools(server, context);
  registerDv360WriteTools(server, context);
  registerBidManagerTools(server, context);
  registerDv360RawTools(server, context);
}

function registerDv360ReadTools(server: McpServer, { dv360Client, config }: Dv360ToolContext): void {
  server.registerTool(
    "dv360_list_partners",
    {
      description: "List Display & Video 360 partners visible to the authenticated principal.",
      inputSchema: z.object({ query: querySchema })
    },
    async ({ query }) =>
      safeRun(async () => {
        assertBroadListAllowed("DV360 partner", config.allowedDv360PartnerIds);
        return jsonResult(await dv360Client.request({ method: "GET", path: "/partners", query }));
      })
  );

  server.registerTool(
    "dv360_get_partner",
    {
      description: "Get one Display & Video 360 partner.",
      inputSchema: z.object({ partnerId: idString })
    },
    async ({ partnerId }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "dv360", toolName: "dv360_get_partner", partnerId, request: { method: "GET", path: `/partners/${partnerId}` } });
        return jsonResult(await dv360Client.request({ method: "GET", path: `/partners/${partnerId}` }));
      })
  );

  server.registerTool(
    "dv360_list_advertisers",
    {
      description: "List Display & Video 360 advertisers.",
      inputSchema: z.object({ query: querySchema })
    },
    async ({ query }) =>
      safeRun(async () => {
        assertBroadListAllowed("DV360 advertiser", config.allowedDv360AdvertiserIds);
        return jsonResult(await dv360Client.request({ method: "GET", path: "/advertisers", query }));
      })
  );

  server.registerTool(
    "dv360_get_advertiser",
    {
      description: "Get one Display & Video 360 advertiser.",
      inputSchema: advertiserInput
    },
    async ({ advertiserId }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "dv360", toolName: "dv360_get_advertiser", advertiserId, request: { method: "GET", path: `/advertisers/${advertiserId}` } });
        return jsonResult(await dv360Client.request({ method: "GET", path: `/advertisers/${advertiserId}` }));
      })
  );

  registerAdvertiserResource(server, { dv360Client, config }, {
    listTool: "dv360_list_campaigns",
    getTool: "dv360_get_campaign",
    resource: "campaigns",
    singular: "campaign",
    idName: "campaignId",
    idAllowlistName: "campaignId"
  });

  registerAdvertiserResource(server, { dv360Client, config }, {
    listTool: "dv360_list_insertion_orders",
    getTool: "dv360_get_insertion_order",
    resource: "insertionOrders",
    singular: "insertion order",
    idName: "insertionOrderId",
    idAllowlistName: "insertionOrderId"
  });

  registerAdvertiserResource(server, { dv360Client, config }, {
    listTool: "dv360_list_line_items",
    getTool: "dv360_get_line_item",
    resource: "lineItems",
    singular: "line item",
    idName: "lineItemId",
    idAllowlistName: "lineItemId"
  });

  registerAdvertiserResource(server, { dv360Client, config }, {
    listTool: "dv360_list_creatives",
    getTool: "dv360_get_creative",
    resource: "creatives",
    singular: "creative",
    idName: "creativeId"
  });

  server.registerTool(
    "dv360_list_targeting_options",
    {
      description: "List targetable DV360 options for a targeting type.",
      inputSchema: z.object({
        targetingType: z.string().min(1),
        query: querySchema
      })
    },
    async ({ targetingType, query }) =>
      safeRun(async () =>
        jsonResult(
          await dv360Client.request({
            method: "GET",
            path: `/targetingTypes/${targetingType}/targetingOptions`,
            query
          })
        )
      )
  );

  server.registerTool(
    "dv360_list_assigned_targeting_options",
    {
      description: "List assigned DV360 targeting options at advertiser, campaign, insertion order or line item level.",
      inputSchema: z.object({
        advertiserId: idString,
        targetingType: z.string().min(1).optional(),
        level: z.enum(["advertiser", "campaign", "insertionOrder", "lineItem"]),
        campaignId: idString.optional(),
        insertionOrderId: idString.optional(),
        lineItemId: idString.optional(),
        query: querySchema
      })
    },
    async ({ advertiserId, targetingType, level, campaignId, insertionOrderId, lineItemId, query }) =>
      safeRun(async () => {
        const path = assignedTargetingListPath({ advertiserId, targetingType, level, campaignId, insertionOrderId, lineItemId });
        assertAllowedEntities(config, {
          product: "dv360",
          toolName: "dv360_list_assigned_targeting_options",
          advertiserId,
          campaignId,
          insertionOrderId,
          lineItemId,
          request: { method: "GET", path }
        });
        return jsonResult(
          await dv360Client.request({
            method: "GET",
            path,
            query
          })
        );
      })
  );

  server.registerTool(
    "dv360_bulk_list_line_item_assigned_targeting_options",
    {
      description: "Bulk list assigned targeting options for multiple DV360 line items across targeting types.",
      inputSchema: z.object({
        advertiserId: idString,
        lineItemIds: z.array(idString).optional().describe("Line item IDs expected to be queried. Required when DV360_ALLOWED_LINE_ITEM_IDS is configured."),
        query: querySchema
      })
    },
    async ({ advertiserId, lineItemIds, query }) =>
      safeRun(async () => {
        assertEntityIdsAllowed("DV360 line item", lineItemIds, config.allowedDv360LineItemIds, {
          requireWhenAllowlisted: true
        });
        assertAllowedEntities(config, {
          product: "dv360",
          toolName: "dv360_bulk_list_line_item_assigned_targeting_options",
          advertiserId,
          request: { method: "GET", path: `/advertisers/${advertiserId}/lineItems:bulkListAssignedTargetingOptions` }
        });
        return jsonResult(
          await dv360Client.request({
            method: "GET",
            path: `/advertisers/${advertiserId}/lineItems:bulkListAssignedTargetingOptions`,
            query: {
              ...query,
              lineItemIds: lineItemIds ?? query?.lineItemIds
            }
          })
        );
      })
  );
}

function registerDv360WriteTools(server: McpServer, { dv360Client, config }: Dv360ToolContext): void {
  registerCreateAndPatch(server, { dv360Client, config }, {
    createTool: "dv360_create_campaign",
    patchTool: "dv360_patch_campaign",
    resource: "campaigns",
    bodyName: "campaign",
    idName: "campaignId",
    idAllowlistName: "campaignId"
  });

  registerCreateAndPatch(server, { dv360Client, config }, {
    createTool: "dv360_create_insertion_order",
    patchTool: "dv360_patch_insertion_order",
    resource: "insertionOrders",
    bodyName: "insertionOrder",
    idName: "insertionOrderId",
    idAllowlistName: "insertionOrderId"
  });

  registerCreateAndPatch(server, { dv360Client, config }, {
    createTool: "dv360_create_line_item",
    patchTool: "dv360_patch_line_item",
    resource: "lineItems",
    bodyName: "lineItem",
    idName: "lineItemId",
    idAllowlistName: "lineItemId"
  });

  registerCreateAndPatch(server, { dv360Client, config }, {
    createTool: "dv360_create_creative",
    patchTool: "dv360_patch_creative",
    resource: "creatives",
    bodyName: "creative",
    idName: "creativeId"
  });

  server.registerTool(
    "dv360_duplicate_line_item",
    {
      description: "Duplicate a DV360 line item. Live execution requires dryRun=false and confirm=true.",
      inputSchema: z.object({
        advertiserId: idString,
        lineItemId: idString,
        request: jsonObject.optional(),
        ...mutationControls
      })
    },
    async ({ advertiserId, lineItemId, request, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client: dv360Client,
        config,
        product: "dv360",
        toolName: "dv360_duplicate_line_item",
        advertiserId,
        lineItemId,
        dryRun,
        confirm,
        request: {
          method: "POST",
          path: `/advertisers/${advertiserId}/lineItems/${lineItemId}:duplicate`,
          body: request ?? {}
        }
      })
  );

  server.registerTool(
    "dv360_bulk_update_line_items",
    {
      description: "Bulk update DV360 line items for one advertiser.",
      inputSchema: z.object({
        advertiserId: idString,
        lineItemIds: z.array(idString).optional().describe("Line item IDs expected to be touched by the bulk request. Required when DV360_ALLOWED_LINE_ITEM_IDS is configured and IDs cannot be inferred from the request body."),
        request: jsonObject,
        ...mutationControls
      })
    },
    async ({ advertiserId, lineItemIds, request, dryRun, confirm }) =>
      safeRun(async () => {
        assertBulkLineItemAllowlist(config, lineItemIds, request);
        return runGuardedGoogleRequest({
          client: dv360Client,
          config,
          product: "dv360",
          toolName: "dv360_bulk_update_line_items",
          advertiserId,
          dryRun,
          confirm,
          request: {
            method: "POST",
            path: `/advertisers/${advertiserId}/lineItems:bulkUpdate`,
            body: request
          }
        });
      })
  );

  server.registerTool(
    "dv360_assign_targeting_option",
    {
      description: "Assign a DV360 targeting option at insertion order or line item level.",
      inputSchema: z.object({
        advertiserId: idString,
        targetingType: z.string().min(1),
        level: z.enum(["insertionOrder", "lineItem"]),
        assignedTargetingOption: jsonObject,
        insertionOrderId: idString.optional(),
        lineItemId: idString.optional(),
        ...mutationControls
      })
    },
    async ({ advertiserId, targetingType, level, assignedTargetingOption, insertionOrderId, lineItemId, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client: dv360Client,
        config,
        product: "dv360",
        toolName: "dv360_assign_targeting_option",
        advertiserId,
        insertionOrderId,
        lineItemId,
        dryRun,
        confirm,
        request: {
          method: "POST",
          path: assignedTargetingPath({ advertiserId, targetingType, level, insertionOrderId, lineItemId }),
          body: assignedTargetingOption
        }
      })
  );

  server.registerTool(
    "dv360_edit_advertiser_targeting_options",
    {
      description: "Bulk edit targeting options under a single DV360 advertiser.",
      inputSchema: z.object({
        advertiserId: idString,
        request: jsonObject,
        ...mutationControls
      })
    },
    async ({ advertiserId, request, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client: dv360Client,
        config,
        product: "dv360",
        toolName: "dv360_edit_advertiser_targeting_options",
        advertiserId,
        dryRun,
        confirm,
        request: {
          method: "POST",
          path: `/advertisers/${advertiserId}:editAssignedTargetingOptions`,
          body: request
        }
      })
  );

  server.registerTool(
    "dv360_bulk_edit_line_item_targeting",
    {
      description: "Bulk edit assigned targeting options across one or more DV360 line items.",
      inputSchema: z.object({
        advertiserId: idString,
        lineItemId: idString.optional().describe("Optional single line item allowlist check when the request only touches one line item."),
        lineItemIds: z.array(idString).optional().describe("Line item IDs expected to be touched by the bulk request. Required when DV360_ALLOWED_LINE_ITEM_IDS is configured and IDs cannot be inferred from the request body."),
        request: jsonObject,
        ...mutationControls
      })
    },
    async ({ advertiserId, lineItemId, lineItemIds, request, dryRun, confirm }) =>
      safeRun(async () => {
        assertBulkLineItemAllowlist(
          config,
          lineItemId ? [lineItemId, ...(lineItemIds ?? [])] : lineItemIds,
          request
        );
        return runGuardedGoogleRequest({
          client: dv360Client,
          config,
          product: "dv360",
          toolName: "dv360_bulk_edit_line_item_targeting",
          advertiserId,
          lineItemId,
          dryRun,
          confirm,
          request: {
            method: "POST",
            path: `/advertisers/${advertiserId}/lineItems:bulkEditAssignedTargetingOptions`,
            body: request
          }
        });
      })
  );
}

function registerBidManagerTools(server: McpServer, { bidManagerClient, config }: Dv360ToolContext): void {
  server.registerTool(
    "bidmanager_list_queries",
    {
      description: "List Bid Manager reporting queries for DV360 reporting.",
      inputSchema: z.object({ query: querySchema })
    },
    async ({ query }) =>
      safeRun(async () => {
        assertBroadListAllowed("Bid Manager query", config.allowedBidManagerQueryIds);
        return jsonResult(await bidManagerClient.request({ method: "GET", path: "/queries", query }));
      })
  );

  server.registerTool(
    "bidmanager_get_query",
    {
      description: "Get one Bid Manager reporting query.",
      inputSchema: z.object({ queryId: idString })
    },
    async ({ queryId }) =>
      safeRun(async () => {
        assertEntityAllowed("Bid Manager query", queryId, config.allowedBidManagerQueryIds);
        return jsonResult(await bidManagerClient.request({ method: "GET", path: `/queries/${queryId}` }));
      })
  );

  server.registerTool(
    "bidmanager_create_query",
    {
      description: "Create a Bid Manager reporting query.",
      inputSchema: z.object({
        query: jsonObject,
        ...mutationControls
      })
    },
    async ({ query, dryRun, confirm }) =>
      safeRun(async () => {
        assertEntityIdsAllowed("Bid Manager query", undefined, config.allowedBidManagerQueryIds, {
          requireWhenAllowlisted: true
        });
        return runGuardedGoogleRequest({
          client: bidManagerClient,
          config,
          product: "bidManager",
          toolName: "bidmanager_create_query",
          dryRun,
          confirm,
          request: {
            method: "POST",
            path: "/queries",
            body: query
          }
        });
      })
  );

  server.registerTool(
    "bidmanager_run_query",
    {
      description: "Run a Bid Manager reporting query.",
      inputSchema: z.object({
        queryId: idString,
        request: jsonObject.optional(),
        ...mutationControls
      })
    },
    async ({ queryId, request, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client: bidManagerClient,
        config,
        product: "bidManager",
        toolName: "bidmanager_run_query",
        bidManagerQueryId: queryId,
        dryRun,
        confirm,
        request: {
          method: "POST",
          path: `/queries/${queryId}:run`,
          body: request ?? {}
        }
      })
  );

  server.registerTool(
    "bidmanager_list_reports",
    {
      description: "List generated reports for a Bid Manager query.",
      inputSchema: z.object({
        queryId: idString,
        query: querySchema
      })
    },
    async ({ queryId, query }) =>
      safeRun(async () => {
        assertEntityAllowed("Bid Manager query", queryId, config.allowedBidManagerQueryIds);
        return jsonResult(await bidManagerClient.request({ method: "GET", path: `/queries/${queryId}/reports`, query }));
      })
  );

  server.registerTool(
    "bidmanager_get_report",
    {
      description: "Get one generated Bid Manager report metadata record.",
      inputSchema: z.object({
        queryId: idString,
        reportId: idString
      })
    },
    async ({ queryId, reportId }) =>
      safeRun(async () => {
        assertEntityAllowed("Bid Manager query", queryId, config.allowedBidManagerQueryIds);
        return jsonResult(await bidManagerClient.request({ method: "GET", path: `/queries/${queryId}/reports/${reportId}` }));
      })
  );

  server.registerTool(
    "bidmanager_download_report_url",
    {
      description: "Download a generated Bid Manager report from a URL returned by the reporting API.",
      inputSchema: z.object({
        url: z.url(),
        queryId: idString.optional().describe("Bid Manager query ID associated with the report URL. Required when BID_MANAGER_ALLOWED_QUERY_IDS is configured."),
        fileName: z.string().min(1),
        maxPreviewBytes: z.number().int().positive().max(65536).optional().default(4096)
      })
    },
    async ({ url, queryId, fileName, maxPreviewBytes }) =>
      safeRun(async () => {
        assertEntityIdsAllowed("Bid Manager query", queryId ? [queryId] : undefined, config.allowedBidManagerQueryIds, {
          requireWhenAllowlisted: true
        });
        return jsonResult(
          await bidManagerClient.downloadFromUrl({
            url,
            fileName,
            maxPreviewBytes
          })
        );
      })
  );
}

function registerDv360RawTools(server: McpServer, { dv360Client, bidManagerClient, config }: Dv360ToolContext): void {
  const rawInput = z.object({
    method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
    path: z.string().min(1),
    query: querySchema,
    body: z.unknown().optional(),
    partnerId: idString.optional(),
    advertiserId: idString.optional(),
    campaignId: idString.optional(),
    insertionOrderId: idString.optional(),
    lineItemId: idString.optional(),
    queryId: idString.optional(),
    dryRun: dryRunSchema,
    confirm: confirmSchema
  });

  server.registerTool(
    "dv360_api_request",
    {
      description: "Advanced DV360 API request. Disabled unless DV360_ENABLE_RAW_REQUEST or GMP_ENABLE_RAW_REQUEST is true.",
      inputSchema: rawInput
    },
    async ({ method, path, query, body, partnerId, advertiserId, campaignId, insertionOrderId, lineItemId, dryRun, confirm }) =>
      runRawGoogleRequest({
        client: dv360Client,
        config,
        product: "dv360",
        toolName: "dv360_api_request",
        partnerId,
        advertiserId,
        campaignId,
        insertionOrderId,
        lineItemId,
        dryRun,
        confirm,
        request: { method, path, query, body }
      })
  );

  server.registerTool(
    "bidmanager_api_request",
    {
      description: "Advanced Bid Manager API request. Disabled unless BID_MANAGER_ENABLE_RAW_REQUEST or GMP_ENABLE_RAW_REQUEST is true.",
      inputSchema: rawInput
    },
    async ({ method, path, query, body, partnerId, advertiserId, campaignId, insertionOrderId, lineItemId, queryId, dryRun, confirm }) =>
      runRawGoogleRequest({
        client: bidManagerClient,
        config,
        product: "bidManager",
        toolName: "bidmanager_api_request",
        partnerId,
        advertiserId,
        campaignId,
        insertionOrderId,
        lineItemId,
        bidManagerQueryId: queryId,
        dryRun,
        confirm,
        request: { method, path, query, body }
      })
  );
}

function registerAdvertiserResource(
  server: McpServer,
  { dv360Client, config }: Pick<Dv360ToolContext, "dv360Client" | "config">,
  options: {
    listTool: string;
    getTool: string;
    resource: string;
    singular: string;
    idName: string;
    idAllowlistName?: "campaignId" | "insertionOrderId" | "lineItemId";
  }
): void {
  server.registerTool(
    options.listTool,
    {
      description: `List DV360 ${options.singular}s for an advertiser.`,
      inputSchema: advertiserListInput
    },
    async ({ advertiserId, query }) =>
      safeRun(async () => {
        assertDv360BroadResourceListAllowed(config, options.idAllowlistName, options.singular);
        assertAllowedEntities(config, { product: "dv360", toolName: options.listTool, advertiserId, request: { method: "GET", path: `/advertisers/${advertiserId}/${options.resource}` } });
        return jsonResult(await dv360Client.request({ method: "GET", path: `/advertisers/${advertiserId}/${options.resource}`, query }));
      })
  );

  server.registerTool(
    options.getTool,
    {
      description: `Get one DV360 ${options.singular}.`,
      inputSchema: z.object({
        advertiserId: idString,
        [options.idName]: idString
      })
    },
    async (input) =>
      safeRun(async () => {
        const advertiserId = input.advertiserId;
        const resourceId = String(input[options.idName]);
        assertAllowedEntities(config, {
          product: "dv360",
          toolName: options.getTool,
          advertiserId,
          ...allowlistEntity(options.idAllowlistName, resourceId),
          request: { method: "GET", path: `/advertisers/${advertiserId}/${options.resource}/${resourceId}` }
        });
        return jsonResult(
          await dv360Client.request({
            method: "GET",
            path: `/advertisers/${advertiserId}/${options.resource}/${resourceId}`
          })
        );
      })
  );
}

function registerCreateAndPatch(
  server: McpServer,
  { dv360Client, config }: Pick<Dv360ToolContext, "dv360Client" | "config">,
  options: {
    createTool: string;
    patchTool: string;
    resource: string;
    bodyName: string;
    idName: string;
    idAllowlistName?: "campaignId" | "insertionOrderId" | "lineItemId";
  }
): void {
  server.registerTool(
    options.createTool,
    {
      description: `Create a DV360 ${options.bodyName}.`,
      inputSchema: z.object({
        advertiserId: idString,
        resource: jsonObject,
        ...mutationControls
      })
    },
    async ({ advertiserId, resource, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client: dv360Client,
        config,
        product: "dv360",
        toolName: options.createTool,
        advertiserId,
        campaignId: stringField(resource, "campaignId"),
        insertionOrderId: stringField(resource, "insertionOrderId"),
        lineItemId: stringField(resource, "lineItemId"),
        dryRun,
        confirm,
        request: {
          method: "POST",
          path: `/advertisers/${advertiserId}/${options.resource}`,
          body: resource
        }
      })
  );

  server.registerTool(
    options.patchTool,
    {
      description: `Patch selected fields on a DV360 ${options.bodyName}.`,
      inputSchema: z.object({
        advertiserId: idString,
        [options.idName]: idString,
        patch: jsonObject,
        updateMask: z.string().min(1).optional(),
        ...mutationControls
      })
    },
    async (input) => {
      const indexedInput = input as Record<string, unknown> & typeof input;
      const advertiserId = input.advertiserId;
      const resourceId = String(indexedInput[options.idName]);
      const patch = input.patch as Record<string, unknown>;
      return runGuardedGoogleRequest({
        client: dv360Client,
        config,
        product: "dv360",
        toolName: options.patchTool,
        advertiserId,
        ...allowlistEntity(options.idAllowlistName, resourceId),
        campaignId: stringField(patch, "campaignId") ?? allowlistEntity(options.idAllowlistName, resourceId).campaignId,
        insertionOrderId:
          stringField(patch, "insertionOrderId") ?? allowlistEntity(options.idAllowlistName, resourceId).insertionOrderId,
        lineItemId: stringField(patch, "lineItemId") ?? allowlistEntity(options.idAllowlistName, resourceId).lineItemId,
        dryRun: input.dryRun,
        confirm: input.confirm,
        request: {
          method: "PATCH",
          path: `/advertisers/${advertiserId}/${options.resource}/${resourceId}`,
          query: { updateMask: input.updateMask },
          body: patch
        }
      });
    }
  );
}

function allowlistEntity(idName: "campaignId" | "insertionOrderId" | "lineItemId" | undefined, id: string) {
  if (idName === "campaignId") {
    return { campaignId: id };
  }

  if (idName === "insertionOrderId") {
    return { insertionOrderId: id };
  }

  if (idName === "lineItemId") {
    return { lineItemId: id };
  }

  return {};
}

function assignedTargetingPath(args: {
  advertiserId: string;
  targetingType: string;
  level: "insertionOrder" | "lineItem";
  campaignId?: string;
  insertionOrderId?: string;
  lineItemId?: string;
}): string {
  const base = `/advertisers/${args.advertiserId}`;
  const suffix = `/targetingTypes/${args.targetingType}/assignedTargetingOptions`;

  if (args.level === "insertionOrder") {
    assertRequiredId("insertionOrderId", args.insertionOrderId);
    return `${base}/insertionOrders/${args.insertionOrderId}${suffix}`;
  }

  assertRequiredId("lineItemId", args.lineItemId);
  return `${base}/lineItems/${args.lineItemId}${suffix}`;
}

function assignedTargetingListPath(args: {
  advertiserId: string;
  targetingType?: string;
  level: "advertiser" | "campaign" | "insertionOrder" | "lineItem";
  campaignId?: string;
  insertionOrderId?: string;
  lineItemId?: string;
}): string {
  const base = `/advertisers/${args.advertiserId}`;

  if (args.level === "advertiser") {
    return `${base}:listAssignedTargetingOptions`;
  }

  if (args.level === "campaign") {
    assertRequiredId("campaignId", args.campaignId);
    if (!args.targetingType) {
      return `${base}/campaigns/${args.campaignId}:listAssignedTargetingOptions`;
    }
    return `${base}/campaigns/${args.campaignId}/targetingTypes/${args.targetingType}/assignedTargetingOptions`;
  }

  if (!args.targetingType) {
    throw new Error("targetingType is required for insertion order and line item targeting lists.");
  }

  if (args.level === "insertionOrder") {
    assertRequiredId("insertionOrderId", args.insertionOrderId);
    return `${base}/insertionOrders/${args.insertionOrderId}/targetingTypes/${args.targetingType}/assignedTargetingOptions`;
  }

  assertRequiredId("lineItemId", args.lineItemId);
  return `${base}/lineItems/${args.lineItemId}/targetingTypes/${args.targetingType}/assignedTargetingOptions`;
}

function assertRequiredId(name: string, value: string | undefined): asserts value is string {
  if (!value) {
    throw new Error(`${name} is required for this targeting level.`);
  }
}

function assertDv360BroadResourceListAllowed(
  config: ServerConfig,
  idAllowlistName: "campaignId" | "insertionOrderId" | "lineItemId" | undefined,
  singular: string
): void {
  if (idAllowlistName === "campaignId") {
    assertBroadListAllowed(`DV360 ${singular}`, config.allowedDv360CampaignIds);
    return;
  }

  if (idAllowlistName === "insertionOrderId") {
    assertBroadListAllowed(`DV360 ${singular}`, config.allowedDv360InsertionOrderIds);
    return;
  }

  if (idAllowlistName === "lineItemId") {
    assertBroadListAllowed(`DV360 ${singular}`, config.allowedDv360LineItemIds);
  }
}

function assertBulkLineItemAllowlist(
  config: ServerConfig,
  explicitLineItemIds: readonly string[] | undefined,
  request: unknown
): void {
  const lineItemIds = new Set([
    ...(explicitLineItemIds ?? []),
    ...collectLineItemIds(request)
  ]);

  assertEntityIdsAllowed(
    "DV360 line item",
    [...lineItemIds],
    config.allowedDv360LineItemIds,
    { requireWhenAllowlisted: true }
  );
}

function collectLineItemIds(value: unknown): string[] {
  const ids = new Set<string>();
  collectLineItemIdsInto(value, ids);
  return [...ids];
}

function collectLineItemIdsInto(value: unknown, ids: Set<string>): void {
  if (value === null || value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectLineItemIdsInto(item, ids);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (key === "lineItemId") {
      addLineItemId(nestedValue, ids);
      continue;
    }

    if (key === "lineItemIds") {
      addLineItemIds(nestedValue, ids);
      continue;
    }

    collectLineItemIdsInto(nestedValue, ids);
  }
}

function addLineItemId(value: unknown, ids: Set<string>): void {
  if (typeof value === "string" && value.trim()) {
    ids.add(value);
    return;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    ids.add(String(value));
  }
}

function addLineItemIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      addLineItemId(item, ids);
    }
    return;
  }

  addLineItemId(value, ids);
}
