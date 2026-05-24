import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { Cm360Client, type HttpMethod, type QueryParams } from "./cm360Client.js";
import type { ServerConfig } from "./config.js";
import { errorResult, jsonResult } from "./response.js";
import {
  confirmSchema,
  dryRunSchema,
  getInput,
  idString,
  jsonObject,
  listInput,
  mutationControls,
  profileInput,
  querySchema
} from "./schemas.js";
import {
  assertRawRequestAllowedEntities,
  auditMutation,
  assertBroadListAllowed,
  assertEntityAllowed,
  assertEntityIdsAllowed,
  guardMutation
} from "./safety.js";

interface ToolContext {
  client: Cm360Client;
  config: ServerConfig;
}

export function registerCm360Tools(server: McpServer, context: ToolContext): void {
  registerReadTools(server, context);
  registerWriteTools(server, context);
  registerRawRequestTool(server, context);
}

function registerReadTools(server: McpServer, { client, config }: ToolContext): void {
  server.registerTool(
    "cm360_list_user_profiles",
    {
      description: "List CM360 user profiles available to the authenticated Google principal.",
      inputSchema: z.object({})
    },
    async () =>
      safeRun(async () => {
        assertBroadListAllowed("CM360 user profile", config.allowedProfileIds);
        return jsonResult(await client.request({ method: "GET", path: "/userprofiles" }));
      })
  );

  server.registerTool(
    "cm360_get_user_profile",
    {
      description: "Get one CM360 user profile.",
      inputSchema: profileInput
    },
    async ({ profileId }) =>
      safeRun(async () => {
        assertEntityAllowed("profile", profileId, config.allowedProfileIds);
        return jsonResult(await client.request({ method: "GET", path: `/userprofiles/${profileId}` }));
      })
  );

  registerListAndGet(server, { client, config }, {
    listTool: "cm360_list_advertisers",
    getTool: "cm360_get_advertiser",
    resource: "advertisers",
    descriptionName: "advertisers",
    singularDescriptionName: "advertiser",
    idAllowlist: config.allowedAdvertiserIds
  });

  registerListAndGet(server, { client, config }, {
    listTool: "cm360_list_campaigns",
    getTool: "cm360_get_campaign",
    resource: "campaigns",
    descriptionName: "campaigns",
    singularDescriptionName: "campaign",
    idAllowlist: config.allowedCampaignIds,
    advertiserScoped: true
  });

  registerListAndGet(server, { client, config }, {
    listTool: "cm360_list_placements",
    getTool: "cm360_get_placement",
    resource: "placements",
    descriptionName: "placements",
    singularDescriptionName: "placement",
    advertiserScoped: true
  });

  registerListAndGet(server, { client, config }, {
    listTool: "cm360_list_ads",
    getTool: "cm360_get_ad",
    resource: "ads",
    descriptionName: "ads",
    singularDescriptionName: "ad",
    advertiserScoped: true
  });

  registerListAndGet(server, { client, config }, {
    listTool: "cm360_list_creatives",
    getTool: "cm360_get_creative",
    resource: "creatives",
    descriptionName: "creatives",
    singularDescriptionName: "creative",
    advertiserScoped: true
  });

  registerListAndGet(server, { client, config }, {
    listTool: "cm360_list_floodlight_activities",
    getTool: "cm360_get_floodlight_activity",
    resource: "floodlightActivities",
    descriptionName: "Floodlight activities",
    singularDescriptionName: "Floodlight activity",
    advertiserScoped: true
  });

  registerListAndGet(server, { client, config }, {
    listTool: "cm360_list_sites",
    getTool: "cm360_get_site",
    resource: "sites",
    descriptionName: "sites",
    singularDescriptionName: "site"
  });

  server.registerTool(
    "cm360_list_reports",
    {
      description: "List CM360 reports.",
      inputSchema: listInput.extend({ advertiserId: idString.optional() })
    },
    async ({ profileId, advertiserId, query }) =>
      safeRun(async () => {
        assertEntityAllowed("profile", profileId, config.allowedProfileIds);
        assertRequiredEntityAllowed("advertiser", advertiserId, config.allowedAdvertiserIds);
        return jsonResult(
          await client.request({
            method: "GET",
            path: `/userprofiles/${profileId}/reports`,
            query
          })
        );
      })
  );

  server.registerTool(
    "cm360_get_report",
    {
      description: "Get one CM360 report definition.",
      inputSchema: getInput.extend({ advertiserId: idString.optional() })
    },
    async ({ profileId, advertiserId, id }) =>
      safeRun(async () => {
        assertEntityAllowed("profile", profileId, config.allowedProfileIds);
        assertRequiredEntityAllowed("advertiser", advertiserId, config.allowedAdvertiserIds);
        return jsonResult(
          await client.request({
            method: "GET",
            path: `/userprofiles/${profileId}/reports/${id}`
          })
        );
      })
  );

  server.registerTool(
    "cm360_list_report_files",
    {
      description: "List files generated by a CM360 report.",
      inputSchema: z.object({
        profileId: idString,
        advertiserId: idString.optional(),
        reportId: idString,
        query: querySchema
      })
    },
    async ({ profileId, advertiserId, reportId, query }) =>
      safeRun(async () => {
        assertEntityAllowed("profile", profileId, config.allowedProfileIds);
        assertRequiredEntityAllowed("advertiser", advertiserId, config.allowedAdvertiserIds);
        return jsonResult(
          await client.request({
            method: "GET",
            path: `/userprofiles/${profileId}/reports/${reportId}/files`,
            query
          })
        );
      })
  );

  server.registerTool(
    "cm360_get_report_file_status",
    {
      description: "Get a CM360 report file metadata record and processing status.",
      inputSchema: z.object({
        profileId: idString,
        advertiserId: idString.optional(),
        reportId: idString,
        fileId: idString
      })
    },
    async ({ profileId, advertiserId, reportId, fileId }) =>
      safeRun(async () => {
        assertEntityAllowed("profile", profileId, config.allowedProfileIds);
        assertRequiredEntityAllowed("advertiser", advertiserId, config.allowedAdvertiserIds);
        return jsonResult(
          await client.request({
            method: "GET",
            path: `/userprofiles/${profileId}/reports/${reportId}/files/${fileId}`
          })
        );
      })
  );
}

function registerWriteTools(server: McpServer, context: ToolContext): void {
  const { client, config } = context;

  registerCreateTool(server, context, {
    toolName: "cm360_create_campaign",
    resource: "campaigns",
    description: "Create a CM360 campaign. Live execution requires dryRun=false, confirm=true and CM360_ENABLE_WRITES=true.",
    advertiserIdFromBody: true
  });

  registerPatchTool(server, context, {
    toolName: "cm360_patch_campaign",
    resource: "campaigns",
    description: "Patch selected fields on a CM360 campaign.",
    campaignIdFromId: true,
    advertiserScoped: true
  });

  registerCreateTool(server, context, {
    toolName: "cm360_create_placement",
    resource: "placements",
    description: "Create a CM360 placement.",
    advertiserIdFromBody: true,
    campaignIdFromBody: true
  });

  registerPatchTool(server, context, {
    toolName: "cm360_patch_placement",
    resource: "placements",
    description: "Patch selected fields on a CM360 placement.",
    campaignIdFromBody: true,
    advertiserScoped: true
  });

  registerCreateTool(server, context, {
    toolName: "cm360_create_ad",
    resource: "ads",
    description: "Create a CM360 ad.",
    advertiserIdFromBody: true,
    campaignIdFromBody: true
  });

  registerPatchTool(server, context, {
    toolName: "cm360_patch_ad",
    resource: "ads",
    description: "Patch selected fields on a CM360 ad.",
    campaignIdFromBody: true,
    advertiserScoped: true
  });

  registerCreateTool(server, context, {
    toolName: "cm360_create_creative",
    resource: "creatives",
    description: "Create a CM360 creative JSON resource. Asset uploads should use the relevant CM360 asset endpoint.",
    advertiserIdFromBody: true
  });

  registerPatchTool(server, context, {
    toolName: "cm360_patch_creative",
    resource: "creatives",
    description: "Patch selected fields on a CM360 creative.",
    advertiserScoped: true
  });

  registerCreateTool(server, context, {
    toolName: "cm360_create_floodlight_activity",
    resource: "floodlightActivities",
    description: "Create a CM360 Floodlight activity.",
    advertiserIdFromBody: true
  });

  registerPatchTool(server, context, {
    toolName: "cm360_patch_floodlight_activity",
    resource: "floodlightActivities",
    description: "Patch selected fields on a CM360 Floodlight activity.",
    advertiserScoped: true
  });

  server.registerTool(
    "cm360_associate_creative_to_campaign",
    {
      description:
        "Associate a creative with a CM360 campaign. CM360 may create a matching default ad if needed.",
      inputSchema: z.object({
        profileId: idString,
        advertiserId: idString.optional(),
        campaignId: idString,
        association: jsonObject,
        ...mutationControls
      })
    },
    async ({ profileId, advertiserId, campaignId, association, dryRun, confirm }) =>
      safeRun(async () => {
        assertRequiredEntityAllowed("advertiser", advertiserId, config.allowedAdvertiserIds);
        const request = {
          method: "POST" as const,
          path: `/userprofiles/${profileId}/campaigns/${campaignId}/campaignCreativeAssociations`,
          body: association
        };
        const guard = await guardMutation(config, {
          toolName: "cm360_associate_creative_to_campaign",
          profileId,
          advertiserId,
          campaignId,
          dryRun,
          confirm,
          request
        });

        if (guard.dryRun) {
          return jsonResult(guard.preview);
        }

        const result = await client.request(request);
        await auditMutation(config, {
          toolName: "cm360_associate_creative_to_campaign",
          profileId,
          advertiserId,
          campaignId,
          request
        }, "live_completed");
        return jsonResult(result);
      })
  );

  server.registerTool(
    "cm360_generate_placement_tags",
    {
      description:
        "Generate CM360 placement tags for a campaign and optional placement IDs. This does not create trafficking objects.",
      inputSchema: z.object({
        profileId: idString,
        advertiserId: idString.optional(),
        campaignId: idString,
        placementIds: z.array(idString).optional(),
        tagFormats: z.array(z.string()).optional(),
        tagProperties: z.record(z.string(), z.unknown()).optional()
      })
    },
    async ({ profileId, advertiserId, campaignId, placementIds, tagFormats, tagProperties }) =>
      safeRun(async () => {
        assertEntityAllowed("profile", profileId, config.allowedProfileIds);
        assertRequiredEntityAllowed("advertiser", advertiserId, config.allowedAdvertiserIds);
        assertEntityAllowed("campaign", campaignId, config.allowedCampaignIds);
        return jsonResult(
          await client.request({
            method: "POST",
            path: `/userprofiles/${profileId}/placements/generatetags`,
            query: {
              campaignId,
              "placementIds[]": placementIds,
              "tagFormats[]": tagFormats,
              tagProperties: tagProperties ? JSON.stringify(tagProperties) : undefined
            }
          })
        );
      })
  );

  server.registerTool(
    "cm360_create_report",
    {
      description: "Create a CM360 report definition.",
      inputSchema: z.object({
        profileId: idString,
        advertiserId: idString.optional(),
        report: jsonObject,
        ...mutationControls
      })
    },
    async ({ profileId, advertiserId, report, dryRun, confirm }) =>
      safeRun(async () => {
        assertRequiredEntityAllowed("advertiser", advertiserId, config.allowedAdvertiserIds);
        return runGuardedRequest({
          client,
          config,
          toolName: "cm360_create_report",
          profileId,
          advertiserId,
          dryRun,
          confirm,
          request: {
            method: "POST",
            path: `/userprofiles/${profileId}/reports`,
            body: report
          }
        });
      })
  );

  server.registerTool(
    "cm360_run_report",
    {
      description: "Run a CM360 report. Returns a file resource that can be polled until REPORT_AVAILABLE.",
      inputSchema: z.object({
        profileId: idString,
        advertiserId: idString.optional(),
        reportId: idString,
        synchronous: z.boolean().optional().default(false)
      })
    },
    async ({ profileId, advertiserId, reportId, synchronous }) =>
      safeRun(async () => {
        assertEntityAllowed("profile", profileId, config.allowedProfileIds);
        assertRequiredEntityAllowed("advertiser", advertiserId, config.allowedAdvertiserIds);
        return jsonResult(
          await client.request({
            method: "POST",
            path: `/userprofiles/${profileId}/reports/${reportId}/run`,
            query: { synchronous }
          })
        );
      })
  );

  server.registerTool(
    "cm360_download_report_file",
    {
      description:
        "Download an available CM360 report file to the configured local download directory and return a small text preview.",
      inputSchema: z.object({
        profileId: idString,
        advertiserId: idString.optional(),
        reportId: idString,
        fileId: idString,
        fileName: z.string().optional(),
        maxPreviewBytes: z.number().int().positive().max(65536).optional().default(4096)
      })
    },
    async ({ profileId, advertiserId, reportId, fileId, fileName, maxPreviewBytes }) =>
      safeRun(async () => {
        assertEntityAllowed("profile", profileId, config.allowedProfileIds);
        assertRequiredEntityAllowed("advertiser", advertiserId, config.allowedAdvertiserIds);
        return jsonResult(
          await client.downloadReportFile({
            profileId,
            reportId,
            fileId,
            fileName,
            maxPreviewBytes
          })
        );
      })
  );

  server.registerTool(
    "cm360_upload_offline_conversions",
    {
      description:
        "Insert CM360 offline conversions using the conversions.batchinsert endpoint.",
      inputSchema: z.object({
        profileId: idString,
        advertiserId: idString.optional(),
        request: jsonObject,
        ...mutationControls
      })
    },
    async ({ profileId, advertiserId, request, dryRun, confirm }) =>
      safeRun(async () => {
        assertRequiredEntityAllowed("advertiser", advertiserId, config.allowedAdvertiserIds);
        return runGuardedRequest({
          client,
          config,
          toolName: "cm360_upload_offline_conversions",
          profileId,
          advertiserId,
          dryRun,
          confirm,
          request: {
            method: "POST",
            path: `/userprofiles/${profileId}/conversions/batchinsert`,
            body: request
          }
        });
      })
  );
}

function registerRawRequestTool(server: McpServer, { client, config }: ToolContext): void {
  server.registerTool(
    "cm360_api_request",
    {
      description:
        "Advanced CM360 v5 API request escape hatch. Disabled unless CM360_ENABLE_RAW_REQUEST=true. Prefer first-class tools where possible.",
      inputSchema: z.object({
        method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
        path: z.string().min(1).describe("CM360 v5 path, for example /userprofiles/{profileId}/campaigns."),
        query: querySchema,
        body: z.unknown().optional(),
        profileId: idString.optional(),
        advertiserId: idString.optional(),
        campaignId: idString.optional(),
        dryRun: dryRunSchema,
        confirm: confirmSchema
      })
    },
    async ({ method, path, query, body, profileId, advertiserId, campaignId, dryRun, confirm }) =>
      safeRun(async () => {
        if (!config.rawRequestEnabled) {
          throw new Error("Raw CM360 requests are disabled. Set CM360_ENABLE_RAW_REQUEST=true to enable this tool.");
        }

        const request = { method, path, query, body };

        assertRawRequestAllowedEntities(config, {
          toolName: "cm360_api_request",
          profileId,
          advertiserId,
          campaignId,
          request
        });

        if (method === "GET") {
          return jsonResult(await client.request(request));
        }

        return runGuardedRequest({
          client,
          config,
          toolName: "cm360_api_request",
          profileId,
          advertiserId,
          campaignId,
          dryRun,
          confirm,
          request
        });
      })
  );
}

function registerListAndGet(
  server: McpServer,
  { client, config }: ToolContext,
  options: {
    listTool: string;
    getTool: string;
    resource: string;
    descriptionName: string;
    singularDescriptionName: string;
    idAllowlist?: Set<string>;
    advertiserScoped?: boolean;
  }
): void {
  server.registerTool(
    options.listTool,
    {
      description: `List CM360 ${options.descriptionName}.`,
      inputSchema: listInput
    },
    async ({ profileId, query }) =>
      safeRun(async () => {
        assertEntityAllowed("profile", profileId, config.allowedProfileIds);
        if (options.advertiserScoped) {
          assertBroadListAllowed(options.singularDescriptionName, config.allowedAdvertiserIds);
        }
        assertBroadListAllowed(options.singularDescriptionName, options.idAllowlist ?? new Set());
        return jsonResult(
          await client.request({
            method: "GET",
            path: `/userprofiles/${profileId}/${options.resource}`,
            query
          })
        );
      })
  );

  server.registerTool(
    options.getTool,
    {
      description: `Get one CM360 ${options.singularDescriptionName}.`,
      inputSchema: options.advertiserScoped
        ? getInput.extend({ advertiserId: idString.optional() })
        : getInput
    },
    async (input) =>
      safeRun(async () => {
        const profileId = input.profileId;
        const id = input.id;
        const advertiserId = stringField(input as Record<string, unknown>, "advertiserId");
        assertEntityAllowed("profile", profileId, config.allowedProfileIds);
        if (options.advertiserScoped) {
          assertRequiredEntityAllowed("advertiser", advertiserId, config.allowedAdvertiserIds);
        }
        assertEntityAllowed(options.singularDescriptionName, id, options.idAllowlist ?? new Set());
        return jsonResult(
          await client.request({
            method: "GET",
            path: `/userprofiles/${profileId}/${options.resource}/${id}`
          })
        );
      })
  );
}

function registerCreateTool(
  server: McpServer,
  context: ToolContext,
  options: {
    toolName: string;
    resource: string;
    description: string;
    advertiserIdFromBody?: boolean;
    campaignIdFromBody?: boolean;
  }
): void {
  server.registerTool(
    options.toolName,
    {
      description: options.description,
      inputSchema: z.object({
        profileId: idString,
        resource: jsonObject,
        ...mutationControls
      })
    },
    async ({ profileId, resource, dryRun, confirm }) =>
      safeRun(async () => {
        const advertiserId = options.advertiserIdFromBody ? stringField(resource, "advertiserId") : undefined;
        const campaignId = options.campaignIdFromBody ? stringField(resource, "campaignId") : undefined;
        if (options.advertiserIdFromBody) {
          assertRequiredEntityAllowed("advertiser", advertiserId, context.config.allowedAdvertiserIds);
        }
        if (options.campaignIdFromBody) {
          assertRequiredEntityAllowed("campaign", campaignId, context.config.allowedCampaignIds);
        }
        return runGuardedRequest({
          client: context.client,
          config: context.config,
          toolName: options.toolName,
          profileId,
          advertiserId,
          campaignId,
          dryRun,
          confirm,
          request: {
            method: "POST",
            path: `/userprofiles/${profileId}/${options.resource}`,
            body: resource
          }
        });
      })
  );
}

function registerPatchTool(
  server: McpServer,
  context: ToolContext,
  options: {
    toolName: string;
    resource: string;
    description: string;
    campaignIdFromId?: boolean;
    campaignIdFromBody?: boolean;
    advertiserScoped?: boolean;
  }
): void {
  server.registerTool(
    options.toolName,
    {
      description: options.description,
      inputSchema: z.object({
        profileId: idString,
        advertiserId: idString.optional(),
        id: idString,
        patch: jsonObject,
        ...mutationControls
      })
    },
    async ({ profileId, advertiserId, id, patch, dryRun, confirm }) =>
      safeRun(async () => {
        const campaignId = options.campaignIdFromId
          ? id
          : options.campaignIdFromBody
            ? stringField(patch, "campaignId")
            : undefined;
        const scopedAdvertiserId = options.advertiserScoped
          ? advertiserId ?? stringField(patch, "advertiserId")
          : undefined;
        if (options.advertiserScoped) {
          assertRequiredEntityAllowed("advertiser", scopedAdvertiserId, context.config.allowedAdvertiserIds);
        }
        if (options.campaignIdFromId || options.campaignIdFromBody) {
          assertRequiredEntityAllowed("campaign", campaignId, context.config.allowedCampaignIds);
        }
        return runGuardedRequest({
          client: context.client,
          config: context.config,
          toolName: options.toolName,
          profileId,
          advertiserId: scopedAdvertiserId,
          campaignId,
          dryRun,
          confirm,
          request: {
            method: "PATCH",
            path: `/userprofiles/${profileId}/${options.resource}`,
            query: { id },
            body: patch
          }
        });
      })
  );
}

async function runGuardedRequest(args: {
  client: Cm360Client;
  config: ServerConfig;
  toolName: string;
  profileId?: string;
  advertiserId?: string;
  campaignId?: string;
  dryRun?: boolean;
  confirm?: boolean;
  request: {
    method: HttpMethod;
    path: string;
    query?: QueryParams;
    body?: unknown;
  };
}) {
  return safeRun(async () => {
    const guard = await guardMutation(args.config, {
      toolName: args.toolName,
      profileId: args.profileId,
      advertiserId: args.advertiserId,
      campaignId: args.campaignId,
      dryRun: args.dryRun,
      confirm: args.confirm,
      request: args.request
    });

    if (guard.dryRun) {
      return jsonResult(guard.preview);
    }

    const result = await args.client.request(args.request);
    await auditMutation(args.config, {
      toolName: args.toolName,
      profileId: args.profileId,
      advertiserId: args.advertiserId,
      campaignId: args.campaignId,
      request: args.request
    }, "live_completed");

    return jsonResult(result);
  });
}

async function safeRun<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof errorResult>> {
  try {
    return await fn();
  } catch (error) {
    return errorResult(error);
  }
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const fieldValue = value[key];
  if (typeof fieldValue === "string") {
    return fieldValue;
  }

  if (typeof fieldValue === "number") {
    return String(fieldValue);
  }

  return undefined;
}

function assertRequiredEntityAllowed(
  entityName: string,
  id: string | undefined,
  allowlist: Set<string>
): void {
  assertEntityIdsAllowed(entityName, id ? [id] : undefined, allowlist, {
    requireWhenAllowlisted: true
  });
}
