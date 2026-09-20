// Provider registry. Client ids / secrets come from env; a CRM whose env is missing answers E_NOT_CONFIGURED on connect
// and is left alone by the sync worker. Nothing else depends on it.
import { hubspotProvider } from "./hubspot.ts";
import { pipedriveProvider } from "./pipedrive.ts";
import { salesforceProvider } from "./salesforce.ts";
import type { CrmProvider, FetchLike, ProviderName } from "./types.ts";

export * from "./types.ts";

const ENV_PREFIX: Record<ProviderName, string> = { hubspot: "HUBSPOT", pipedrive: "PIPEDRIVE", salesforce: "SALESFORCE" };

export function isProviderName(v: unknown): v is ProviderName {
  return v === "hubspot" || v === "pipedrive" || v === "salesforce";
}

/** A fresh provider per integration and run: providers keep small per-account caches (Pipedrive field keys). */
export function getProvider(name: ProviderName, fetchFn?: FetchLike): CrmProvider {
  const p = ENV_PREFIX[name];
  const env = {
    clientId: Deno.env.get(`${p}_CLIENT_ID`) ?? "",
    clientSecret: Deno.env.get(`${p}_CLIENT_SECRET`) ?? "",
    fetch: fetchFn,
    extra: {
      tokenUrl: Deno.env.get("HUBSPOT_TOKEN_URL"),              // optional override of https://api.hubspot.com/oauth/v3/token
      loginUrl: Deno.env.get("SALESFORCE_LOGIN_URL"),           // optional: https://test.salesforce.com for sandboxes
      apiVersion: Deno.env.get("SALESFORCE_API_VERSION"),       // optional: defaults to v62.0
    },
  };
  return name === "hubspot" ? hubspotProvider(env) : name === "pipedrive" ? pipedriveProvider(env) : salesforceProvider(env);
}

export function notConfiguredMessage(name: ProviderName): string {
  const p = ENV_PREFIX[name];
  return `${name[0].toUpperCase()}${name.slice(1)} is not enabled on this platform yet. The operator has to set ${p}_CLIENT_ID and ${p}_CLIENT_SECRET.`;
}
