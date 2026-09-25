#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { withToolAnnotations } from "./annotations.js";
import { createAuthClient } from "./auth.js";
import { Cm360Client } from "./cm360Client.js";
import { registerBidManagerTools, registerDv360Tools } from "./dv360Tools.js";
import { registerGa4Tools } from "./ga4Tools.js";
import { GoogleApiClient } from "./googleApiClient.js";
import { registerGtmTools } from "./gtmTools.js";
import { loadConfig } from "./config.js";
import { registerSa360Tools } from "./sa360Tools.js";
import { registerCm360Tools } from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const authClient = await createAuthClient(config);
  const cm360Client = new Cm360Client(config, authClient);
  const dv360Client = new GoogleApiClient("DV360", config.dv360ApiBaseUrl, config, authClient);
  const bidManagerClient = new GoogleApiClient("Bid Manager", config.bidManagerApiBaseUrl, config, authClient);
  const ga4AdminClient = new GoogleApiClient("GA4 Admin", config.ga4AdminApiBaseUrl, config, authClient);
  const ga4AdminAlphaClient = new GoogleApiClient(
    "GA4 Admin Alpha",
    config.ga4AdminAlphaApiBaseUrl,
    config,
    authClient
  );
  const ga4DataClient = new GoogleApiClient("GA4 Data", config.ga4DataApiBaseUrl, config, authClient);
  const gtmClient = new GoogleApiClient("GTM", config.gtmApiBaseUrl, config, authClient);
  const sa360Client = new GoogleApiClient("SA360 Reporting", config.sa360ApiBaseUrl, config, authClient);
  const sa360LegacyClient = new GoogleApiClient(
    "SA360 Legacy Conversion",
    config.sa360LegacyApiBaseUrl,
    config,
    authClient
  );

  const server = new McpServer(
    {
      name: "gmp-mcp",
      version: "0.1.0"
    },
    {
      instructions:
        "Use dryRun=true first for Google Marketing Platform write tools, then retry with dryRun=false and confirm=true only after the user has explicitly approved the exact change."
    }
  );

  const tools = withToolAnnotations(server);
  const products = config.enabledProducts;

  if (products.has("cm360")) {
    registerCm360Tools(tools, {
      client: cm360Client,
      config
    });
  }
  if (products.has("dv360")) {
    registerDv360Tools(tools, {
      dv360Client,
      config
    });
  }
  if (products.has("bidManager")) {
    registerBidManagerTools(tools, {
      bidManagerClient,
      config
    });
  }
  if (products.has("ga4")) {
    registerGa4Tools(tools, {
      adminClient: ga4AdminClient,
      adminAlphaClient: ga4AdminAlphaClient,
      dataClient: ga4DataClient,
      config
    });
  }
  if (products.has("gtm")) {
    registerGtmTools(tools, {
      client: gtmClient,
      config
    });
  }
  if (products.has("sa360")) {
    registerSa360Tools(tools, {
      reportingClient: sa360Client,
      legacyClient: sa360LegacyClient,
      config
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
