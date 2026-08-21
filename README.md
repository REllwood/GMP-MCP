# GMP MCP Server

> **Beta** — This server is under active development and still being tested. Tool names, configuration options and behaviour may change between releases.
>
> **This server can make live, irreversible changes to your Google Marketing Platform accounts.** That includes creating and modifying campaigns with real budgets, publishing GTM containers to production websites, uploading conversion data, and altering analytics configuration. A misconfigured write or a poorly scoped prompt could spend real money or destroy work that took significant effort to build.
>
> Read the [Safety Model](#safety-model), [Write Flags](#write-flags) and [Allowlists](#allowlists) sections carefully before enabling any write operations. Start with reads only, use `dryRun=true` for every write, and keep allowlists tight. We strongly recommend testing against non-production accounts first.

This project is a write-capable Model Context Protocol (MCP) server for Google Marketing Platform. It lets MCP clients — Claude Code, Codex, Cursor and similar local assistant tools — inspect, report on and manage Google Marketing Platform accounts through structured MCP tools.

The server currently covers:

- Campaign Manager 360
- Display & Video 360
- Bid Manager reporting for DV360
- Google Analytics 4 / Analytics 360
- Google Tag Manager 360
- Search Ads 360

## Verification

The server can be verified locally with the standard project checks. Live Google API testing requires valid credentials and product access.

Run:

```bash
npm run check
npm audit --omit=dev
```

Expected results:

- TypeScript passes.
- Tests pass.
- The server builds to `dist/index.js`.
- `npm audit` reports no known vulnerabilities.

## How The Server Works

The server starts as a local stdio MCP process. An MCP client launches it, the server authenticates to Google, and each MCP tool maps to a Google API call.

The rough flow is:

```text
MCP client
  -> gmp-mcp stdio server
  -> product-specific MCP tool
  -> Google auth client
  -> Google Marketing Platform REST API
  -> structured JSON result back to the MCP client
```

The entrypoint is `src/index.ts`. It creates one shared Google auth client and product-specific API clients for CM360, DV360, Bid Manager, GA4 Admin, GA4 Data, GTM, SA360 Reporting and legacy SA360 conversions.

## Design Principles

The server is designed around these rules:

- Read operations should be easy to call.
- Write operations should exist, but must be deliberate.
- Every live write must be previewed with `dryRun=true` first.
- The live request must exactly match an unexpired preview and each preview can be used once.
- Every live write must require `dryRun=false` and `confirm=true`.
- Product-level allowlists should reduce accidental blast radius.
- Product-native Google permissions remain the primary security boundary.
- Raw API tools should be disabled by default.
- Broad updates should be avoided when patch-style calls are available.
- Audit logs should capture every dry run and every live write request.

## Safety Model

Write-capable tools are registered by default, but live writes are blocked unless the server and the individual tool request both allow them.

A live write requires:

- A write flag enabled globally or for the relevant product.
- An exact matching dry-run preview created by the current server process within the previous 15 minutes.
- `dryRun=false`.
- `confirm=true`.

By default, write tools behave as previews. The dry-run response shows the request method, path, query and body that would be sent to Google, plus the preview expiry time. The server records a canonical digest of that request in memory. A changed payload, an expired preview, a reused preview or a server restart blocks live execution and requires a new dry run.

The intended usage pattern is:

1. Ask the assistant to prepare the change with `dryRun=true`.
2. Review the returned request payload.
3. Confirm the intended account, advertiser, campaign, property, container or customer.
4. Re-run the exact request with `dryRun=false` and `confirm=true` before the preview expires.
5. Review the audit log.

Example dry-run instruction to an assistant:

```text
Create a draft DV360 line item payload for advertiser 123 using dv360_create_line_item with dryRun=true. Do not execute the live write.
```

Example live-write instruction after review:

```text
Use the exact reviewed payload. Run dv360_create_line_item with dryRun=false and confirm=true.
```

## Write Flags

Global write enablement:

```bash
GMP_ENABLE_WRITES=false
```

Product-specific write enablement:

```bash
CM360_ENABLE_WRITES=false
DV360_ENABLE_WRITES=false
BID_MANAGER_ENABLE_WRITES=false
GA4_ENABLE_WRITES=false
GTM_ENABLE_WRITES=false
SA360_ENABLE_WRITES=false
```

Recommended production posture:

- Keep `GMP_ENABLE_WRITES=false`.
- Enable only the product surface being used.
- Use product allowlists before enabling any live writes.
- Keep publishing and conversion upload workflows especially restricted.

Example cautious DV360-only setup:

```bash
GMP_ENABLE_WRITES=false
DV360_ENABLE_WRITES=true
DV360_ALLOWED_ADVERTISER_IDS=123456
DV360_ALLOWED_CAMPAIGN_IDS=
DV360_ALLOWED_INSERTION_ORDER_IDS=
DV360_ALLOWED_LINE_ITEM_IDS=
```

Keep a child-resource allowlist empty while creating that type of resource because its Google-generated ID is not known in advance. After creation, add the returned ID to the allowlist and restart the MCP server before modifying it further.

## Raw Request Tools

Each product family has an escape-hatch raw request tool. These exist for endpoints that do not yet have a first-class MCP tool.

Raw request tools are disabled by default.

Global raw request enablement:

```bash
GMP_ENABLE_RAW_REQUEST=false
```

Product-specific raw request enablement:

```bash
CM360_ENABLE_RAW_REQUEST=false
DV360_ENABLE_RAW_REQUEST=false
BID_MANAGER_ENABLE_RAW_REQUEST=false
GA4_ENABLE_RAW_REQUEST=false
GTM_ENABLE_RAW_REQUEST=false
SA360_ENABLE_RAW_REQUEST=false
```

Use raw request tools only when:

- A required endpoint is missing from the first-class tools.
- You have checked the official Google API docs for the exact request shape.
- The actual request path contains every ID required by the configured allowlists.
- You are comfortable with the request being less guided than a first-class tool.

When an allowlist is configured, the server extracts target IDs from the canonical raw request path and validates those IDs directly. Optional metadata must match the path but is never accepted as proof of scope. A raw endpoint that does not expose a configured allowlist target in its path is blocked; add a first-class tool with endpoint-aware validation instead.

## Audit Logs

Dry runs, live write requests and live write completions are written to:

```bash
GMP_AUDIT_LOG_PATH=.gmp-mcp/audit.log
```

Each line is JSON. It includes:

- Timestamp.
- Product.
- Tool name.
- Relevant entity IDs.
- Request method.
- Request path.
- Redacted query parameters.
- Redacted request body.

The audit log is not a replacement for Google product audit logs. It is a local record of what the MCP server was asked to do. If the pre-request audit record cannot be written, the Google request is blocked. If Google succeeds but the completion record fails, the tool returns the confirmed Google result with an `audit_log_failed` warning instead of reporting the remote operation as failed.

## Allowlists

Allowlists are comma-separated ID lists. Empty means no MCP-level allowlist for that entity type.

```bash
CM360_ALLOWED_PROFILE_IDS=
CM360_ALLOWED_ADVERTISER_IDS=
CM360_ALLOWED_CAMPAIGN_IDS=
DV360_ALLOWED_PARTNER_IDS=
DV360_ALLOWED_ADVERTISER_IDS=
DV360_ALLOWED_CAMPAIGN_IDS=
DV360_ALLOWED_INSERTION_ORDER_IDS=
DV360_ALLOWED_LINE_ITEM_IDS=
BID_MANAGER_ALLOWED_QUERY_IDS=
GA4_ALLOWED_ACCOUNT_IDS=
GA4_ALLOWED_PROPERTY_IDS=
GTM_ALLOWED_ACCOUNT_IDS=
GTM_ALLOWED_CONTAINER_IDS=
SA360_ALLOWED_CUSTOMER_IDS=
```

How to use allowlists:

- Start by allowlisting one test advertiser, property, container, Bid Manager query or customer.
- Add more IDs only after read and dry-run workflows behave correctly.
- Keep high-risk production entities out of allowlists until the workflow is proven.
- Use Google product permissions as the real access boundary.
- Use MCP allowlists as a second check against mistakes.

Broad list behaviour:

When a more specific allowlist is configured, broad list tools that cannot constrain the Google API request to those exact child IDs are blocked. Use a get tool for a known allowed ID, or temporarily remove the allowlist during a controlled discovery step.

CM360 note:

CM360 object reads and patches verify the advertiser ID returned by Google instead of trusting caller metadata. Campaign-scoped tag and association tools verify the owning campaign when needed. Profile-level report and offline-conversion endpoints do not expose a reliably verifiable advertiser target, so those tools are blocked while `CM360_ALLOWED_ADVERTISER_IDS` is configured. Use CM360-native credential permissions as the boundary for those endpoints.

## Authentication Options

The server supports three authentication patterns.

### Option 1: Service Account

Use this for deployments where a shared Google identity is acceptable.

```bash
GMP_AUTH_MODE=service_account
GMP_SERVICE_ACCOUNT_KEY_FILE=/absolute/path/to/service-account.json
```

Things to check:

- The service account must have access to the relevant Google product.
- CM360 and DV360 access may require adding the service account as a product user where supported.
- GA4, GTM and SA360 permissions need to be granted in their own product/admin surfaces.
- Actions may appear as the service account unless product-level audit logs preserve more detail.

### Option 2: Domain-Wide Delegation

Use this when you operate inside a Google Workspace domain and want the service account to impersonate a user.

```bash
GMP_AUTH_MODE=service_account
GMP_SERVICE_ACCOUNT_KEY_FILE=/absolute/path/to/service-account.json
GMP_DELEGATED_SUBJECT=user@example.com
```

Things to check:

- Workspace admin approval is required.
- Scopes must be authorised for the service account client.
- The delegated user still needs access in the relevant product.
- This is powerful and should be used with strict allowlists.

### Option 3: Local OAuth Refresh Token

Use this when each local user should connect using their own Google identity.

```bash
GMP_AUTH_MODE=oauth
GMP_OAUTH_CLIENT_ID=your-client-id
GMP_OAUTH_CLIENT_SECRET=your-client-secret
GMP_OAUTH_REFRESH_TOKEN=your-refresh-token
```

Things to check:

- The OAuth client must be configured in Google Cloud.
- The refresh token must include the required scopes.
- Each user's Google identity controls what the server can access.
- This is usually the cleanest model for local Claude Code or Codex usage by individual users.

### Backwards Compatibility

The server still accepts the older `CM360_*` auth variables as fallbacks, but new setups should use `GMP_*`.

## OAuth Scopes

By default, the server uses a broad GMP scope set because it spans multiple product APIs:

```text
https://www.googleapis.com/auth/dfareporting
https://www.googleapis.com/auth/dfatrafficking
https://www.googleapis.com/auth/ddmconversions
https://www.googleapis.com/auth/display-video
https://www.googleapis.com/auth/doubleclickbidmanager
https://www.googleapis.com/auth/analytics.readonly
https://www.googleapis.com/auth/analytics.edit
https://www.googleapis.com/auth/tagmanager.readonly
https://www.googleapis.com/auth/tagmanager.edit.containers
https://www.googleapis.com/auth/tagmanager.edit.containerversions
https://www.googleapis.com/auth/tagmanager.manage.accounts
https://www.googleapis.com/auth/tagmanager.manage.users
https://www.googleapis.com/auth/tagmanager.publish
https://www.googleapis.com/auth/doubleclicksearch
```

For stricter deployments, set `GMP_SCOPES` to only the scopes needed by the products you are exposing, or split this MCP into product-specific servers with separate auth clients.

## Google Cloud Setup

Use this as a setup checklist.

1. Create or choose a Google Cloud project.
2. Enable the relevant APIs:
   - Campaign Manager 360 API.
   - Display & Video 360 API.
   - Bid Manager API.
   - Google Analytics Admin API.
   - Google Analytics Data API.
   - Google Tag Manager API.
   - Search Ads 360 Reporting API.
   - Legacy Search Ads 360 API if conversion tools are needed.
3. Configure OAuth consent if using OAuth.
4. Create OAuth credentials or a service account key.
5. Grant the chosen identity access inside each GMP product.
6. Start with read-only product permissions where possible.
7. Add write permissions only when dry-run workflows have been validated.
8. Configure `.env`.
9. Build and run the MCP server.
10. Test one read tool per product.
11. Test one dry-run write per intended product.
12. Enable live writes only after confirming allowlists and audit logging.

## Local Setup

Install dependencies:

```bash
npm install
```

Copy the environment example:

```bash
cp .env.example .env
```

Edit `.env` with the authentication method and operational flags.

Build the server:

```bash
npm run build
```

Run checks:

```bash
npm run check
npm audit --omit=dev
```

Start directly for local development:

```bash
npm run dev
```

Start the compiled server:

```bash
npm run start
```

In normal MCP usage, the MCP client launches the compiled server.

## MCP Client Configuration

Example local MCP configuration:

```json
{
  "mcpServers": {
    "gmp": {
      "command": "node",
      "args": ["/path/to/gmp-mcp/dist/index.js"],
      "env": {
        "GMP_AUTH_MODE": "service_account",
        "GMP_SERVICE_ACCOUNT_KEY_FILE": "/absolute/path/to/service-account.json",
        "GMP_ENABLE_WRITES": "false",
        "GMP_ENABLE_RAW_REQUEST": "false"
      }
    }
  }
}
```

Recommended first connection test:

```text
Use the GMP MCP server to list available CM360 user profiles, DV360 advertisers, GA4 account summaries, GTM accounts and SA360 field metadata. Do not run any write tools.
```

## Environment Variables

### Authentication

```bash
GMP_AUTH_MODE=auto
GMP_SCOPES=
GMP_SERVICE_ACCOUNT_KEY_FILE=
GMP_DELEGATED_SUBJECT=
GMP_OAUTH_CLIENT_ID=
GMP_OAUTH_CLIENT_SECRET=
GMP_OAUTH_REFRESH_TOKEN=
```

`GMP_AUTH_MODE` values:

- `auto`: choose OAuth if OAuth vars are present, otherwise service account if a key file is present, otherwise Application Default Credentials.
- `oauth`: require OAuth client ID, client secret and refresh token.
- `service_account`: require a service account key file.
- `application_default`: use Google Application Default Credentials.

`GMP_SCOPES` is optional. Leave it unset to use the default scope set for all supported products, or set a space- or comma-separated list to run a narrower product deployment.

### API Base URLs

These usually do not need to change.

```bash
GMP_ALLOW_UNSAFE_BASE_URLS=false
CM360_API_BASE_URL=https://dfareporting.googleapis.com/dfareporting/v5
DV360_API_BASE_URL=https://displayvideo.googleapis.com/v4
BID_MANAGER_API_BASE_URL=https://doubleclickbidmanager.googleapis.com/v2
GA4_ADMIN_API_BASE_URL=https://analyticsadmin.googleapis.com/v1beta
GA4_ADMIN_ALPHA_API_BASE_URL=https://analyticsadmin.googleapis.com/v1alpha
GA4_DATA_API_BASE_URL=https://analyticsdata.googleapis.com/v1beta
GTM_API_BASE_URL=https://tagmanager.googleapis.com/tagmanager/v2
SA360_API_BASE_URL=https://searchads360.googleapis.com/v0
SA360_LEGACY_API_BASE_URL=https://www.googleapis.com/doubleclicksearch/v2
```

By default, base URLs must use HTTPS and point to the expected Google API hosts. `GMP_ALLOW_UNSAFE_BASE_URLS=true` is available for local mocks or controlled test infrastructure only.

### Rate Limits And Retries

```bash
GMP_REQUESTS_PER_SECOND=1
GMP_MAX_RETRIES=3
GMP_REQUEST_TIMEOUT_MS=60000
```

The default rate is conservative. GMP APIs have different quotas and enforcement behaviour, and assistants can accidentally generate bursts if not constrained.

Increase cautiously only after checking the product quota and observing real usage.

### Downloads

```bash
GMP_DOWNLOAD_DIR=.gmp-mcp/downloads
GMP_MAX_DOWNLOAD_BYTES=100000000
```

Report downloads are written here. The tool response includes:

- File path.
- Size in bytes.
- A small preview.

Report URL downloads are restricted to trusted Google download hosts and HTTPS. Large downloads are blocked when they exceed `GMP_MAX_DOWNLOAD_BYTES`.

## First Run Checklist

Use this checklist before enabling live writes:

1. Confirm `.env` does not contain credentials that should be shared.
2. Confirm `GMP_ENABLE_WRITES=false`.
3. Confirm all product write flags are false.
4. Confirm all raw request flags are false.
5. Run `npm run build`.
6. Add the server to an MCP client.
7. Test read calls only.
8. Add one low-risk allowlist entry.
9. Run one write tool with `dryRun=true`.
10. Inspect `.gmp-mcp/audit.log`.
11. Confirm the dry-run payload is correct.
12. Enable the product-specific write flag.
13. Within 15 minutes, run the exact same request with `dryRun=false` and `confirm=true`.
14. Inspect the product UI and product audit logs.
15. Disable writes again when live write access is no longer needed.

## Product Workflows

### Campaign Manager 360

Use CM360 tools for ad serving, trafficking objects, Floodlight, reports and offline conversion uploads.

Recommended discovery flow:

1. `cm360_list_user_profiles`
2. `cm360_list_advertisers`
3. `cm360_list_campaigns`
4. `cm360_get_campaign`
5. `cm360_list_placements`
6. `cm360_list_ads`
7. `cm360_list_creatives`
8. `cm360_list_floodlight_activities`

Recommended reporting flow:

These profile-level report tools require `CM360_ALLOWED_ADVERTISER_IDS` to be empty because CM360 does not provide a reliable advertiser target for pre-request validation.

1. `cm360_list_reports`
2. `cm360_get_report`
3. `cm360_run_report`
4. `cm360_get_report_file_status`
5. `cm360_download_report_file`

Recommended campaign creation flow:

1. Read the advertiser and any similar campaign.
2. Prepare a campaign payload.
3. Call `cm360_create_campaign` with `dryRun=true`.
4. Review the request body.
5. Re-run with `dryRun=false` and `confirm=true`.
6. Use `cm360_get_campaign` to verify.
7. Add placements, ads and creatives through their own dry-run-first flow.

CM360 tool groups:

- Profiles: `cm360_list_user_profiles`, `cm360_get_user_profile`
- Advertisers: `cm360_list_advertisers`, `cm360_get_advertiser`
- Campaigns: `cm360_list_campaigns`, `cm360_get_campaign`, `cm360_create_campaign`, `cm360_patch_campaign`
- Placements: `cm360_list_placements`, `cm360_get_placement`, `cm360_create_placement`, `cm360_patch_placement`, `cm360_generate_placement_tags`
- Ads: `cm360_list_ads`, `cm360_get_ad`, `cm360_create_ad`, `cm360_patch_ad`
- Creatives: `cm360_list_creatives`, `cm360_get_creative`, `cm360_create_creative`, `cm360_patch_creative`, `cm360_associate_creative_to_campaign`
- Floodlight: `cm360_list_floodlight_activities`, `cm360_get_floodlight_activity`, `cm360_create_floodlight_activity`, `cm360_patch_floodlight_activity`
- Reports: `cm360_list_reports`, `cm360_get_report`, `cm360_create_report`, `cm360_run_report`, `cm360_list_report_files`, `cm360_get_report_file_status`, `cm360_download_report_file`
- Conversions: `cm360_upload_offline_conversions`
- Advanced: `cm360_api_request`

### Display & Video 360

Use DV360 tools for programmatic buying objects, targeting and line item operations.

Recommended discovery flow:

1. `dv360_list_partners`
2. `dv360_list_advertisers`
3. `dv360_get_advertiser`
4. `dv360_list_campaigns`
5. `dv360_list_insertion_orders`
6. `dv360_list_line_items`
7. `dv360_list_creatives`

Recommended campaign setup flow:

1. Choose one allowed advertiser.
2. Read a similar campaign, insertion order and line item.
3. Create a campaign with `dv360_create_campaign` and `dryRun=true`.
4. Create an insertion order with `dv360_create_insertion_order` and `dryRun=true`.
5. Create a line item with `dv360_create_line_item` and `dryRun=true`.
6. Review budgets, pacing, flight dates, bid strategy and targeting carefully.
7. Execute each write one at a time with `dryRun=false` and `confirm=true`.
8. Verify each created object with its matching `get` tool.

Recommended targeting flow:

1. Use `dv360_list_targeting_options` to inspect allowed targeting values.
2. Use `dv360_list_assigned_targeting_options` to inspect current targeting.
3. Use `dv360_assign_targeting_option` for line item targeting. Google has sunset campaign and insertion-order assigned-targeting resources.
4. Use `dv360_bulk_edit_line_item_targeting` for broader line item targeting changes.
5. Keep all targeting mutations dry-run-first.

DV360 tool groups:

- Partners: `dv360_list_partners`, `dv360_get_partner`
- Advertisers: `dv360_list_advertisers`, `dv360_get_advertiser`
- Campaigns: `dv360_list_campaigns`, `dv360_get_campaign`, `dv360_create_campaign`, `dv360_patch_campaign`
- Insertion orders: `dv360_list_insertion_orders`, `dv360_get_insertion_order`, `dv360_create_insertion_order`, `dv360_patch_insertion_order`
- Line items: `dv360_list_line_items`, `dv360_get_line_item`, `dv360_create_line_item`, `dv360_patch_line_item`, `dv360_duplicate_line_item`, `dv360_bulk_update_line_items`
- Creatives: `dv360_list_creatives`, `dv360_get_creative`, `dv360_create_creative`, `dv360_patch_creative`
- Targeting: `dv360_list_targeting_options`, `dv360_list_assigned_targeting_options`, `dv360_bulk_list_line_item_assigned_targeting_options`, `dv360_assign_targeting_option`, `dv360_edit_advertiser_targeting_options`, `dv360_bulk_edit_line_item_targeting`
- Advanced: `dv360_api_request`

### Bid Manager Reporting

Use Bid Manager tools for DV360 reporting workflows.

Recommended report flow:

1. `bidmanager_list_queries`
2. `bidmanager_get_query`
3. `bidmanager_create_query` with `dryRun=true` if a new query is needed.
4. `bidmanager_run_query`
5. `bidmanager_list_reports`
6. `bidmanager_get_report`
7. `bidmanager_download_report_url`

Bid Manager tool groups:

- Queries: `bidmanager_list_queries`, `bidmanager_get_query`, `bidmanager_create_query`, `bidmanager_run_query`
- Reports: `bidmanager_list_reports`, `bidmanager_get_report`, `bidmanager_download_report_url`
- Advanced: `bidmanager_api_request`

### GA4 / Analytics 360

Use GA4 tools for analytics property discovery, Admin API configuration and Data API reporting.

Recommended discovery flow:

1. `ga4_list_account_summaries`
2. `ga4_list_accounts`
3. `ga4_get_account`
4. `ga4_list_properties`
5. `ga4_get_property`
6. `ga4_list_data_streams`

Recommended reporting flow:

1. `ga4_get_metadata`
2. `ga4_run_report`
3. `ga4_batch_run_reports` if multiple related reports are needed.
4. `ga4_run_realtime_report` for current activity.

Recommended configuration flow:

1. Read the property with `ga4_get_property`.
2. Inspect current custom dimensions, metrics, key events and audiences.
3. Prepare the config payload.
4. Run the create or patch tool with `dryRun=true`.
5. Review names, scope, event names and update masks.
6. Re-run with `dryRun=false` and `confirm=true`.

GA4 tool groups:

- Accounts: `ga4_list_account_summaries`, `ga4_list_accounts`, `ga4_get_account`
- Properties: `ga4_list_properties`, `ga4_get_property`, `ga4_patch_property`
- Data streams: `ga4_list_data_streams`, `ga4_get_data_stream`, `ga4_create_data_stream`, `ga4_patch_data_stream`
- Custom dimensions: `ga4_list_custom_dimensions`, `ga4_get_custom_dimension`, `ga4_create_custom_dimension`, `ga4_patch_custom_dimension`, `ga4_archive_custom_dimension`
- Custom metrics: `ga4_list_custom_metrics`, `ga4_get_custom_metric`, `ga4_create_custom_metric`, `ga4_patch_custom_metric`, `ga4_archive_custom_metric`
- Key events: `ga4_list_key_events`, `ga4_get_key_event`, `ga4_create_key_event`, `ga4_patch_key_event`
- Legacy conversion events: `ga4_list_conversion_events`, `ga4_get_conversion_event`, `ga4_create_conversion_event`, `ga4_patch_conversion_event`. Google has deprecated these methods; use key event tools for new integrations.
- Audiences: `ga4_list_audiences`, `ga4_get_audience`, `ga4_create_audience`, `ga4_patch_audience`
- Reporting: `ga4_get_metadata`, `ga4_run_report`, `ga4_batch_run_reports`, `ga4_run_realtime_report`
- Advanced: `ga4_api_request`

### Google Tag Manager 360

Use GTM tools for tag governance, workspace changes, version creation and publishing.

Recommended safe GTM workflow:

1. `gtm_list_accounts`
2. `gtm_list_containers`
3. `gtm_list_workspaces`
4. Create a new workspace with `gtm_create_workspace`.
5. Read existing tags, triggers and variables.
6. Create or update tags, triggers and variables in the workspace with `dryRun=true`.
7. Run `gtm_sync_workspace` before creating a version.
8. Run `gtm_quick_preview_workspace` if preview is required.
9. Run `gtm_create_version`.
10. Review the created version.
11. Publish with `gtm_publish_version` only after explicit approval.

GTM publishing is externally visible. Treat `gtm_publish_version` as one of the highest-risk tools in this server.

GTM tool groups:

- Accounts: `gtm_list_accounts`, `gtm_get_account`
- Containers: `gtm_list_containers`, `gtm_get_container`
- Workspaces: `gtm_list_workspaces`, `gtm_create_workspace`, `gtm_sync_workspace`, `gtm_quick_preview_workspace`
- Tags: `gtm_list_tags`, `gtm_get_tag`, `gtm_create_tag`, `gtm_update_tag`
- Triggers: `gtm_list_triggers`, `gtm_get_trigger`, `gtm_create_trigger`, `gtm_update_trigger`
- Variables: `gtm_list_variables`, `gtm_get_variable`, `gtm_create_variable`, `gtm_update_variable`
- Folders: `gtm_list_folders`, `gtm_get_folder`
- Versions: `gtm_list_versions`, `gtm_get_version`, `gtm_create_version`, `gtm_publish_version`
- Advanced: `gtm_api_request`

### Search Ads 360

Use SA360 tools primarily for reporting and conversion workflows.

The modern Search Ads 360 API is reporting-focused. This server does not expose broad SA360 trafficking write tools as first-class operations.

Recommended reporting flow:

1. Use `sa360_search_fields` to discover valid fields.
2. Use `sa360_get_field` for details on a specific field.
3. Build a Search Ads 360 Query Language query.
4. Run `sa360_search`.
5. Use `sa360_search_stream` only when the query is expected to return a large result set.

Recommended conversion flow:

1. Use `sa360_get_conversions_by_customer` to inspect existing conversion records where appropriate.
2. Prepare the conversion insert or update payload.
3. Run `sa360_insert_conversions` or `sa360_update_conversions` with `dryRun=true`.
4. Review the payload against the legacy Search Ads 360 conversion docs.
5. Re-run with `dryRun=false` and `confirm=true`.

SA360 tool groups:

- Reporting: `sa360_search`, `sa360_search_stream`
- Field metadata: `sa360_search_fields`, `sa360_get_field`
- Custom columns: `sa360_list_custom_columns`, `sa360_get_custom_column`
- Conversions: `sa360_get_conversions_by_customer`, `sa360_insert_conversions`, `sa360_update_conversions`
- Advanced: `sa360_api_request`

## Assistant Usage Guidelines

When asking an assistant to use this MCP server, give constraints clearly.

Good prompt for read-only investigation:

```text
Use the GMP MCP server to inspect DV360 advertiser 123. List campaigns, insertion orders and line items. Do not call any write tools.
```

Good prompt for a dry-run write:

```text
Prepare a GTM tag update in workspace 456. Use dryRun=true and show me the exact request body. Do not publish anything.
```

Good prompt for a live write after review:

```text
Use the exact dry-run payload I approved. Run gtm_update_tag with dryRun=false and confirm=true. Do not publish the container version.
```

Good prompt for reporting:

```text
Run a GA4 report for property 123 using sessions and totalUsers by date for the last 7 days. Use ga4_get_metadata first if you need to confirm valid field names.
```

Avoid prompts like:

```text
Fix all campaigns.
```

Instead, specify:

- Product.
- Account or advertiser.
- Exact object type.
- Read-only or write intent.
- Whether dry runs are required.
- Whether publishing or uploads are explicitly forbidden.

## Troubleshooting

### The server starts but tools fail with 401 or 403

Check:

- The credential file path is correct.
- The OAuth refresh token is valid.
- The required API is enabled in Google Cloud.
- The authenticated identity has access inside the relevant GMP product.
- The delegated subject has product access if using domain-wide delegation.
- The requested scope is included and approved.

### Write tools return a safety error

Check:

- The relevant write flag is enabled.
- An identical `dryRun=true` request completed in the current server process within the previous 15 minutes.
- The tool call includes `dryRun=false`.
- The tool call includes `confirm=true`.
- The target ID is in the relevant allowlist.

### Raw request tools return disabled errors

Check:

- `GMP_ENABLE_RAW_REQUEST=true`, or
- The relevant product-specific raw flag is true.

Prefer adding a first-class tool before relying on raw requests for repeated workflows.

### Reports do not download

Check:

- The report has finished generating.
- The report URL or file ID is correct.
- `GMP_DOWNLOAD_DIR` is writable.
- The authenticated identity has access to the report.

### GTM publish fails

Check:

- The container version exists.
- The fingerprint is current if supplied.
- The account has publish permission.
- The workspace has been synced.
- There are no unresolved workspace conflicts.

### SA360 queries fail

Check:

- The customer ID is correct.
- The query uses valid Search Ads 360 fields.
- `sa360_search_fields` confirms the field names.
- The authenticated identity has access to the customer.

## Production Hardening Checklist

Before using this server with production accounts:

1. Decide whether the deployment is local per user or shared.
2. Prefer per-user OAuth for attribution where practical.
3. Use service accounts only when the operational model is clear.
4. Keep `GMP_ENABLE_WRITES=false` by default.
5. Enable only product-specific write flags.
6. Configure allowlists for every product being used.
7. Keep raw request tools disabled.
8. Store credentials outside the repo.
9. Rotate credentials according to your organisation's policy.
10. Centralise audit logs if this becomes a team service.
11. Add product-specific integration tests against low-risk test entities.
12. Document approved workflows for users.
13. Add approval steps for publish, conversion upload and budget-affecting workflows.
14. Monitor Google API quota and error rates.
15. Review new Google API versions before changing base URLs.
16. Consider whether MCP-driven writes are appropriate for your use case — the speed and automation that make this server useful also mean mistakes can propagate quickly across live accounts.

## Development Notes

Project scripts:

```bash
npm run dev
npm run check
npm run typecheck
npm test
npm run build
npm run start
```

Important files:

- `src/index.ts`: server entrypoint and product client wiring.
- `src/config.ts`: environment config, scopes, base URLs and allowlists.
- `src/safety.ts`: dry-run, confirmation, write flags, allowlists and audit logging.
- `src/googleApiClient.ts`: shared Google REST client.
- `src/http.ts`: bounded response streaming for report downloads.
- `src/tools.ts`: CM360 tools.
- `src/dv360Tools.ts`: DV360 and Bid Manager tools.
- `src/ga4Tools.ts`: GA4 Admin and Data API tools.
- `src/gtmTools.ts`: GTM tools.
- `src/sa360Tools.ts`: SA360 tools.

GitHub Actions runs `npm ci`, the full project check, a production dependency audit and an npm package inspection for pushes to `main` and pull requests.

## Official References

- CM360 REST API v5: https://developers.google.com/doubleclick-advertisers/rest/v5
- DV360 API: https://developers.google.com/display-video/api/reference/rest
- Bid Manager API: https://developers.google.com/bid-manager/reference/rest
- Analytics Admin API: https://developers.google.com/analytics/devguides/config/admin/v1
- Analytics Data API: https://developers.google.com/analytics/devguides/reporting/data/v1
- Google Tag Manager API: https://developers.google.com/tag-platform/tag-manager/api/v2
- Search Ads 360 Reporting API: https://developers.google.com/search-ads/reporting/api/reference/rest
- Legacy Search Ads 360 API: https://developers.google.com/search-ads/v2

## License

Released under the [MIT License](LICENSE). The software is provided "as is", without warranty of any kind. You are responsible for how you use it against your own Google Marketing Platform accounts, including all write operations.
