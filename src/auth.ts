import { readFile } from "node:fs/promises";
import { GoogleAuth, JWT, OAuth2Client } from "google-auth-library";

import type { ServerConfig } from "./config.js";

interface AccessTokenResponse {
  token?: string | null;
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string | AccessTokenResponse | null | undefined>;
}

interface ServiceAccountKey {
  client_email?: string;
  private_key?: string;
}

export async function createAuthClient(config: ServerConfig): Promise<AccessTokenProvider> {
  if (shouldUseOAuth(config)) {
    return createOAuthClient(config);
  }

  if (shouldUseServiceAccount(config)) {
    return createServiceAccountClient(config);
  }

  const auth = new GoogleAuth({
    scopes: config.scopes
  });

  return auth.getClient() as Promise<AccessTokenProvider>;
}

export async function getAccessToken(authClient: AccessTokenProvider): Promise<string> {
  const response = await authClient.getAccessToken();
  const token = typeof response === "string" ? response : response?.token;

  if (!token) {
    throw new Error("Google authentication did not return an access token.");
  }

  return token;
}

function shouldUseOAuth(config: ServerConfig): boolean {
  return (
    config.authMode === "oauth" ||
    (config.authMode === "auto" &&
      Boolean(config.oauthClientId && config.oauthClientSecret && config.oauthRefreshToken))
  );
}

function shouldUseServiceAccount(config: ServerConfig): boolean {
  return (
    config.authMode === "service_account" ||
    (config.authMode === "auto" && Boolean(config.serviceAccountKeyFile))
  );
}

function createOAuthClient(config: ServerConfig): OAuth2Client {
  if (!config.oauthClientId || !config.oauthClientSecret || !config.oauthRefreshToken) {
    throw new Error(
      "OAuth auth mode requires GMP_OAUTH_CLIENT_ID, GMP_OAUTH_CLIENT_SECRET and GMP_OAUTH_REFRESH_TOKEN."
    );
  }

  const client = new OAuth2Client(config.oauthClientId, config.oauthClientSecret);
  client.setCredentials({ refresh_token: config.oauthRefreshToken });
  return client;
}

async function createServiceAccountClient(config: ServerConfig): Promise<JWT> {
  if (!config.serviceAccountKeyFile) {
    throw new Error("Service account auth mode requires GMP_SERVICE_ACCOUNT_KEY_FILE.");
  }

  const rawKey = await readFile(config.serviceAccountKeyFile, "utf8");
  const key = JSON.parse(rawKey) as ServiceAccountKey;

  if (!key.client_email || !key.private_key) {
    throw new Error("Service account key file is missing client_email or private_key.");
  }

  return new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: config.scopes,
    subject: config.delegatedSubject
  });
}
