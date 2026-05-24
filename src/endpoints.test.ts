import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { Cm360Client } from "./cm360Client.js";
import type { ServerConfig } from "./config.js";
import type { GoogleApiClient } from "./googleApiClient.js";
import { registerGtmTools } from "./gtmTools.js";
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
