import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { ServerConfig } from "./config.js";
import type { GoogleApiClient } from "./googleApiClient.js";
import { jsonResult } from "./response.js";
import { confirmSchema, dryRunSchema, idString, jsonObject, mutationControls, querySchema } from "./schemas.js";
import { assertAllowedEntities, assertBroadListAllowed } from "./safety.js";
import { runGuardedGoogleRequest, runRawGoogleRequest, safeRun } from "./toolHelpers.js";

interface GtmToolContext {
  client: GoogleApiClient;
  config: ServerConfig;
}

const containerInput = z.object({
  accountId: idString,
  containerId: idString
});

const workspaceInput = z.object({
  accountId: idString,
  containerId: idString,
  workspaceId: idString
});

export function registerGtmTools(server: McpServer, context: GtmToolContext): void {
  registerGtmReadTools(server, context);
  registerGtmWriteTools(server, context);
  registerGtmRawTool(server, context);
}

function registerGtmReadTools(server: McpServer, { client, config }: GtmToolContext): void {
  server.registerTool(
    "gtm_list_accounts",
    {
      description: "List Google Tag Manager accounts visible to the authenticated principal.",
      inputSchema: z.object({ query: querySchema })
    },
    async ({ query }) =>
      safeRun(async () => {
        assertBroadListAllowed("GTM account", config.allowedGtmAccountIds);
        return jsonResult(await client.request({ method: "GET", path: "/accounts", query }));
      })
  );

  server.registerTool(
    "gtm_get_account",
    {
      description: "Get one Google Tag Manager account.",
      inputSchema: z.object({ accountId: idString })
    },
    async ({ accountId }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "gtm", toolName: "gtm_get_account", gtmAccountId: accountId, request: { method: "GET", path: `/accounts/${accountId}` } });
        return jsonResult(await client.request({ method: "GET", path: `/accounts/${accountId}` }));
      })
  );

  server.registerTool(
    "gtm_list_containers",
    {
      description: "List containers in a Google Tag Manager account.",
      inputSchema: z.object({
        accountId: idString,
        query: querySchema
      })
    },
    async ({ accountId, query }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "gtm", toolName: "gtm_list_containers", gtmAccountId: accountId, request: { method: "GET", path: `/accounts/${accountId}/containers` } });
        assertBroadListAllowed("GTM container", config.allowedGtmContainerIds);
        return jsonResult(await client.request({ method: "GET", path: `/accounts/${accountId}/containers`, query }));
      })
  );

  server.registerTool(
    "gtm_get_container",
    {
      description: "Get one Google Tag Manager container.",
      inputSchema: containerInput
    },
    async ({ accountId, containerId }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "gtm", toolName: "gtm_get_container", gtmAccountId: accountId, gtmContainerId: containerId, request: { method: "GET", path: containerPath(accountId, containerId) } });
        return jsonResult(await client.request({ method: "GET", path: containerPath(accountId, containerId) }));
      })
  );

  server.registerTool(
    "gtm_list_workspaces",
    {
      description: "List GTM workspaces in a container.",
      inputSchema: z.object({
        accountId: idString,
        containerId: idString,
        query: querySchema
      })
    },
    async ({ accountId, containerId, query }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "gtm", toolName: "gtm_list_workspaces", gtmAccountId: accountId, gtmContainerId: containerId, request: { method: "GET", path: `${containerPath(accountId, containerId)}/workspaces` } });
        return jsonResult(await client.request({ method: "GET", path: `${containerPath(accountId, containerId)}/workspaces`, query }));
      })
  );

  registerWorkspaceResource(server, { client, config }, {
    listTool: "gtm_list_tags",
    getTool: "gtm_get_tag",
    resource: "tags",
    idName: "tagId",
    singular: "tag"
  });

  registerWorkspaceResource(server, { client, config }, {
    listTool: "gtm_list_triggers",
    getTool: "gtm_get_trigger",
    resource: "triggers",
    idName: "triggerId",
    singular: "trigger"
  });

  registerWorkspaceResource(server, { client, config }, {
    listTool: "gtm_list_variables",
    getTool: "gtm_get_variable",
    resource: "variables",
    idName: "variableId",
    singular: "variable"
  });

  registerWorkspaceResource(server, { client, config }, {
    listTool: "gtm_list_folders",
    getTool: "gtm_get_folder",
    resource: "folders",
    idName: "folderId",
    singular: "folder"
  });

  server.registerTool(
    "gtm_list_versions",
    {
      description: "List GTM container versions (returns version headers; the GTM v2 API exposes the version list via the version_headers resource).",
      inputSchema: z.object({
        accountId: idString,
        containerId: idString,
        query: querySchema
      })
    },
    async ({ accountId, containerId, query }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "gtm", toolName: "gtm_list_versions", gtmAccountId: accountId, gtmContainerId: containerId, request: { method: "GET", path: `${containerPath(accountId, containerId)}/version_headers` } });
        return jsonResult(await client.request({ method: "GET", path: `${containerPath(accountId, containerId)}/version_headers`, query }));
      })
  );

  server.registerTool(
    "gtm_get_version",
    {
      description: "Get one GTM container version.",
      inputSchema: z.object({
        accountId: idString,
        containerId: idString,
        versionId: idString
      })
    },
    async ({ accountId, containerId, versionId }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "gtm", toolName: "gtm_get_version", gtmAccountId: accountId, gtmContainerId: containerId, request: { method: "GET", path: `${containerPath(accountId, containerId)}/versions/${versionId}` } });
        return jsonResult(await client.request({ method: "GET", path: `${containerPath(accountId, containerId)}/versions/${versionId}` }));
      })
  );
}

function registerGtmWriteTools(server: McpServer, { client, config }: GtmToolContext): void {
  server.registerTool(
    "gtm_create_workspace",
    {
      description: "Create a GTM workspace in a container.",
      inputSchema: z.object({
        accountId: idString,
        containerId: idString,
        workspace: jsonObject,
        ...mutationControls
      })
    },
    async ({ accountId, containerId, workspace, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client,
        config,
        product: "gtm",
        toolName: "gtm_create_workspace",
        gtmAccountId: accountId,
        gtmContainerId: containerId,
        dryRun,
        confirm,
        request: {
          method: "POST",
          path: `${containerPath(accountId, containerId)}/workspaces`,
          body: workspace
        }
      })
  );

  registerWorkspaceCreateUpdate(server, { client, config }, {
    createTool: "gtm_create_tag",
    updateTool: "gtm_update_tag",
    resource: "tags",
    bodyName: "tag",
    idName: "tagId"
  });

  registerWorkspaceCreateUpdate(server, { client, config }, {
    createTool: "gtm_create_trigger",
    updateTool: "gtm_update_trigger",
    resource: "triggers",
    bodyName: "trigger",
    idName: "triggerId"
  });

  registerWorkspaceCreateUpdate(server, { client, config }, {
    createTool: "gtm_create_variable",
    updateTool: "gtm_update_variable",
    resource: "variables",
    bodyName: "variable",
    idName: "variableId"
  });

  server.registerTool(
    "gtm_create_version",
    {
      description: "Create a GTM container version from a workspace.",
      inputSchema: z.object({
        accountId: idString,
        containerId: idString,
        workspaceId: idString,
        request: jsonObject,
        ...mutationControls
      })
    },
    async ({ accountId, containerId, workspaceId, request, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client,
        config,
        product: "gtm",
        toolName: "gtm_create_version",
        gtmAccountId: accountId,
        gtmContainerId: containerId,
        dryRun,
        confirm,
        request: {
          method: "POST",
          path: `${workspacePath(accountId, containerId, workspaceId)}:create_version`,
          body: request
        }
      })
  );

  server.registerTool(
    "gtm_publish_version",
    {
      description: "Publish a GTM container version. This is externally visible and requires live write confirmation.",
      inputSchema: z.object({
        accountId: idString,
        containerId: idString,
        versionId: idString,
        fingerprint: z.string().optional(),
        ...mutationControls
      })
    },
    async ({ accountId, containerId, versionId, fingerprint, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client,
        config,
        product: "gtm",
        toolName: "gtm_publish_version",
        gtmAccountId: accountId,
        gtmContainerId: containerId,
        dryRun,
        confirm,
        request: {
          method: "POST",
          path: `${containerPath(accountId, containerId)}/versions/${versionId}:publish`,
          query: { fingerprint },
          body: {}
        }
      })
  );

  server.registerTool(
    "gtm_sync_workspace",
    {
      description: "Sync a GTM workspace to detect merge conflicts before creating a version.",
      inputSchema: z.object({
        accountId: idString,
        containerId: idString,
        workspaceId: idString,
        ...mutationControls
      })
    },
    async ({ accountId, containerId, workspaceId, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client,
        config,
        product: "gtm",
        toolName: "gtm_sync_workspace",
        gtmAccountId: accountId,
        gtmContainerId: containerId,
        dryRun,
        confirm,
        request: {
          method: "POST",
          path: `${workspacePath(accountId, containerId, workspaceId)}:sync`,
          body: {}
        }
      })
  );

  server.registerTool(
    "gtm_quick_preview_workspace",
    {
      description: "Create a quick preview for a GTM workspace.",
      inputSchema: z.object({
        accountId: idString,
        containerId: idString,
        workspaceId: idString,
        ...mutationControls
      })
    },
    async ({ accountId, containerId, workspaceId, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client,
        config,
        product: "gtm",
        toolName: "gtm_quick_preview_workspace",
        gtmAccountId: accountId,
        gtmContainerId: containerId,
        dryRun,
        confirm,
        request: {
          method: "POST",
          path: `${workspacePath(accountId, containerId, workspaceId)}:quick_preview`,
          body: {}
        }
      })
  );
}

function registerGtmRawTool(server: McpServer, { client, config }: GtmToolContext): void {
  server.registerTool(
    "gtm_api_request",
    {
      description: "Advanced GTM API request. Disabled unless GTM_ENABLE_RAW_REQUEST or GMP_ENABLE_RAW_REQUEST is true.",
      inputSchema: z.object({
        method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
        path: z.string().min(1),
        query: querySchema,
        body: z.unknown().optional(),
        accountId: idString.optional(),
        containerId: idString.optional(),
        dryRun: dryRunSchema,
        confirm: confirmSchema
      })
    },
    async ({ method, path, query, body, accountId, containerId, dryRun, confirm }) =>
      runRawGoogleRequest({
        client,
        config,
        product: "gtm",
        toolName: "gtm_api_request",
        gtmAccountId: accountId,
        gtmContainerId: containerId,
        dryRun,
        confirm,
        request: { method, path, query, body }
      })
  );
}

function registerWorkspaceResource(
  server: McpServer,
  { client, config }: GtmToolContext,
  options: {
    listTool: string;
    getTool: string;
    resource: string;
    idName: string;
    singular: string;
  }
): void {
  server.registerTool(
    options.listTool,
    {
      description: `List GTM ${options.singular}s in a workspace.`,
      inputSchema: z.object({
        ...workspaceInput.shape,
        query: querySchema
      })
    },
    async ({ accountId, containerId, workspaceId, query }) =>
      safeRun(async () => {
        assertAllowedEntities(config, { product: "gtm", toolName: options.listTool, gtmAccountId: accountId, gtmContainerId: containerId, request: { method: "GET", path: `${workspacePath(accountId, containerId, workspaceId)}/${options.resource}` } });
        return jsonResult(await client.request({ method: "GET", path: `${workspacePath(accountId, containerId, workspaceId)}/${options.resource}`, query }));
      })
  );

  server.registerTool(
    options.getTool,
    {
      description: `Get one GTM ${options.singular}.`,
      inputSchema: z.object({
        ...workspaceInput.shape,
        [options.idName]: idString
      })
    },
    async (input) => {
      const indexedInput = input as Record<string, unknown> & typeof input;
      const accountId = input.accountId;
      const containerId = input.containerId;
      const workspaceId = input.workspaceId;
      const resourceId = String(indexedInput[options.idName]);
      return safeRun(async () => {
        assertAllowedEntities(config, { product: "gtm", toolName: options.getTool, gtmAccountId: accountId, gtmContainerId: containerId, request: { method: "GET", path: `${workspacePath(accountId, containerId, workspaceId)}/${options.resource}/${resourceId}` } });
        return jsonResult(await client.request({ method: "GET", path: `${workspacePath(accountId, containerId, workspaceId)}/${options.resource}/${resourceId}` }));
      });
    }
  );
}

function registerWorkspaceCreateUpdate(
  server: McpServer,
  { client, config }: GtmToolContext,
  options: {
    createTool: string;
    updateTool: string;
    resource: string;
    bodyName: string;
    idName: string;
  }
): void {
  server.registerTool(
    options.createTool,
    {
      description: `Create a GTM ${options.bodyName} in a workspace.`,
      inputSchema: z.object({
        ...workspaceInput.shape,
        resource: jsonObject,
        ...mutationControls
      })
    },
    async ({ accountId, containerId, workspaceId, resource, dryRun, confirm }) =>
      runGuardedGoogleRequest({
        client,
        config,
        product: "gtm",
        toolName: options.createTool,
        gtmAccountId: accountId,
        gtmContainerId: containerId,
        dryRun,
        confirm,
        request: {
          method: "POST",
          path: `${workspacePath(accountId, containerId, workspaceId)}/${options.resource}`,
          body: resource
        }
      })
  );

  server.registerTool(
    options.updateTool,
    {
      description: `Update a GTM ${options.bodyName} in a workspace.`,
      inputSchema: z.object({
        ...workspaceInput.shape,
        [options.idName]: idString,
        resource: jsonObject,
        fingerprint: z.string().optional(),
        ...mutationControls
      })
    },
    async (input) => {
      const indexedInput = input as Record<string, unknown> & typeof input;
      const accountId = input.accountId;
      const containerId = input.containerId;
      const workspaceId = input.workspaceId;
      const resourceId = String(indexedInput[options.idName]);
      return runGuardedGoogleRequest({
        client,
        config,
        product: "gtm",
        toolName: options.updateTool,
        gtmAccountId: accountId,
        gtmContainerId: containerId,
        dryRun: input.dryRun,
        confirm: input.confirm,
        request: {
          method: "PUT",
          path: `${workspacePath(accountId, containerId, workspaceId)}/${options.resource}/${resourceId}`,
          query: { fingerprint: input.fingerprint },
          body: input.resource
        }
      });
    }
  );
}

function containerPath(accountId: string, containerId: string): string {
  return `/accounts/${accountId}/containers/${containerId}`;
}

function workspacePath(accountId: string, containerId: string, workspaceId: string): string {
  return `${containerPath(accountId, containerId)}/workspaces/${workspaceId}`;
}
