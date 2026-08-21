import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { ServerConfig } from "./config.js";
import type { GoogleApiClient } from "./googleApiClient.js";
import { jsonResult } from "./response.js";
import { confirmSchema, dryRunSchema, idString, jsonObject, mutationControls, querySchema } from "./schemas.js";
import { assertAllowedEntities, assertBroadListAllowed, SafetyError } from "./safety.js";
import { runGuardedGoogleRequest, runRawGoogleRequest, safeRun } from "./toolHelpers.js";

interface Ga4ToolContext {
  adminClient: GoogleApiClient;
  adminAlphaClient: GoogleApiClient;
  dataClient: GoogleApiClient;
  config: ServerConfig;
}

const propertyInput = z.object({
  propertyId: idString
});

export function registerGa4Tools(server: McpServer, context: Ga4ToolContext): void {
  registerGa4ReadTools(server, context);
  registerGa4WriteTools(server, context);
  registerGa4RawTools(server, context);
}

function registerGa4ReadTools(server: McpServer, { adminClient, adminAlphaClient, dataClient, config }: Ga4ToolContext): void {
  server.registerTool(
    "ga4_list_account_summaries",
    {
      description: "List GA4 account summaries visible to the authenticated principal.",
      inputSchema: z.object({ query: querySchema })
    },
    async ({ query }) =>
      safeRun(async () => {
        assertBroadListAllowed("GA4 account summary", config.allowedGa4AccountIds);
        return jsonResult(await adminClient.request({ method: "GET", path: "/accountSummaries", query }));
      })
  );

  server.registerTool(
    "ga4_list_accounts",
    {
      description: "List GA4 accounts.",
      inputSchema: z.object({ query: querySchema })
    },
    async ({ query }) =>
      safeRun(async () => {
        assertBroadListAllowed("GA4 account", config.allowedGa4AccountIds);
        return jsonResult(await adminClient.request({ method: "GET", path: "/accounts", query }));
      })
  );

  server.registerTool(
    "ga4_get_account",
    {
      description: "Get one GA4 account.",
      inputSchema: z.object({ accountId: idString })
    },
    async ({ accountId }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "ga4", toolName: "ga4_get_account", ga4AccountId: accountId, request: { method: "GET", path: `/accounts/${accountId}` } });
        return jsonResult(await adminClient.request({ method: "GET", path: `/accounts/${accountId}` }));
      })
  );

  server.registerTool(
    "ga4_list_properties",
    {
      description: "List GA4 properties. Pass filter such as parent:accounts/123 when needed.",
      inputSchema: z.object({
        accountId: idString.optional(),
        filter: z.string().trim().min(1).optional(),
        query: querySchema
      })
    },
    async ({ accountId, filter, query }) =>
      safeRun(async () => {
        const resolvedFilter = ga4PropertyFilter(accountId, filter);
        assertAllowedEntities(config, { product: "ga4", toolName: "ga4_list_properties", ga4AccountId: accountId, request: { method: "GET", path: "/properties" } });
        if (!accountId) {
          assertBroadListAllowed("GA4 property", config.allowedGa4AccountIds);
        }
        assertBroadListAllowed("GA4 property", config.allowedGa4PropertyIds);
        return jsonResult(
          await adminClient.request({
            method: "GET",
            path: "/properties",
            query: {
              ...query,
              filter: resolvedFilter
            }
          })
        );
      })
  );

  server.registerTool(
    "ga4_get_property",
    {
      description: "Get one GA4 property.",
      inputSchema: propertyInput
    },
    async ({ propertyId }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "ga4", toolName: "ga4_get_property", ga4PropertyId: propertyId, request: { method: "GET", path: `/properties/${propertyId}` } });
        return jsonResult(await adminClient.request({ method: "GET", path: `/properties/${propertyId}` }));
      })
  );

  registerPropertyResource(server, { adminClient, config }, {
    listTool: "ga4_list_data_streams",
    getTool: "ga4_get_data_stream",
    resource: "dataStreams",
    idName: "dataStreamId",
    singular: "data stream"
  });

  registerPropertyResource(server, { adminClient, config }, {
    listTool: "ga4_list_custom_dimensions",
    getTool: "ga4_get_custom_dimension",
    resource: "customDimensions",
    idName: "customDimensionId",
    singular: "custom dimension"
  });

  registerPropertyResource(server, { adminClient, config }, {
    listTool: "ga4_list_custom_metrics",
    getTool: "ga4_get_custom_metric",
    resource: "customMetrics",
    idName: "customMetricId",
    singular: "custom metric"
  });

  registerPropertyResource(server, { adminClient, config }, {
    listTool: "ga4_list_key_events",
    getTool: "ga4_get_key_event",
    resource: "keyEvents",
    idName: "keyEventId",
    singular: "key event"
  });

  registerPropertyResource(server, { adminClient, config }, {
    listTool: "ga4_list_conversion_events",
    getTool: "ga4_get_conversion_event",
    resource: "conversionEvents",
    idName: "conversionEventId",
    singular: "conversion event",
    deprecatedAlternative: "Use GA4 key event tools for new integrations."
  });

  registerPropertyResource(server, { adminClient: adminAlphaClient, config }, {
    listTool: "ga4_list_audiences",
    getTool: "ga4_get_audience",
    resource: "audiences",
    idName: "audienceId",
    singular: "audience"
  });

  server.registerTool(
    "ga4_get_metadata",
    {
      description: "Get GA4 Data API metadata for a property.",
      inputSchema: propertyInput
    },
    async ({ propertyId }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "ga4", toolName: "ga4_get_metadata", ga4PropertyId: propertyId, request: { method: "GET", path: `/properties/${propertyId}/metadata` } });
        return jsonResult(await dataClient.request({ method: "GET", path: `/properties/${propertyId}/metadata` }));
      })
  );

  server.registerTool(
    "ga4_run_report",
    {
      description: "Run a GA4 Data API report for one property.",
      inputSchema: z.object({
        propertyId: idString,
        request: jsonObject
      })
    },
    async ({ propertyId, request }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "ga4", toolName: "ga4_run_report", ga4PropertyId: propertyId, request: { method: "POST", path: `/properties/${propertyId}:runReport` } });
        return jsonResult(await dataClient.request({ method: "POST", path: `/properties/${propertyId}:runReport`, body: request }));
      })
  );

  server.registerTool(
    "ga4_batch_run_reports",
    {
      description: "Run multiple GA4 Data API reports for one property.",
      inputSchema: z.object({
        propertyId: idString,
        request: jsonObject
      })
    },
    async ({ propertyId, request }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "ga4", toolName: "ga4_batch_run_reports", ga4PropertyId: propertyId, request: { method: "POST", path: `/properties/${propertyId}:batchRunReports` } });
        return jsonResult(await dataClient.request({ method: "POST", path: `/properties/${propertyId}:batchRunReports`, body: request }));
      })
  );

  server.registerTool(
    "ga4_run_realtime_report",
    {
      description: "Run a GA4 realtime report for one property.",
      inputSchema: z.object({
        propertyId: idString,
        request: jsonObject
      })
    },
    async ({ propertyId, request }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "ga4", toolName: "ga4_run_realtime_report", ga4PropertyId: propertyId, request: { method: "POST", path: `/properties/${propertyId}:runRealtimeReport` } });
        return jsonResult(await dataClient.request({ method: "POST", path: `/properties/${propertyId}:runRealtimeReport`, body: request }));
      })
  );
}

function registerGa4WriteTools(server: McpServer, { adminClient, adminAlphaClient, config }: Ga4ToolContext): void {
  server.registerTool(
    "ga4_patch_property",
    {
      description: "Patch selected fields on a GA4 property.",
      inputSchema: z.object({
        propertyId: idString,
        patch: jsonObject,
        updateMask: z.string().min(1),
        ...mutationControls
      })
    },
    async ({ propertyId, patch, updateMask, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client: adminClient,
        config,
        product: "ga4",
        toolName: "ga4_patch_property",
        ga4PropertyId: propertyId,
        dryRun,
        confirm,
        request: {
          method: "PATCH",
          path: `/properties/${propertyId}`,
          query: { updateMask },
          body: patch
        }
      })
  );

  registerPropertyCreatePatch(server, { adminClient, config }, {
    createTool: "ga4_create_data_stream",
    patchTool: "ga4_patch_data_stream",
    resource: "dataStreams",
    bodyName: "dataStream",
    idName: "dataStreamId"
  });

  registerPropertyCreatePatch(server, { adminClient, config }, {
    createTool: "ga4_create_custom_dimension",
    patchTool: "ga4_patch_custom_dimension",
    resource: "customDimensions",
    bodyName: "customDimension",
    idName: "customDimensionId"
  });

  registerPropertyCreatePatch(server, { adminClient, config }, {
    createTool: "ga4_create_custom_metric",
    patchTool: "ga4_patch_custom_metric",
    resource: "customMetrics",
    bodyName: "customMetric",
    idName: "customMetricId"
  });

  registerPropertyCreatePatch(server, { adminClient, config }, {
    createTool: "ga4_create_key_event",
    patchTool: "ga4_patch_key_event",
    resource: "keyEvents",
    bodyName: "keyEvent",
    idName: "keyEventId"
  });

  registerPropertyCreatePatch(server, { adminClient, config }, {
    createTool: "ga4_create_conversion_event",
    patchTool: "ga4_patch_conversion_event",
    resource: "conversionEvents",
    bodyName: "conversionEvent",
    idName: "conversionEventId",
    deprecatedAlternative: "Use GA4 key event tools for new integrations."
  });

  registerPropertyCreatePatch(server, { adminClient: adminAlphaClient, config }, {
    createTool: "ga4_create_audience",
    patchTool: "ga4_patch_audience",
    resource: "audiences",
    bodyName: "audience",
    idName: "audienceId"
  });

  server.registerTool(
    "ga4_archive_custom_dimension",
    {
      description: "Archive a GA4 custom dimension. This is destructive and requires live write confirmation.",
      inputSchema: z.object({
        propertyId: idString,
        customDimensionId: idString,
        ...mutationControls
      })
    },
    async ({ propertyId, customDimensionId, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client: adminClient,
        config,
        product: "ga4",
        toolName: "ga4_archive_custom_dimension",
        ga4PropertyId: propertyId,
        dryRun,
        confirm,
        request: {
          method: "POST",
          path: `/properties/${propertyId}/customDimensions/${customDimensionId}:archive`,
          body: {}
        }
      })
  );

  server.registerTool(
    "ga4_archive_custom_metric",
    {
      description: "Archive a GA4 custom metric. This is destructive and requires live write confirmation.",
      inputSchema: z.object({
        propertyId: idString,
        customMetricId: idString,
        ...mutationControls
      })
    },
    async ({ propertyId, customMetricId, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client: adminClient,
        config,
        product: "ga4",
        toolName: "ga4_archive_custom_metric",
        ga4PropertyId: propertyId,
        dryRun,
        confirm,
        request: {
          method: "POST",
          path: `/properties/${propertyId}/customMetrics/${customMetricId}:archive`,
          body: {}
        }
      })
  );
}

function registerGa4RawTools(server: McpServer, { adminClient, dataClient, config }: Ga4ToolContext): void {
  const rawInput = z.object({
    method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
    surface: z.enum(["admin", "data"]).default("admin"),
    path: z.string().min(1),
    query: querySchema,
    body: z.unknown().optional(),
    accountId: idString.optional(),
    propertyId: idString.optional(),
    dryRun: dryRunSchema,
    confirm: confirmSchema
  });

  server.registerTool(
    "ga4_api_request",
    {
      description: "Advanced GA4 Admin or Data API request. Disabled unless GA4_ENABLE_RAW_REQUEST or GMP_ENABLE_RAW_REQUEST is true.",
      inputSchema: rawInput
    },
    async ({ method, surface, path, query, body, accountId, propertyId, dryRun, confirm }) =>
      runRawGoogleRequest({
        client: surface === "data" ? dataClient : adminClient,
        config,
        product: "ga4",
        toolName: "ga4_api_request",
        ga4AccountId: accountId,
        ga4PropertyId: propertyId,
        dryRun,
        confirm,
        request: { method, path, query, body }
      })
  );
}

function ga4PropertyFilter(
  accountId: string | undefined,
  filter: string | undefined
): string {
  if (!accountId && !filter) {
    throw new SafetyError("ga4_list_properties requires accountId or an explicit filter.");
  }

  if (!accountId) {
    return filter as string;
  }

  const allowedFilters = new Set([
    `parent:accounts/${accountId}`,
    `ancestor:accounts/${accountId}`
  ]);
  if (filter && !allowedFilters.has(filter)) {
    throw new SafetyError(
      `GA4 property filter must target the declared account ${accountId}.`
    );
  }

  return filter ?? `parent:accounts/${accountId}`;
}

function registerPropertyResource(
  server: McpServer,
  { adminClient, config }: { adminClient: GoogleApiClient; config: ServerConfig },
  options: {
    listTool: string;
    getTool: string;
    resource: string;
    idName: string;
    singular: string;
    deprecatedAlternative?: string;
  }
): void {
  server.registerTool(
    options.listTool,
    {
      description: `List GA4 ${options.singular}s for a property.${deprecatedGuidance(options.deprecatedAlternative)}`,
      inputSchema: z.object({
        propertyId: idString,
        query: querySchema
      })
    },
    async ({ propertyId, query }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "ga4", toolName: options.listTool, ga4PropertyId: propertyId, request: { method: "GET", path: `/properties/${propertyId}/${options.resource}` } });
        return jsonResult(await adminClient.request({ method: "GET", path: `/properties/${propertyId}/${options.resource}`, query }));
      })
  );

  server.registerTool(
    options.getTool,
    {
      description: `Get one GA4 ${options.singular}.${deprecatedGuidance(options.deprecatedAlternative)}`,
      inputSchema: z.object({
        propertyId: idString,
        [options.idName]: idString
      })
    },
    async (input) => {
      const indexedInput = input as Record<string, unknown> & typeof input;
      const propertyId = input.propertyId;
      const resourceId = String(indexedInput[options.idName]);
      return safeRun(async () => {
        assertAllowedEntities(config, { product: "ga4", toolName: options.getTool, ga4PropertyId: propertyId, request: { method: "GET", path: `/properties/${propertyId}/${options.resource}/${resourceId}` } });
        return jsonResult(await adminClient.request({ method: "GET", path: `/properties/${propertyId}/${options.resource}/${resourceId}` }));
      });
    }
  );
}

function registerPropertyCreatePatch(
  server: McpServer,
  { adminClient, config }: { adminClient: GoogleApiClient; config: ServerConfig },
  options: {
    createTool: string;
    patchTool: string;
    resource: string;
    bodyName: string;
    idName: string;
    deprecatedAlternative?: string;
  }
): void {
  server.registerTool(
    options.createTool,
    {
      description: `Create a GA4 ${options.bodyName}.${deprecatedGuidance(options.deprecatedAlternative)}`,
      inputSchema: z.object({
        propertyId: idString,
        resource: jsonObject,
        ...mutationControls
      })
    },
    async ({ propertyId, resource, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client: adminClient,
        config,
        product: "ga4",
        toolName: options.createTool,
        ga4PropertyId: propertyId,
        dryRun,
        confirm,
        request: {
          method: "POST",
          path: `/properties/${propertyId}/${options.resource}`,
          body: resource
        }
      })
  );

  server.registerTool(
    options.patchTool,
    {
      description: `Patch selected fields on a GA4 ${options.bodyName}.${deprecatedGuidance(options.deprecatedAlternative)}`,
      inputSchema: z.object({
        propertyId: idString,
        [options.idName]: idString,
        patch: jsonObject,
        updateMask: z.string().min(1),
        ...mutationControls
      })
    },
    async (input) => {
      const indexedInput = input as Record<string, unknown> & typeof input;
      const propertyId = input.propertyId;
      const resourceId = String(indexedInput[options.idName]);
      return runGuardedGoogleRequest({
        client: adminClient,
        config,
        product: "ga4",
        toolName: options.patchTool,
        ga4PropertyId: propertyId,
        dryRun: input.dryRun,
        confirm: input.confirm,
        request: {
          method: "PATCH",
          path: `/properties/${propertyId}/${options.resource}/${resourceId}`,
          query: { updateMask: input.updateMask },
          body: input.patch
        }
      });
    }
  );
}

function deprecatedGuidance(alternative: string | undefined): string {
  return alternative ? ` Deprecated Google API compatibility only. ${alternative}` : "";
}
