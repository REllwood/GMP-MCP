import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { Cm360Client } from "./cm360Client.js";
import type { ServerConfig } from "./config.js";
import { registerDv360Tools } from "./dv360Tools.js";
import { registerGa4Tools } from "./ga4Tools.js";
import type { GoogleApiClient } from "./googleApiClient.js";
import { registerGtmTools } from "./gtmTools.js";
import { registerSa360Tools } from "./sa360Tools.js";
import { registerCm360Tools } from "./tools.js";

function testConfig(): ServerConfig {
  const productFlags = {
    cm360: false,
    dv360: false,
    bidManager: false,
    ga4: false,
    gtm: false,
    sa360: false
  };

  return {
    apiBaseUrl: "https://dfareporting.googleapis.com/dfareporting/v5",
    dv360ApiBaseUrl: "https://displayvideo.googleapis.com/v4",
    bidManagerApiBaseUrl: "https://doubleclickbidmanager.googleapis.com/v2",
    ga4AdminApiBaseUrl: "https://analyticsadmin.googleapis.com/v1beta",
    ga4AdminAlphaApiBaseUrl: "https://analyticsadmin.googleapis.com/v1alpha",
    ga4DataApiBaseUrl: "https://analyticsdata.googleapis.com/v1beta",
    gtmApiBaseUrl: "https://tagmanager.googleapis.com/tagmanager/v2",
    sa360ApiBaseUrl: "https://searchads360.googleapis.com/v0",
    sa360LegacyApiBaseUrl: "https://www.googleapis.com/doubleclicksearch/v2",
    scopes: [],
    authMode: "auto",
    writesEnabled: false,
    rawRequestEnabled: false,
    productWritesEnabled: productFlags,
    productRawRequestEnabled: productFlags,
    allowedProfileIds: new Set(),
    allowedAdvertiserIds: new Set(),
    allowedCampaignIds: new Set(),
    allowedDv360PartnerIds: new Set(),
    allowedDv360AdvertiserIds: new Set(),
    allowedDv360CampaignIds: new Set(),
    allowedDv360InsertionOrderIds: new Set(),
    allowedDv360LineItemIds: new Set(),
    allowedBidManagerQueryIds: new Set(),
    allowedGa4AccountIds: new Set(),
    allowedGa4PropertyIds: new Set(),
    allowedGtmAccountIds: new Set(),
    allowedGtmContainerIds: new Set(),
    allowedSa360CustomerIds: new Set(),
    auditLogPath: path.join(os.tmpdir(), "gmp-mcp-test-audit.log"),
    downloadDir: path.join(os.tmpdir(), "gmp-mcp-test-downloads"),
    requestsPerSecond: 1000,
    maxRetries: 0,
    requestTimeoutMs: 5000,
    maxDownloadBytes: 100_000_000,
    allowUnsafeBaseUrls: false
  };
}

async function connectServer(register: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "gmp-mcp-test", version: "0.0.0" });
  register(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gmp-mcp-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const block = content?.[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("Expected a text content block in the tool result.");
  }
  return block.text;
}

describe("CM360 patch request shape (dfareporting v5)", () => {
  it("sends the resource id as a query parameter, not a path segment", async () => {
    const config = testConfig();
    const client = await connectServer((server) => {
      registerCm360Tools(server, {
        client: new Cm360Client(config, { getAccessToken: async () => "test-token" }),
        config
      });
    });

    const result = await client.callTool({
      name: "cm360_patch_campaign",
      arguments: { profileId: "1", id: "123", patch: { name: "Renamed" }, dryRun: true }
    });

    const preview = JSON.parse(firstText(result));
    expect(preview.status).toBe("dry_run");
    expect(preview.request.method).toBe("PATCH");
    expect(preview.request.path).toBe("/userprofiles/1/campaigns");
    expect(preview.request.query).toEqual({ id: "123" });
    expect(preview.request.path).not.toContain("/123");
  });
});

describe("GTM version listing endpoint", () => {
  it("lists versions via the version_headers resource, not /versions", async () => {
    const config = testConfig();
    const requests: Array<{ method: string; path: string }> = [];
    const recordingClient = {
      request: async (options: { method: string; path: string }) => {
        requests.push({ method: options.method, path: options.path });
        return { containerVersionHeader: [] };
      }
    } as unknown as GoogleApiClient;

    const client = await connectServer((server) => {
      registerGtmTools(server, { client: recordingClient, config });
    });

    await client.callTool({
      name: "gtm_list_versions",
      arguments: { accountId: "100", containerId: "200" }
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].path).toBe("/accounts/100/containers/200/version_headers");
  });
});

describe("CM360 allowlist ownership", () => {
  it("rejects declared advertiser metadata that does not own the returned resource", async () => {
    const config = testConfig();
    config.allowedAdvertiserIds = new Set(["10"]);
    const recordingClient = {
      request: async () => ({ id: "2", advertiserId: "20" })
    } as unknown as Cm360Client;
    const client = await connectServer((server) => {
      registerCm360Tools(server, { client: recordingClient, config });
    });

    const result = await client.callTool({
      name: "cm360_get_campaign",
      arguments: { profileId: "1", advertiserId: "10", id: "2" }
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/not in the configured allowlist/);
  });
});

describe("CM360 placement tag request shape", () => {
  it("uses discovery parameter names and flattened tag properties", async () => {
    const config = testConfig();
    const requests: Array<{ query?: Record<string, unknown> }> = [];
    const recordingClient = {
      request: async (options: { query?: Record<string, unknown> }) => {
        requests.push(options);
        return { placementTags: [] };
      }
    } as unknown as Cm360Client;
    const client = await connectServer((server) => {
      registerCm360Tools(server, { client: recordingClient, config });
    });

    await client.callTool({
      name: "cm360_generate_placement_tags",
      arguments: {
        profileId: "1",
        campaignId: "2",
        placementIds: ["3", "4"],
        tagFormats: ["PLACEMENT_TAG_JAVASCRIPT"],
        tagProperties: { tcfGdprMacrosIncluded: false, gppMacrosIncluded: true }
      }
    });

    expect(requests[0]?.query).toEqual({
      campaignId: "2",
      placementIds: ["3", "4"],
      tagFormats: ["PLACEMENT_TAG_JAVASCRIPT"],
      "tagProperties.tcfGdprMacrosIncluded": false,
      "tagProperties.gppMacrosIncluded": true,
      "tagProperties.dcDbmMacroIncluded": undefined
    });
  });
});

describe("GA4 property filters", () => {
  it("requires a filter target and binds it to the declared account", async () => {
    const config = testConfig();
    config.allowedGa4AccountIds = new Set(["100"]);
    const requests: Array<{ query?: Record<string, unknown> }> = [];
    const recordingClient = {
      request: async (options: { query?: Record<string, unknown> }) => {
        requests.push(options);
        return { properties: [] };
      }
    } as unknown as GoogleApiClient;
    const client = await connectServer((server) => {
      registerGa4Tools(server, {
        adminClient: recordingClient,
        adminAlphaClient: recordingClient,
        dataClient: recordingClient,
        config
      });
    });

    const mismatched = await client.callTool({
      name: "ga4_list_properties",
      arguments: { accountId: "100", filter: "parent:accounts/200" }
    });
    expect(mismatched.isError).toBe(true);
    expect(requests).toHaveLength(0);

    await client.callTool({
      name: "ga4_list_properties",
      arguments: { accountId: "100" }
    });
    expect(requests[0]?.query).toEqual({ filter: "parent:accounts/100" });
  });
});

describe("current DV360 targeting surfaces", () => {
  it("rejects sunset insertion-order targeting and keeps line-item targeting", async () => {
    const config = testConfig();
    const requests: Array<{ path: string }> = [];
    const recordingClient = {
      request: async (options: { path: string }) => {
        requests.push(options);
        return { assignedTargetingOptions: [] };
      }
    } as unknown as GoogleApiClient;
    const client = await connectServer((server) => {
      registerDv360Tools(server, {
        dv360Client: recordingClient,
        bidManagerClient: recordingClient,
        config
      });
    });

    const sunset = await client.callTool({
      name: "dv360_list_assigned_targeting_options",
      arguments: { advertiserId: "1", level: "insertionOrder", insertionOrderId: "2" }
    });
    expect(sunset.isError).toBe(true);

    await client.callTool({
      name: "dv360_list_assigned_targeting_options",
      arguments: {
        advertiserId: "1",
        level: "lineItem",
        lineItemId: "2",
        targetingType: "TARGETING_TYPE_GEO_REGION"
      }
    });
    expect(requests[0]?.path).toBe(
      "/advertisers/1/lineItems/2/targetingTypes/TARGETING_TYPE_GEO_REGION/assignedTargetingOptions"
    );
  });
});

describe("full MCP registration", () => {
  it("registers every product tool with unique names", async () => {
    const config = testConfig();
    const googleClient = {
      request: async () => ({})
    } as unknown as GoogleApiClient;
    const cm360Client = {
      request: async () => ({})
    } as unknown as Cm360Client;
    const client = await connectServer((server) => {
      registerCm360Tools(server, { client: cm360Client, config });
      registerDv360Tools(server, {
        dv360Client: googleClient,
        bidManagerClient: googleClient,
        config
      });
      registerGa4Tools(server, {
        adminClient: googleClient,
        adminAlphaClient: googleClient,
        dataClient: googleClient,
        config
      });
      registerGtmTools(server, { client: googleClient, config });
      registerSa360Tools(server, {
        reportingClient: googleClient,
        legacyClient: googleClient,
        config
      });
    });

    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);
    expect(names).toHaveLength(148);
    expect(new Set(names).size).toBe(names.length);
  });
});
