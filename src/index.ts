#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createAuthClient } from "./auth.js";
import { Cm360Client } from "./cm360Client.js";
import { registerDv360Tools } from "./dv360Tools.js";
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

  registerCm360Tools(server, {
    client: cm360Client,
    config
  });
  registerDv360Tools(server, {
    dv360Client,
    bidManagerClient,
    config
  });
  registerGa4Tools(server, {
    adminClient: ga4AdminClient,
    adminAlphaClient: ga4AdminAlphaClient,
    dataClient: ga4DataClient,
    config
  });
  registerGtmTools(server, {
    client: gtmClient,
    config
  });
  registerSa360Tools(server, {
    reportingClient: sa360Client,
    legacyClient: sa360LegacyClient,
    config
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
