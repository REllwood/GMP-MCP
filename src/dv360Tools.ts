import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { ServerConfig } from "./config.js";
import type { GoogleApiClient } from "./googleApiClient.js";
import { jsonResult } from "./response.js";
import {
  apiPathSegment,
  confirmSchema,
  dryRunSchema,
  idString,
  jsonObject,
  mutationControls,
  querySchema
} from "./schemas.js";
import {
  assertAllowedEntities,
  assertBroadListAllowed,
  assertEntityAllowed,
  assertEntityIdsAllowed,
  SafetyError
} from "./safety.js";
import { runGuardedGoogleRequest, runRawGoogleRequest, safeRun, stringField } from "./toolHelpers.js";

interface Dv360ToolContext {
  dv360Client: GoogleApiClient;
  config: ServerConfig;
}

interface BidManagerToolContext {
  bidManagerClient: GoogleApiClient;
  config: ServerConfig;
}

type Dv360Resource = "campaigns" | "insertionOrders" | "lineItems" | "creatives";

// Each line item in a bulk request costs one rate-limited lookup when campaign or insertion order
// allowlists are set. Kept low so the lookups finish well inside a typical 60 second client timeout.
const maxVerifiedLineItems = 20;

const advertiserInput = z.object({
  advertiserId: idString
});

const advertiserListInput = z.object({
  advertiserId: idString,
  query: querySchema
});

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

export function registerDv360Tools(server: McpServer, context: Dv360ToolContext): void {
  registerDv360ReadTools(server, context);
  registerDv360WriteTools(server, context);
  registerDv360RawTool(server, context);
}

export function registerBidManagerTools(server: McpServer, context: BidManagerToolContext): void {
  registerBidManagerQueryTools(server, context);
  registerBidManagerRawTool(server, context);
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
      description: "List Display & Video 360 advertisers for the partner in query.partnerId.",
      inputSchema: z.object({ query: querySchema })
    },
    async ({ query }) =>
      safeRun(async () => {
        assertBroadListAllowed("DV360 advertiser", config.allowedDv360AdvertiserIds);
        assertNoQueryAliases(query, ["partnerId"]);
        assertEntityIdsAllowed("DV360 partner", queryValues(query?.partnerId), config.allowedDv360PartnerIds, {
          requireWhenAllowlisted: true
        });
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
        const path = `/advertisers/${advertiserId}`;
        assertAllowedEntities(config, { product: "dv360", toolName: "dv360_get_advertiser", advertiserId, request: { method: "GET", path } });
        const scope = await resolveDv360AdvertiserScope(dv360Client, config, advertiserId);
        return jsonResult(scope.object ?? (await dv360Client.request({ method: "GET", path })));
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
        targetingType: apiPathSegment,
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
      description: "List assigned DV360 targeting options at advertiser or line item level.",
      inputSchema: z.object({
        advertiserId: idString,
        targetingType: apiPathSegment.optional(),
        level: z.enum(["advertiser", "lineItem"]),
        lineItemId: idString.optional(),
        query: querySchema
      })
    },
    async ({ advertiserId, targetingType, level, lineItemId, query }) =>
      safeRun(async () => {
        const path = assignedTargetingListPath({ advertiserId, targetingType, level, lineItemId });
        assertAllowedEntities(config, {
          product: "dv360",
          toolName: "dv360_list_assigned_targeting_options",
          advertiserId,
          lineItemId,
          request: { method: "GET", path }
        });
        await resolveDv360AdvertiserScope(dv360Client, config, advertiserId);
        if (level === "lineItem" && lineItemId) {
          await resolveLineItemOwners(dv360Client, config, advertiserId, lineItemId);
        }
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
        lineItemIds: z.array(idString).optional().describe("Line item IDs to query. Required when DV360 line item, insertion order or campaign allowlists are configured."),
        query: querySchema
      })
    },
    async ({ advertiserId, lineItemIds, query }) =>
      safeRun(async () => {
        const path = `/advertisers/${advertiserId}/lineItems:bulkListAssignedTargetingOptions`;
        assertNoQueryAliases(query, ["lineItemIds"]);
        const targetLineItemIds = lineItemIds ?? queryValues(query?.lineItemIds);
        assertEntityIdsAllowed("DV360 line item", targetLineItemIds, config.allowedDv360LineItemIds, {
          requireWhenAllowlisted: true
        });
        assertAllowedEntities(config, {
          product: "dv360",
          toolName: "dv360_bulk_list_line_item_assigned_targeting_options",
          advertiserId,
          request: { method: "GET", path }
        });
        await resolveDv360AdvertiserScope(dv360Client, config, advertiserId);
        await verifyLineItemOwners(dv360Client, config, advertiserId, targetLineItemIds ?? []);
        return jsonResult(
          await dv360Client.request({
            method: "GET",
            path,
            query: {
              ...query,
              lineItemIds: targetLineItemIds
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
      description: "Duplicate a DV360 line item. Blocked while DV360_ALLOWED_LINE_ITEM_IDS is configured, because the copy's ID is not known in advance.",
      inputSchema: z.object({
        advertiserId: idString,
        lineItemId: idString,
        request: jsonObject.optional(),
        ...mutationControls
      })
    },
    async ({ advertiserId, lineItemId, request, dryRun, confirm }) =>
      safeRun(async () => {
        const apiRequest = {
          method: "POST" as const,
          path: `/advertisers/${advertiserId}/lineItems/${lineItemId}:duplicate`,
          body: request ?? {}
        };
        assertDv360CreateAllowed(config, "lineItemId", "line item");
        assertAllowedEntities(config, { product: "dv360", toolName: "dv360_duplicate_line_item", advertiserId, lineItemId, request: apiRequest });
        const scope = await resolveDv360ObjectScope(dv360Client, config, "lineItems", advertiserId, lineItemId);
        return runGuardedGoogleRequest({
          client: dv360Client,
          config,
          product: "dv360",
          toolName: "dv360_duplicate_line_item",
          partnerId: scope.partnerId,
          advertiserId,
          campaignId: scope.campaignId,
          insertionOrderId: scope.insertionOrderId,
          lineItemId,
          dryRun,
          confirm,
          request: apiRequest
        });
      })
  );

  server.registerTool(
    "dv360_bulk_update_line_items",
    {
      description: "Bulk update DV360 line items for one advertiser.",
      inputSchema: z.object({
        advertiserId: idString,
        lineItemIds: z.array(idString).optional().describe("Line item IDs expected to be touched by the bulk request. Required when DV360 line item, insertion order or campaign allowlists are configured and IDs cannot be inferred from the request body."),
        request: jsonObject,
        ...mutationControls
      })
    },
    async ({ advertiserId, lineItemIds, request, dryRun, confirm }) =>
      safeRun(async () => {
        const scope = await resolveBulkLineItemScope(dv360Client, config, advertiserId, lineItemIds, request);
        return runGuardedGoogleRequest({
          client: dv360Client,
          config,
          product: "dv360",
          toolName: "dv360_bulk_update_line_items",
          partnerId: scope.partnerId,
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
      description: "Assign a DV360 targeting option at line item level.",
      inputSchema: z.object({
        advertiserId: idString,
        targetingType: apiPathSegment,
        level: z.literal("lineItem").optional().default("lineItem"),
        assignedTargetingOption: jsonObject,
        lineItemId: idString,
        ...mutationControls
      })
    },
    async ({ advertiserId, targetingType, assignedTargetingOption, lineItemId, dryRun, confirm }) =>
      safeRun(async () => {
        const apiRequest = {
          method: "POST" as const,
          path: assignedTargetingPath({ advertiserId, targetingType, lineItemId }),
          body: assignedTargetingOption
        };
        assertAllowedEntities(config, { product: "dv360", toolName: "dv360_assign_targeting_option", advertiserId, lineItemId, request: apiRequest });
        const scope = await resolveDv360ObjectScope(dv360Client, config, "lineItems", advertiserId, lineItemId);
        return runGuardedGoogleRequest({
          client: dv360Client,
          config,
          product: "dv360",
          toolName: "dv360_assign_targeting_option",
          partnerId: scope.partnerId,
          advertiserId,
          campaignId: scope.campaignId,
          insertionOrderId: scope.insertionOrderId,
          lineItemId,
          dryRun,
          confirm,
          request: apiRequest
        });
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
      safeRun(async () => {
        assertEntityAllowed("DV360 advertiser", advertiserId, config.allowedDv360AdvertiserIds);
        const { partnerId } = await resolveDv360AdvertiserScope(dv360Client, config, advertiserId);
        return runGuardedGoogleRequest({
          client: dv360Client,
          config,
          product: "dv360",
          toolName: "dv360_edit_advertiser_targeting_options",
          partnerId,
          advertiserId,
          dryRun,
          confirm,
          request: {
            method: "POST",
            path: `/advertisers/${advertiserId}:editAssignedTargetingOptions`,
            body: request
          }
        });
      })
  );

  server.registerTool(
    "dv360_bulk_edit_line_item_targeting",
    {
      description: "Bulk edit assigned targeting options across one or more DV360 line items.",
      inputSchema: z.object({
        advertiserId: idString,
        lineItemId: idString.optional().describe("Optional single line item allowlist check when the request only touches one line item."),
        lineItemIds: z.array(idString).optional().describe("Line item IDs expected to be touched by the bulk request. Required when DV360 line item, insertion order or campaign allowlists are configured and IDs cannot be inferred from the request body."),
        request: jsonObject,
        ...mutationControls
      })
    },
    async ({ advertiserId, lineItemId, lineItemIds, request, dryRun, confirm }) =>
      safeRun(async () => {
        const scope = await resolveBulkLineItemScope(
          dv360Client,
          config,
          advertiserId,
          lineItemId ? [lineItemId, ...(lineItemIds ?? [])] : lineItemIds,
          request
        );
        return runGuardedGoogleRequest({
          client: dv360Client,
          config,
          product: "dv360",
          toolName: "dv360_bulk_edit_line_item_targeting",
          partnerId: scope.partnerId,
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

function registerBidManagerQueryTools(server: McpServer, { bidManagerClient, config }: BidManagerToolContext): void {
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
    "bidmanager_download_report",
    {
      description:
        "Download a finished Bid Manager report to the local download directory and return a small text preview. The file location comes from the report's own metadata.",
      inputSchema: z.object({
        queryId: idString,
        reportId: idString,
        fileName: z.string().min(1).optional(),
        maxPreviewBytes: z.number().int().positive().max(65536).optional().default(4096)
      })
    },
    async ({ queryId, reportId, fileName, maxPreviewBytes }) =>
      safeRun(async () => {
        assertEntityAllowed("Bid Manager query", queryId, config.allowedBidManagerQueryIds);
        const report = await bidManagerClient.request({ method: "GET", path: `/queries/${queryId}/reports/${reportId}` });
        const file = reportFileLocation(report, queryId, reportId);
        return jsonResult(
          await bidManagerClient.downloadSignedFile({
            url: file.url,
            fileName: fileName ?? `bidmanager-report-${queryId}-${reportId}${file.extension}`,
            maxPreviewBytes
          })
        );
      })
  );
}

function registerDv360RawTool(server: McpServer, { dv360Client, config }: Dv360ToolContext): void {
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
}

function registerBidManagerRawTool(server: McpServer, { bidManagerClient, config }: BidManagerToolContext): void {
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
  { dv360Client, config }: Dv360ToolContext,
  options: {
    listTool: string;
    getTool: string;
    resource: Dv360Resource;
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
        assertDv360BroadResourceListAllowed(config, options.resource, options.singular);
        assertAllowedEntities(config, { product: "dv360", toolName: options.listTool, advertiserId, request: { method: "GET", path: `/advertisers/${advertiserId}/${options.resource}` } });
        await resolveDv360AdvertiserScope(dv360Client, config, advertiserId);
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
        const path = `/advertisers/${advertiserId}/${options.resource}/${resourceId}`;
        assertAllowedEntities(config, {
          product: "dv360",
          toolName: options.getTool,
          advertiserId,
          ...allowlistEntity(options.idAllowlistName, resourceId),
          request: { method: "GET", path }
        });
        const scope = await resolveDv360ObjectScope(dv360Client, config, options.resource, advertiserId, resourceId);
        return jsonResult(scope.object ?? (await dv360Client.request({ method: "GET", path })));
      })
  );
}

function registerCreateAndPatch(
  server: McpServer,
  { dv360Client, config }: Dv360ToolContext,
  options: {
    createTool: string;
    patchTool: string;
    resource: Dv360Resource;
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
      safeRun(async () => {
        assertDv360CreateAllowed(config, options.idAllowlistName, options.bodyName);
        assertEntityAllowed("DV360 advertiser", advertiserId, config.allowedDv360AdvertiserIds);
        const { partnerId } = await resolveDv360AdvertiserScope(dv360Client, config, advertiserId);
        const parents = await resolveCreateParents(dv360Client, config, options.resource, advertiserId, resource);
        return runGuardedGoogleRequest({
          client: dv360Client,
          config,
          product: "dv360",
          toolName: options.createTool,
          partnerId,
          advertiserId,
          campaignId: parents.campaignId,
          insertionOrderId: parents.insertionOrderId,
          lineItemId: stringField(resource, "lineItemId"),
          dryRun,
          confirm,
          request: {
            method: "POST",
            path: `/advertisers/${advertiserId}/${options.resource}`,
            body: resource
          }
        });
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
    async (input) =>
      safeRun(async () => {
        const indexedInput = input as Record<string, unknown> & typeof input;
        const advertiserId = input.advertiserId;
        const resourceId = String(indexedInput[options.idName]);
        const patch = input.patch as Record<string, unknown>;
        const declared = allowlistEntity(options.idAllowlistName, resourceId);
        const request = {
          method: "PATCH" as const,
          path: `/advertisers/${advertiserId}/${options.resource}/${resourceId}`,
          query: { updateMask: input.updateMask },
          body: patch
        };
        assertAllowedEntities(config, { product: "dv360", toolName: options.patchTool, advertiserId, ...declared, request });
        const scope = await resolveDv360ObjectScope(dv360Client, config, options.resource, advertiserId, resourceId);
        return runGuardedGoogleRequest({
          client: dv360Client,
          config,
          product: "dv360",
          toolName: options.patchTool,
          partnerId: scope.partnerId,
          advertiserId,
          campaignId: stringField(patch, "campaignId") ?? declared.campaignId ?? scope.campaignId,
          insertionOrderId: stringField(patch, "insertionOrderId") ?? declared.insertionOrderId ?? scope.insertionOrderId,
          lineItemId: stringField(patch, "lineItemId") ?? declared.lineItemId,
          dryRun: input.dryRun,
          confirm: input.confirm,
          request
        });
      })
  );
}

interface Dv360Scope {
  partnerId?: string;
  campaignId?: string;
  insertionOrderId?: string;
  object?: Record<string, unknown>;
}

// Allowlists for a parent (partner, campaign, insertion order) are checked against the owner that
// Google reports for the target object, never against IDs supplied by the caller.
async function resolveDv360AdvertiserScope(
  client: GoogleApiClient,
  config: ServerConfig,
  advertiserId: string
): Promise<Dv360Scope> {
  if (config.allowedDv360PartnerIds.size === 0) {
    return {};
  }

  const advertiser = await fetchDv360Object(client, `/advertisers/${advertiserId}`, `DV360 advertiser ${advertiserId}`);
  const partnerId = requiredOwnerId(advertiser, "partnerId", `DV360 advertiser ${advertiserId}`);
  assertEntityAllowed("DV360 partner", partnerId, config.allowedDv360PartnerIds);
  return { partnerId, object: advertiser };
}

async function resolveDv360ObjectScope(
  client: GoogleApiClient,
  config: ServerConfig,
  resource: Dv360Resource,
  advertiserId: string,
  resourceId: string
): Promise<Dv360Scope> {
  const { partnerId } = await resolveDv360AdvertiserScope(client, config, advertiserId);

  if (resource === "insertionOrders") {
    return { partnerId, ...(await resolveInsertionOrderOwner(client, config, advertiserId, resourceId)) };
  }

  if (resource === "lineItems") {
    return { partnerId, ...(await resolveLineItemOwners(client, config, advertiserId, resourceId)) };
  }

  return { partnerId };
}

async function resolveInsertionOrderOwner(
  client: GoogleApiClient,
  config: ServerConfig,
  advertiserId: string,
  insertionOrderId: string
): Promise<Dv360Scope> {
  if (config.allowedDv360CampaignIds.size === 0) {
    return {};
  }

  const label = `DV360 insertion order ${insertionOrderId}`;
  const insertionOrder = await fetchDv360Object(
    client,
    `/advertisers/${advertiserId}/insertionOrders/${insertionOrderId}`,
    label
  );
  const campaignId = requiredOwnerId(insertionOrder, "campaignId", label);
  assertEntityAllowed("DV360 campaign", campaignId, config.allowedDv360CampaignIds);
  return { campaignId, object: insertionOrder };
}

async function resolveLineItemOwners(
  client: GoogleApiClient,
  config: ServerConfig,
  advertiserId: string,
  lineItemId: string
): Promise<Dv360Scope> {
  const checkInsertionOrder = config.allowedDv360InsertionOrderIds.size > 0;
  const checkCampaign = config.allowedDv360CampaignIds.size > 0;
  if (!checkInsertionOrder && !checkCampaign) {
    return {};
  }

  const label = `DV360 line item ${lineItemId}`;
  const lineItem = await fetchDv360Object(client, `/advertisers/${advertiserId}/lineItems/${lineItemId}`, label);
  const scope: Dv360Scope = { object: lineItem };

  if (checkInsertionOrder) {
    scope.insertionOrderId = requiredOwnerId(lineItem, "insertionOrderId", label);
    assertEntityAllowed("DV360 insertion order", scope.insertionOrderId, config.allowedDv360InsertionOrderIds);
  }

  if (checkCampaign) {
    scope.campaignId = requiredOwnerId(lineItem, "campaignId", label);
    assertEntityAllowed("DV360 campaign", scope.campaignId, config.allowedDv360CampaignIds);
  }

  return scope;
}

async function verifyLineItemOwners(
  client: GoogleApiClient,
  config: ServerConfig,
  advertiserId: string,
  lineItemIds: readonly string[]
): Promise<void> {
  if (config.allowedDv360InsertionOrderIds.size === 0 && config.allowedDv360CampaignIds.size === 0) {
    return;
  }

  if (lineItemIds.length === 0) {
    throw new SafetyError(
      "Line item IDs are required when DV360 campaign or insertion order allowlists are configured, so each line item's owner can be checked."
    );
  }

  if (lineItemIds.length > maxVerifiedLineItems) {
    throw new SafetyError(
      `This request touches ${lineItemIds.length} line items. With DV360 campaign or insertion order allowlists configured, split it into batches of ${maxVerifiedLineItems} or fewer so each owner can be checked.`
    );
  }

  for (const lineItemId of lineItemIds) {
    await resolveLineItemOwners(client, config, advertiserId, lineItemId);
  }
}

async function resolveBulkLineItemScope(
  client: GoogleApiClient,
  config: ServerConfig,
  advertiserId: string,
  explicitLineItemIds: readonly string[] | undefined,
  request: unknown
): Promise<Dv360Scope> {
  const lineItemIds = [...new Set([...(explicitLineItemIds ?? []), ...collectLineItemIds(request)])];
  assertEntityIdsAllowed("DV360 line item", lineItemIds, config.allowedDv360LineItemIds, {
    requireWhenAllowlisted: true
  });
  assertEntityAllowed("DV360 advertiser", advertiserId, config.allowedDv360AdvertiserIds);
  const scope = await resolveDv360AdvertiserScope(client, config, advertiserId);
  await verifyLineItemOwners(client, config, advertiserId, lineItemIds);
  return { partnerId: scope.partnerId };
}

async function resolveCreateParents(
  client: GoogleApiClient,
  config: ServerConfig,
  resource: Dv360Resource,
  advertiserId: string,
  body: Record<string, unknown>
): Promise<Dv360Scope> {
  const campaignId = stringField(body, "campaignId");
  const insertionOrderId = stringField(body, "insertionOrderId");

  if (resource === "insertionOrders") {
    assertEntityIdsAllowed("DV360 campaign", campaignId ? [campaignId] : undefined, config.allowedDv360CampaignIds, {
      requireWhenAllowlisted: true
    });
    return { campaignId };
  }

  if (resource === "lineItems") {
    const parentAllowlisted =
      config.allowedDv360InsertionOrderIds.size > 0 || config.allowedDv360CampaignIds.size > 0;
    if (!insertionOrderId && parentAllowlisted) {
      throw new SafetyError(
        "lineItem.insertionOrderId is required when DV360 campaign or insertion order allowlists are configured."
      );
    }
    if (!insertionOrderId) {
      return { campaignId };
    }

    assertEntityAllowed("DV360 insertion order", insertionOrderId, config.allowedDv360InsertionOrderIds);
    const owner = await resolveInsertionOrderOwner(client, config, advertiserId, insertionOrderId);
    return { insertionOrderId, campaignId: owner.campaignId ?? campaignId };
  }

  return { campaignId, insertionOrderId };
}

async function fetchDv360Object(
  client: GoogleApiClient,
  path: string,
  label: string
): Promise<Record<string, unknown>> {
  const value = await client.request({ method: "GET", path });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SafetyError(`${label} response was not a JSON object, so its owner could not be checked.`);
  }
  return value as Record<string, unknown>;
}

function requiredOwnerId(object: Record<string, unknown>, field: string, label: string): string {
  const value = stringField(object, field);
  if (!value) {
    throw new SafetyError(`${label} did not expose ${field}, so its allowlist could not be checked.`);
  }
  return value;
}

function reportFileLocation(
  report: unknown,
  queryId: string,
  reportId: string
): { url: string; extension: string } {
  const metadata = objectField(report, "metadata");
  const status = objectField(metadata, "status");
  const url = metadata ? stringField(metadata, "googleCloudStoragePath") : undefined;

  if (!url) {
    const state = status ? stringField(status, "state") : undefined;
    throw new Error(
      `Bid Manager report ${reportId} for query ${queryId} has no file to download yet (state: ${state ?? "unknown"}). Poll bidmanager_get_report until the state is DONE.`
    );
  }

  const format = status ? stringField(status, "format") : undefined;
  const extension = format === "CSV" ? ".csv" : format === "XLSX" ? ".xlsx" : "";
  return { url, extension };
}

function objectField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === "object" && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : undefined;
}

// Google REST APIs also accept snake_case query names (partner_id for partnerId). A checked field
// must arrive under its exact name, or an alias could carry an ID past the check.
function assertNoQueryAliases(query: Record<string, unknown> | undefined, checkedFields: readonly string[]): void {
  const normalise = (name: string) => name.replace(/_/g, "").toLowerCase();
  for (const key of Object.keys(query ?? {})) {
    const field = checkedFields.find((checked) => key !== checked && normalise(key) === normalise(checked));
    if (field) {
      throw new SafetyError(`Pass ${field} under its exact name, not as query.${key}, so it can be checked.`);
    }
  }
}

function queryValues(value: unknown): string[] | undefined {
  const values = (Array.isArray(value) ? value : [value])
    .filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
    .map(String);
  return values.length > 0 ? values : undefined;
}

function allowlistEntity(
  idName: "campaignId" | "insertionOrderId" | "lineItemId" | undefined,
  id: string
): { campaignId?: string; insertionOrderId?: string; lineItemId?: string } {
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
  lineItemId: string;
}): string {
  const base = `/advertisers/${args.advertiserId}`;
  const suffix = `/targetingTypes/${args.targetingType}/assignedTargetingOptions`;
  return `${base}/lineItems/${args.lineItemId}${suffix}`;
}

function assignedTargetingListPath(args: {
  advertiserId: string;
  targetingType?: string;
  level: "advertiser" | "lineItem";
  lineItemId?: string;
}): string {
  const base = `/advertisers/${args.advertiserId}`;

  if (args.level === "advertiser") {
    return `${base}:listAssignedTargetingOptions`;
  }

  if (!args.targetingType) {
    throw new Error("targetingType is required for line item targeting lists.");
  }

  assertRequiredId("lineItemId", args.lineItemId);
  return `${base}/lineItems/${args.lineItemId}/targetingTypes/${args.targetingType}/assignedTargetingOptions`;
}

function assertRequiredId(name: string, value: string | undefined): asserts value is string {
  if (!value) {
    throw new Error(`${name} is required for this targeting level.`);
  }
}

// A list call can only be scoped by advertiser, so it is blocked while the resource itself or any of
// its parents has an allowlist.
function assertDv360BroadResourceListAllowed(
  config: ServerConfig,
  resource: Dv360Resource,
  singular: string
): void {
  const guardingAllowlists: Record<Dv360Resource, Array<Set<string>>> = {
    campaigns: [config.allowedDv360CampaignIds],
    insertionOrders: [config.allowedDv360CampaignIds, config.allowedDv360InsertionOrderIds],
    lineItems: [
      config.allowedDv360CampaignIds,
      config.allowedDv360InsertionOrderIds,
      config.allowedDv360LineItemIds
    ],
    creatives: []
  };

  for (const allowlist of guardingAllowlists[resource]) {
    assertBroadListAllowed(`DV360 ${singular}`, allowlist);
  }
}

function assertDv360CreateAllowed(
  config: ServerConfig,
  idAllowlistName: "campaignId" | "insertionOrderId" | "lineItemId" | undefined,
  resourceName: string
): void {
  const allowlist = idAllowlistName === "campaignId"
    ? config.allowedDv360CampaignIds
    : idAllowlistName === "insertionOrderId"
      ? config.allowedDv360InsertionOrderIds
      : idAllowlistName === "lineItemId"
        ? config.allowedDv360LineItemIds
        : new Set<string>();

  if (allowlist.size > 0) {
    throw new SafetyError(
      `Creating a new DV360 ${resourceName} is blocked while its ID allowlist is configured because the new ID is not known in advance.`
    );
  }
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
