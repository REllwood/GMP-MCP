import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { ServerConfig } from "./config.js";
import type { GoogleApiClient } from "./googleApiClient.js";
import { jsonResult } from "./response.js";
import { confirmSchema, dryRunSchema, idString, jsonObject, mutationControls, querySchema } from "./schemas.js";
import { assertAllowedEntities } from "./safety.js";
import { runGuardedGoogleRequest, runRawGoogleRequest, safeRun } from "./toolHelpers.js";

interface Sa360ToolContext {
  reportingClient: GoogleApiClient;
  legacyClient: GoogleApiClient;
  config: ServerConfig;
}

export function registerSa360Tools(server: McpServer, context: Sa360ToolContext): void {
  registerSa360ReportingTools(server, context);
  registerSa360ConversionTools(server, context);
  registerSa360RawTools(server, context);
}

function registerSa360ReportingTools(server: McpServer, { reportingClient, config }: Sa360ToolContext): void {
  server.registerTool(
    "sa360_search",
    {
      description: "Run a Search Ads 360 Reporting API Search Ads 360 Query Language request.",
      inputSchema: z.object({
        customerId: idString,
        request: jsonObject
      })
    },
    async ({ customerId, request }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "sa360", toolName: "sa360_search", sa360CustomerId: customerId, request: { method: "POST", path: `/customers/${customerId}/searchAds360:search` } });
        return jsonResult(
          await reportingClient.request({
            method: "POST",
            path: `/customers/${customerId}/searchAds360:search`,
            body: request
          })
        );
      })
  );

  server.registerTool(
    "sa360_search_stream",
    {
      description: "Run a streaming Search Ads 360 Reporting API query. The REST response is returned as JSON chunks from Google.",
      inputSchema: z.object({
        customerId: idString,
        request: jsonObject
      })
    },
    async ({ customerId, request }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "sa360", toolName: "sa360_search_stream", sa360CustomerId: customerId, request: { method: "POST", path: `/customers/${customerId}/searchAds360:searchStream` } });
        return jsonResult(
          await reportingClient.request({
            method: "POST",
            path: `/customers/${customerId}/searchAds360:searchStream`,
            body: request
          })
        );
      })
  );

  server.registerTool(
    "sa360_search_fields",
    {
      description: "Search Search Ads 360 reporting fields and metadata.",
      inputSchema: z.object({
        request: jsonObject
      })
    },
    async ({ request }) =>
      safeRun(async () =>
        jsonResult(
          await reportingClient.request({
            method: "POST",
            path: "/searchAds360Fields:search",
            body: request
          })
        )
      )
  );

  server.registerTool(
    "sa360_get_field",
    {
      description: "Get one Search Ads 360 reporting field metadata record.",
      inputSchema: z.object({
        resourceName: z.string().min(1).describe("For example searchAds360Fields/campaign.name.")
      })
    },
    async ({ resourceName }) =>
      safeRun(async () =>
        jsonResult(
          await reportingClient.request({
            method: "GET",
            path: `/${resourceName}`
          })
        )
      )
  );

  server.registerTool(
    "sa360_list_custom_columns",
    {
      description: "List custom columns for a Search Ads 360 customer.",
      inputSchema: z.object({
        customerId: idString,
        query: querySchema
      })
    },
    async ({ customerId, query }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "sa360", toolName: "sa360_list_custom_columns", sa360CustomerId: customerId, request: { method: "GET", path: `/customers/${customerId}/customColumns` } });
        return jsonResult(
          await reportingClient.request({
            method: "GET",
            path: `/customers/${customerId}/customColumns`,
            query
          })
        );
      })
  );

  server.registerTool(
    "sa360_get_custom_column",
    {
      description: "Get one custom column for a Search Ads 360 customer.",
      inputSchema: z.object({
        customerId: idString,
        customColumnId: idString
      })
    },
    async ({ customerId, customColumnId }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "sa360", toolName: "sa360_get_custom_column", sa360CustomerId: customerId, request: { method: "GET", path: `/customers/${customerId}/customColumns/${customColumnId}` } });
        return jsonResult(
          await reportingClient.request({
            method: "GET",
            path: `/customers/${customerId}/customColumns/${customColumnId}`
          })
        );
      })
  );
}

function registerSa360ConversionTools(server: McpServer, { legacyClient, config }: Sa360ToolContext): void {
  server.registerTool(
    "sa360_get_conversions_by_customer",
    {
      description: "DEPRECATED (Q3 2025): Google is deprecating the legacy Search Ads 360 Conversion API getByCustomerId read. Prefer reading conversions via sa360_search on the new Reporting API. This still retrieves conversions from the legacy Conversion API by SA360 customer ID, but should not be relied on long term.",
      inputSchema: z.object({
        customerId: idString,
        query: querySchema
      })
    },
    async ({ customerId, query }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "sa360", toolName: "sa360_get_conversions_by_customer", sa360CustomerId: customerId, request: { method: "GET", path: `/customer/${customerId}/conversion` } });
        return jsonResult(await legacyClient.request({ method: "GET", path: `/customer/${customerId}/conversion`, query }));
      })
  );

  server.registerTool(
    "sa360_insert_conversions",
    {
      description: "Insert offline or online conversions through the legacy Search Ads 360 Conversion API.",
      inputSchema: z.object({
        customerId: idString.describe("SA360 customer ID used for allowlist checks and audit attribution."),
        request: jsonObject,
        ...mutationControls
      })
    },
    async ({ customerId, request, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client: legacyClient,
        config,
        product: "sa360",
        toolName: "sa360_insert_conversions",
        sa360CustomerId: customerId,
        dryRun,
        confirm,
        request: {
          method: "POST",
          path: "/conversion",
          body: request
        }
      })
  );

  server.registerTool(
    "sa360_update_conversions",
    {
      description: "Update conversions through the legacy Search Ads 360 Conversion API.",
      inputSchema: z.object({
        customerId: idString.describe("SA360 customer ID used for allowlist checks and audit attribution."),
        request: jsonObject,
        ...mutationControls
      })
    },
    async ({ customerId, request, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client: legacyClient,
        config,
        product: "sa360",
        toolName: "sa360_update_conversions",
        sa360CustomerId: customerId,
        dryRun,
        confirm,
        request: {
          method: "PUT",
          path: "/conversion",
          body: request
        }
      })
  );
}

function registerSa360RawTools(server: McpServer, { reportingClient, legacyClient, config }: Sa360ToolContext): void {
  server.registerTool(
    "sa360_api_request",
    {
      description: "Advanced SA360 Reporting or legacy Conversion API request. Disabled unless SA360_ENABLE_RAW_REQUEST or GMP_ENABLE_RAW_REQUEST is true.",
      inputSchema: z.object({
        method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
        surface: z.enum(["reporting", "legacyConversion"]).default("reporting"),
        path: z.string().min(1),
        query: querySchema,
        body: z.unknown().optional(),
        customerId: idString.optional(),
        dryRun: dryRunSchema,
        confirm: confirmSchema
      })
    },
    async ({ method, surface, path, query, body, customerId, dryRun, confirm }) =>
      runRawGoogleRequest({
        client: surface === "legacyConversion" ? legacyClient : reportingClient,
        config,
        product: "sa360",
        toolName: "sa360_api_request",
        sa360CustomerId: customerId,
        dryRun,
        confirm,
        request: { method, path, query, body }
      })
  );
}
