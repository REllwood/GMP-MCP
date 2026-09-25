import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Cm360Client } from "./cm360Client.js";
import { ALL_GMP_PRODUCTS, type ServerConfig } from "./config.js";
import { unguardedSideEffectTools, withToolAnnotations } from "./annotations.js";
import { registerBidManagerTools, registerDv360Tools } from "./dv360Tools.js";
import { registerGa4Tools } from "./ga4Tools.js";
import { GoogleApiClient } from "./googleApiClient.js";
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
    enabledProducts: new Set(ALL_GMP_PRODUCTS),
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

interface RecordedRequest {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

// Answers GETs from a fixed map of paths, records every call and returns {} for anything else.
function routedClient(routes: Record<string, unknown>) {
  const requests: RecordedRequest[] = [];
  const client = {
    request: async (options: RecordedRequest) => {
      requests.push(options);
      return options.method === "GET" && options.path in routes ? routes[options.path] : {};
    }
  } as unknown as GoogleApiClient;
  return { client, requests };
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
    const client = await connectServer((rawServer) => {
      const server = withToolAnnotations(rawServer);
      registerCm360Tools(server, { client: cm360Client, config });
      registerDv360Tools(server, { dv360Client: googleClient, config });
      registerBidManagerTools(server, { bidManagerClient: googleClient, config });
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

    for (const tool of result.tools) {
      const takesDryRun = Object.hasOwn(tool.inputSchema.properties ?? {}, "dryRun");
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(!takesDryRun && !unguardedSideEffectTools.has(tool.name));
      if (takesDryRun) {
        expect(tool.annotations?.destructiveHint, tool.name).toBe(true);
      }
    }
    const readOnly = (name: string) =>
      result.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint;
    expect(readOnly("gtm_publish_version")).toBe(false);
    expect(readOnly("dv360_api_request")).toBe(false);
    expect(readOnly("ga4_run_report")).toBe(true);
    expect(readOnly("bidmanager_download_report")).toBe(false);
  });
});

describe("Bid Manager report downloads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function bidManagerTools(config: ServerConfig, report: unknown) {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, authorization: new Headers(init.headers).get("authorization") });
      return href.startsWith("https://doubleclickbidmanager.googleapis.com/")
        ? new Response(JSON.stringify(report))
        : new Response("Date,Impressions\n2026-09-01,10\n");
    });
    const bidManagerClient = new GoogleApiClient("Bid Manager", config.bidManagerApiBaseUrl, config, {
      getAccessToken: async () => "token"
    });
    const client = await connectServer((server) => {
      registerBidManagerTools(server, { bidManagerClient, config });
    });
    return { client, calls };
  }

  it("downloads from the report's own storage path without sending credentials", async () => {
    const config = testConfig();
    config.allowedBidManagerQueryIds = new Set(["1"]);
    const { client, calls } = await bidManagerTools(config, {
      metadata: {
        status: { state: "DONE", format: "CSV" },
        googleCloudStoragePath: "https://storage.googleapis.com/dv360-reports/1-2.csv?Signature=abc"
      }
    });

    const result = await client.callTool({
      name: "bidmanager_download_report",
      arguments: { queryId: "1", reportId: "2" }
    });

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(firstText(result));
    expect(payload.filePath).toMatch(/bidmanager-report-1-2\.csv$/);
    expect(payload.preview).toContain("Impressions");
    expect(calls).toEqual([
      { url: "https://doubleclickbidmanager.googleapis.com/v2/queries/1/reports/2", authorization: "Bearer token" },
      { url: "https://storage.googleapis.com/dv360-reports/1-2.csv?Signature=abc", authorization: null }
    ]);
  });

  it("refuses report metadata that points anywhere but Cloud Storage", async () => {
    const { client, calls } = await bidManagerTools(testConfig(), {
      metadata: {
        status: { state: "DONE" },
        googleCloudStoragePath: "https://displayvideo.googleapis.com/v4/advertisers/999/lineItems"
      }
    });

    const result = await client.callTool({
      name: "bidmanager_download_report",
      arguments: { queryId: "1", reportId: "2" }
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/trusted Google download host/);
    expect(calls).toHaveLength(1);
  });

  it("explains when a report is not ready and checks the query allowlist first", async () => {
    const config = testConfig();
    config.allowedBidManagerQueryIds = new Set(["1"]);
    const { client, calls } = await bidManagerTools(config, { metadata: { status: { state: "RUNNING" } } });

    const running = await client.callTool({
      name: "bidmanager_download_report",
      arguments: { queryId: "1", reportId: "2" }
    });
    expect(firstText(running)).toMatch(/state: RUNNING/);

    const otherQuery = await client.callTool({
      name: "bidmanager_download_report",
      arguments: { queryId: "9", reportId: "2" }
    });
    expect(firstText(otherQuery)).toMatch(/query 9 is not in the configured allowlist/);
    expect(calls).toHaveLength(1);
  });
});

describe("SA360 conversion targets", () => {
  it("requires every conversion to target the declared, allowlisted customer", async () => {
    const config = testConfig();
    config.allowedSa360CustomerIds = new Set(["111"]);
    const { client: google, requests } = routedClient({});
    const client = await connectServer((server) => {
      registerSa360Tools(server, { reportingClient: google, legacyClient: google, config });
    });
    const call = (name: string, conversion: unknown[]) =>
      client.callTool({
        name,
        arguments: {
          customerId: "111",
          request: { kind: "doubleclicksearch#conversionList", conversion },
          dryRun: true
        }
      });

    const otherCustomer = await call("sa360_insert_conversions", [
      { customerId: "111", conversionId: "a" },
      { customerId: "999", conversionId: "b" }
    ]);
    expect(firstText(otherCustomer)).toMatch(/conversion\[1\] targets SA360 customer 999/);

    const updateOther = await call("sa360_update_conversions", [{ customerId: "999", conversionId: "a" }]);
    expect(updateOther.isError).toBe(true);

    const unverifiable = await call("sa360_insert_conversions", [
      { agencyId: "1", advertiserId: "2", conversionId: "c" }
    ]);
    expect(firstText(unverifiable)).toMatch(/has no customerId/);

    const scoped = await call("sa360_insert_conversions", [{ customerId: "111", conversionId: "d" }]);
    expect(JSON.parse(firstText(scoped)).status).toBe("dry_run");
    expect(requests).toHaveLength(0);
  });
});

describe("GA4 account allowlist", () => {
  it("checks the account Google reports for each property", async () => {
    const config = testConfig();
    config.allowedGa4AccountIds = new Set(["100"]);
    const { client: google, requests } = routedClient({
      "/properties/555": { name: "properties/555", account: "accounts/200", parent: "accounts/200" },
      "/properties/777": { name: "properties/777", account: "accounts/100", parent: "properties/700" }
    });
    const client = await connectServer((server) => {
      registerGa4Tools(server, { adminClient: google, adminAlphaClient: google, dataClient: google, config });
    });

    const blocked: Array<[string, Record<string, unknown>]> = [
      ["ga4_get_property", { propertyId: "555" }],
      ["ga4_run_report", { propertyId: "555", request: {} }],
      ["ga4_list_audiences", { propertyId: "555" }],
      ["ga4_create_custom_dimension", { propertyId: "555", resource: {}, dryRun: true }]
    ];
    for (const [name, args] of blocked) {
      const result = await client.callTool({ name, arguments: args });
      expect(firstText(result), name).toMatch(/GA4 account 200 is not in the configured allowlist/);
    }
    expect(requests.every((request) => request.path === "/properties/555")).toBe(true);

    const allowed = await client.callTool({
      name: "ga4_run_report",
      arguments: { propertyId: "777", request: { dimensions: [] } }
    });
    expect(allowed.isError).not.toBe(true);
    expect(requests.at(-1)).toMatchObject({ method: "POST", path: "/properties/777:runReport" });
  });
});

describe("DV360 partner allowlist", () => {
  it("scopes advertiser listing and advertiser tools to allowed partners", async () => {
    const config = testConfig();
    config.allowedDv360PartnerIds = new Set(["1"]);
    const { client: google } = routedClient({
      "/advertisers/10": { advertiserId: "10", partnerId: "1" },
      "/advertisers/20": { advertiserId: "20", partnerId: "2" }
    });
    const client = await connectServer((server) => {
      registerDv360Tools(server, { dv360Client: google, config });
    });
    const listAdvertisers = (query?: Record<string, unknown>) =>
      client.callTool({ name: "dv360_list_advertisers", arguments: query ? { query } : {} });

    expect((await listAdvertisers()).isError).toBe(true);
    expect((await listAdvertisers({ partnerId: "2" })).isError).toBe(true);
    expect((await listAdvertisers({ partnerId: "1" })).isError).not.toBe(true);
    expect(firstText(await listAdvertisers({ partnerId: "1", partner_id: "2" }))).toMatch(
      /Pass partnerId under its exact name, not as query.partner_id/
    );

    const otherPartner = await client.callTool({
      name: "dv360_create_campaign",
      arguments: { advertiserId: "20", resource: {}, dryRun: true }
    });
    expect(firstText(otherPartner)).toMatch(/DV360 partner 2 is not in the configured allowlist/);

    const ownPartner = await client.callTool({
      name: "dv360_create_campaign",
      arguments: { advertiserId: "10", resource: {}, dryRun: true }
    });
    expect(JSON.parse(firstText(ownPartner)).status).toBe("dry_run");
  });
});

describe("DV360 parent allowlists", () => {
  it("checks the insertion order that owns each targeted line item", async () => {
    const config = testConfig();
    config.allowedDv360InsertionOrderIds = new Set(["10"]);
    const { client: google } = routedClient({
      "/advertisers/1/lineItems/5": { lineItemId: "5", insertionOrderId: "99", campaignId: "7" },
      "/advertisers/1/lineItems/6": { lineItemId: "6", insertionOrderId: "10", campaignId: "7" }
    });
    const client = await connectServer((server) => {
      registerDv360Tools(server, { dv360Client: google, config });
    });
    const patchLineItem = (lineItemId: string) =>
      client.callTool({
        name: "dv360_patch_line_item",
        arguments: { advertiserId: "1", lineItemId, patch: { displayName: "x" }, updateMask: "displayName", dryRun: true }
      });
    const bulkUpdate = (lineItemIds: string[]) =>
      client.callTool({
        name: "dv360_bulk_update_line_items",
        arguments: { advertiserId: "1", request: { lineItemIds, updateMask: "entityStatus" }, dryRun: true }
      });

    expect(firstText(await patchLineItem("5"))).toMatch(/insertion order 99 is not in the configured allowlist/);
    expect(JSON.parse(firstText(await patchLineItem("6"))).status).toBe("dry_run");
    expect(firstText(await bulkUpdate(["6", "5"]))).toMatch(/insertion order 99/);
    expect(firstText(await bulkUpdate(Array.from({ length: 21 }, (_, index) => String(index + 1))))).toMatch(
      /batches of 20 or fewer/
    );

    const aliased = await client.callTool({
      name: "dv360_bulk_list_line_item_assigned_targeting_options",
      arguments: { advertiserId: "1", lineItemIds: ["6"], query: { line_item_ids: ["5"] } }
    });
    expect(firstText(aliased)).toMatch(/Pass lineItemIds under its exact name/);

    const list = await client.callTool({ name: "dv360_list_line_items", arguments: { advertiserId: "1" } });
    expect(firstText(list)).toMatch(/Broad DV360 line item listing is blocked/);
  });

  it("blocks duplicating a line item while the line item allowlist is set", async () => {
    const config = testConfig();
    config.allowedDv360LineItemIds = new Set(["5"]);
    const { client: google, requests } = routedClient({});
    const client = await connectServer((server) => {
      registerDv360Tools(server, { dv360Client: google, config });
    });

    const result = await client.callTool({
      name: "dv360_duplicate_line_item",
      arguments: { advertiserId: "1", lineItemId: "5", dryRun: true }
    });

    expect(firstText(result)).toMatch(/Creating a new DV360 line item is blocked/);
    expect(requests).toHaveLength(0);
  });

  it("checks the campaign of the insertion order a new line item joins", async () => {
    const config = testConfig();
    config.allowedDv360CampaignIds = new Set(["7"]);
    const { client: google } = routedClient({
      "/advertisers/1/insertionOrders/99": { insertionOrderId: "99", campaignId: "8" }
    });
    const client = await connectServer((server) => {
      registerDv360Tools(server, { dv360Client: google, config });
    });
    const createLineItem = (resource: Record<string, unknown>) =>
      client.callTool({ name: "dv360_create_line_item", arguments: { advertiserId: "1", resource, dryRun: true } });

    expect(firstText(await createLineItem({ insertionOrderId: "99" }))).toMatch(
      /DV360 campaign 8 is not in the configured allowlist/
    );
    expect(firstText(await createLineItem({}))).toMatch(/insertionOrderId is required/);
  });
});

describe("raw request paths", () => {
  it("rejects a query string hidden in the path", async () => {
    const config = testConfig();
    config.allowedCampaignIds = new Set(["111"]);
    config.rawRequestEnabled = true;
    const { client: google, requests } = routedClient({});
    const client = await connectServer((server) => {
      registerCm360Tools(server, { client: google as unknown as Cm360Client, config });
    });

    const result = await client.callTool({
      name: "cm360_api_request",
      arguments: {
        method: "PATCH",
        path: "/userprofiles/1/campaigns?id=999",
        query: { id: "111" },
        body: {},
        dryRun: true
      }
    });

    expect(firstText(result)).toMatch(/must not contain a query string/);
    expect(requests).toHaveLength(0);
  });
});
