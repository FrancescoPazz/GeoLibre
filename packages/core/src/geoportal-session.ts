import { getRuntimeEnvironment } from "./runtime-env";

/**
 * A geoportal's own sign-in: service credentials checked against a
 * GeoServer endpoint, giving a *profile* (the user's group) that the
 * catalog, the feature popups and the query tools consult, and an
 * `Authorization` header the protected services are asked with.
 *
 * This is not GeoLibre's app-level auth gate (Clerk/Auth0), which decides
 * who may open the app at all. It is the old geoportal's login: a Basic
 * header sent to `LOGIN_SERVICE_URL` — a GeoServer REST resource the user
 * must be allowed to read — whose XML answer may name the user's group.
 * The session lives in memory only, as it did there: a reload signs out.
 */

/** What a profile may do, as the deployment defines it (`USER_PROFILES`). */
export interface GeoportalProfileDefinition {
  /** Feature names the profile is allowed (`QueryData`, `DownloadQueryData`, ...). */
  allowed: string[];
  /** An administrator sees every field and every feature. */
  isAdmin: boolean;
}

export interface GeoportalSession {
  username: string | null;
  /** The `Authorization` header value the protected services are asked with. */
  authorization: string | null;
  /** The user's group, from the login answer; null when signed out or when the answer named none. */
  profile: string | null;
}

export interface GeoportalLoginConfig {
  /** The GeoServer resource the credentials are checked against; `<username>` is substituted. */
  url: string;
}

const SIGNED_OUT: GeoportalSession = { username: null, authorization: null, profile: null };

let session: GeoportalSession = SIGNED_OUT;
const listeners = new Set<() => void>();

export function getGeoportalSession(): GeoportalSession {
  return session;
}

export function subscribeGeoportalSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: GeoportalSession): void {
  session = next;
  for (const listener of listeners) listener();
}

export function signOutGeoportal(): void {
  if (session === SIGNED_OUT) return;
  publish(SIGNED_OUT);
}

/** Whether a user is signed in. */
export function isGeoportalAuthenticated(): boolean {
  return session.authorization !== null;
}

/**
 * The deployment's login endpoint (`VITE_LOGIN_SERVICE_URL` / `LOGIN_SERVICE_URL`),
 * or undefined when it has none — in which case there is nothing to sign
 * in to and the sign-in surfaces stay hidden.
 */
export function getGeoportalLoginConfig(
  env?: Record<string, string | undefined>,
): GeoportalLoginConfig | undefined {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const raw = (runtimeEnv.VITE_LOGIN_SERVICE_URL ?? runtimeEnv.LOGIN_SERVICE_URL)?.trim();
  if (!raw) return undefined;
  try {
    const { protocol } = new URL(raw);
    return protocol === "https:" || protocol === "http:" ? { url: raw } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The profile definitions (`VITE_USER_PROFILES` / `USER_PROFILES`), a JSON
 * object of profile name → `{ allowed: [...], isAdmin }`. Empty when unset
 * or malformed; a malformed value is reported once rather than every call.
 */
let warnedProfiles: string | null = null;
export function getGeoportalProfiles(
  env?: Record<string, string | undefined>,
): Record<string, GeoportalProfileDefinition> {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const raw = (runtimeEnv.VITE_USER_PROFILES ?? runtimeEnv.USER_PROFILES)?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    const out: Record<string, GeoportalProfileDefinition> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      out[name] = {
        allowed: Array.isArray(v.allowed)
          ? v.allowed.filter((a): a is string => typeof a === "string")
          : [],
        isAdmin: v.isAdmin === true,
      };
    }
    return out;
  } catch (error) {
    if (warnedProfiles !== raw) {
      warnedProfiles = raw;
      console.warn("[GeoLibre] USER_PROFILES is not a JSON object of profiles; ignoring.", error);
    }
    return {};
  }
}

/** The signed-in user's profile definition, if the deployment defines one for their group. */
export function getGeoportalProfile(
  env?: Record<string, string | undefined>,
): GeoportalProfileDefinition | undefined {
  return session.profile ? getGeoportalProfiles(env)[session.profile] : undefined;
}

/**
 * Whether the signed-in user may use `feature` (`QueryData`, say). With no
 * profile definitions configured everything is allowed; with them, only a
 * signed-in user whose profile lists the feature — or an administrator.
 */
export function isFeatureAllowedByProfile(
  feature: string,
  env?: Record<string, string | undefined>,
): boolean {
  const profiles = getGeoportalProfiles(env);
  if (Object.keys(profiles).length === 0) return true;
  const profile = session.profile ? profiles[session.profile] : undefined;
  if (!profile) return false;
  return profile.isAdmin || profile.allowed.includes(feature);
}

/**
 * Whether the user may open a catalog member restricted to `allowedGroups`.
 * No restriction means public; otherwise the user must be signed in and
 * their group listed.
 */
export function canAccessGroups(allowedGroups: readonly string[] | undefined): boolean {
  if (allowedGroups === undefined) return true;
  return (
    session.authorization !== null &&
    session.profile !== null &&
    allowedGroups.includes(session.profile)
  );
}

/** `Basic` authorization for the credentials, UTF-8 safe. */
export function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/** The first `<group>` element's text in a GeoServer XML answer, if any. */
export function parseFirstGroup(xml: string): string | null {
  const match = /<(?:[\w-]+:)?group\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?group>/i.exec(xml);
  const name = match?.[1].replace(/<[^>]*>/g, "").trim();
  return name || null;
}

export type GeoportalLoginFailure = "invalid-credentials" | "connection" | "generic";

export class GeoportalLoginError extends Error {
  constructor(
    public readonly reason: GeoportalLoginFailure,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "GeoportalLoginError";
  }
}

/**
 * Sign in: ask the login resource with the credentials as a Basic header.
 * A 2xx answer signs the user in, with the first `<group>` of the answer as
 * their profile; 401/403 is "invalid credentials", a network failure is
 * "connection", anything else "generic". The session is published on
 * success and left untouched on failure.
 */
export async function signInGeoportal(
  config: GeoportalLoginConfig,
  username: string,
  password: string,
  fetchImpl: typeof globalThis.fetch = fetch,
  signal?: AbortSignal,
): Promise<GeoportalSession> {
  const authorization = basicAuthorization(username, password);
  const url = config.url.includes("<username>")
    ? config.url.replace("<username>", encodeURIComponent(username))
    : config.url;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal,
      headers: {
        Authorization: authorization,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new GeoportalLoginError(
      "connection",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new GeoportalLoginError("invalid-credentials", `HTTP ${response.status}`);
  }
  if (!response.ok) throw new GeoportalLoginError("generic", `HTTP ${response.status}`);
  const text = await response.text();
  const next: GeoportalSession = { username, authorization, profile: parseFirstGroup(text) };
  publish(next);
  return next;
}

/** Sign in without a service round-trip (tests, or a host with its own login). */
export function setGeoportalSession(next: GeoportalSession): void {
  publish(next);
}
