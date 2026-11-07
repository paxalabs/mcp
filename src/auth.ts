// Sign in with Paxa: the device flow (RFC 8628) against paxalabs.com, so a user approves this machine in the
// browser instead of pasting an API key. The tokens live in one file per user, readable by that user only, and
// every server process and `paxa say` on the machine share it. An access token lasts an hour. Each refresh hands
// out a new refresh token, and presenting a used one revokes the whole sign-in, so a refresh holds a lock file
// and re-reads the file first: whichever process refreshes, the others pick up its tokens.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { PaxaApiError } from "./api.js";
import { MISSING_KEY_MESSAGE } from "./config.js";

const AUTH_ORIGIN = "https://paxalabs.com";
/** This server's app in Sign in with Paxa: a device app, so public and without a secret. */
const CLIENT_ID = "KrvrBisZtZCnQqrvCKrKwDujUEBstUXz";
/** The audience of the access tokens: the only API a sign-in works with. */
export const SIGN_IN_API = "https://api.paxalabs.com";
/** api reaches the API, offline_access brings a refresh token, openid and email let userinfo name the account. */
const SCOPE = "api offline_access openid email";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** Refresh this long before an access token lapses, so no request leaves with one about to expire. */
const EXPIRY_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** A lock older than this was left by a process that died mid-refresh. */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 45_000;

export const SIGNED_OUT_MESSAGE =
  "The Paxa sign-in on this machine has ended: it was signed out, disconnected under API keys at " +
  "https://paxalabs.com/app/keys, or unused for 30 days. Call the sign_in tool (or run " +
  "`npx -y @paxalabs/mcp login` in a terminal) to connect again.";
const EXPIRED_MESSAGE = "The sign-in code expired before it was approved. Start the sign-in again.";

export interface StoredAuth {
  client_id: string;
  access_token: string;
  /** Milliseconds since the epoch. */
  expires_at: number;
  refresh_token: string;
  /** The account's email, from userinfo at sign-in. */
  email?: string;
}

/** Where the sign-in is kept, in each platform's per-user config directory. */
export function authFile(): string {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "paxa", "auth.json");
    case "win32":
      return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "paxa", "auth.json");
    default:
      return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "paxa", "auth.json");
  }
}

/** The sign-in on this machine, or undefined when there is none (or it was made for another app). */
export function readStoredAuth(): StoredAuth | undefined {
  try {
    const auth = JSON.parse(readFileSync(authFile(), "utf8")) as Partial<StoredAuth>;
    if (
      auth.client_id !== CLIENT_ID ||
      typeof auth.access_token !== "string" ||
      typeof auth.refresh_token !== "string" ||
      typeof auth.expires_at !== "number"
    ) {
      return undefined;
    }
    return auth as StoredAuth;
  } catch {
    return undefined;
  }
}

function writeStoredAuth(auth: StoredAuth): void {
  const file = authFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, file);
}

function clearStoredAuth(): void {
  rmSync(authFile(), { force: true });
}

/** Wait ms. An unref'd wait never keeps the process alive on its own. */
function sleep(ms: number, unref = false): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (unref) timer.unref();
  });
}

function lockOwner(lock: string): string | undefined {
  try {
    return readFileSync(lock, "utf8");
  } catch {
    return undefined;
  }
}

/** Run fn while holding the lock file next to the sign-in, so one process at a time writes it. */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = authFile() + ".lock";
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const owner = `${process.pid} ${randomUUID()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(lock, owner, { flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // A holder that died mid-refresh leaves its lock behind. Remove it only while it still names the owner read
      // as stale, so a lock another waiter has just taken over survives.
      const seen = lockOwner(lock);
      const held = statSync(lock, { throwIfNoEntry: false });
      if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS && lockOwner(lock) === seen) {
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for another Paxa process to refresh the sign-in. If none is running, delete ${lock}.`);
      }
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    if (lockOwner(lock) === owner) rmSync(lock, { force: true });
  }
}

async function postForm(path: string, fields: Record<string, string>): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(AUTH_ORIGIN + path, {
      method: "POST",
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach ${AUTH_ORIGIN} for the sign-in: ${cause}. Check this machine's internet connection.`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body };
}

function oauthFailure(body: Record<string, unknown>, status: number): string {
  const described = body.error_description ?? body.error;
  return typeof described === "string" ? described : `HTTP ${status}`;
}

/** The account's email from the userinfo endpoint, which the access token's audience covers. Only a label, so a failure leaves it out. */
async function accountEmail(accessToken: unknown): Promise<string | undefined> {
  if (typeof accessToken !== "string") return undefined;
  try {
    const res = await fetch(AUTH_ORIGIN + "/api/auth/oauth2/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const info = (await res.json()) as { email?: unknown };
    return res.ok && typeof info.email === "string" ? info.email : undefined;
  } catch {
    return undefined;
  }
}

function toStoredAuth(tokens: Record<string, unknown>, email: string | undefined): StoredAuth {
  const { access_token, refresh_token, expires_in } = tokens;
  if (typeof access_token !== "string" || typeof refresh_token !== "string" || typeof expires_in !== "number") {
    throw new Error("The Paxa sign-in answered without the tokens it should send. Try again, and report it at https://github.com/paxalabs/mcp/issues if it keeps failing.");
  }
  return {
    client_id: CLIENT_ID,
    access_token,
    expires_at: Date.now() + expires_in * 1000,
    refresh_token,
    email,
  };
}

/** Refresh the stored sign-in under the lock, unless another process already did while this one waited. */
function refreshStoredAuth(stale: string): Promise<string> {
  return withLock(async () => {
    const auth = readStoredAuth();
    if (!auth) throw new Error(MISSING_KEY_MESSAGE);
    if (auth.access_token !== stale && auth.expires_at - EXPIRY_MARGIN_MS > Date.now()) return auth.access_token;
    const { ok, status, body } = await postForm("/api/auth/oauth2/token", {
      grant_type: "refresh_token",
      refresh_token: auth.refresh_token,
      client_id: CLIENT_ID,
    });
    if (!ok) {
      if (body.error === "invalid_grant") {
        clearStoredAuth();
        throw new Error(SIGNED_OUT_MESSAGE);
      }
      throw new Error(`Could not refresh the Paxa sign-in: ${oauthFailure(body, status)}.`);
    }
    const next = toStoredAuth(body, auth.email);
    writeStoredAuth(next);
    return next.access_token;
  });
}

/** Where requests get their bearer: the API key when one is configured, else the sign-in on this machine. */
export class Credentials {
  private refreshing: Promise<string> | undefined;

  constructor(readonly apiKey: string | undefined) {}

  /** The bearer for the next request. Read from the file on every call, so a sign-in made elsewhere applies at once. */
  async token(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    const auth = readStoredAuth();
    if (!auth) throw new Error(MISSING_KEY_MESSAGE);
    if (auth.expires_at - EXPIRY_MARGIN_MS > Date.now()) return auth.access_token;
    return this.refresh(auth.access_token);
  }

  /** A new token after the API refused `refused` before it expired, or undefined when there is no sign-in to renew. */
  async renew(refused: string): Promise<string | undefined> {
    if (this.apiKey || !readStoredAuth()) return undefined;
    return this.refresh(refused);
  }

  private refresh(stale: string): Promise<string> {
    this.refreshing ??= refreshStoredAuth(stale).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
}

export interface DeviceLogin {
  deviceCode: string;
  /** The code the approval page shows, for the user to match. */
  userCode: string;
  /** The approval page with the code filled in. */
  url: string;
  expiresAt: number;
  intervalMs: number;
}

export async function startDeviceLogin(): Promise<DeviceLogin> {
  const { ok, status, body } = await postForm("/api/auth/device/code", { client_id: CLIENT_ID, scope: SCOPE, resource: SIGN_IN_API });
  if (!ok) throw new Error(`The Paxa sign-in could not start: ${oauthFailure(body, status)}.`);
  const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = body;
  if (typeof device_code !== "string" || typeof user_code !== "string" || typeof verification_uri !== "string") {
    throw new Error("The Paxa sign-in answered without a code. Try again.");
  }
  return {
    deviceCode: device_code,
    userCode: user_code,
    url: typeof verification_uri_complete === "string" ? verification_uri_complete : verification_uri,
    expiresAt: Date.now() + (typeof expires_in === "number" ? expires_in : 1800) * 1000,
    intervalMs: (typeof interval === "number" ? interval : 5) * 1000,
  };
}

/**
 * Poll until the user approves (the sign-in is then stored), declines, or the code expires. In the background, the
 * polling never keeps the process alive on its own, so a server whose client went away still exits.
 */
export async function finishDeviceLogin(login: DeviceLogin, background = false): Promise<StoredAuth> {
  let interval = login.intervalMs;
  for (;;) {
    await sleep(interval, background);
    if (Date.now() > login.expiresAt) throw new Error(EXPIRED_MESSAGE);
    let reply: Awaited<ReturnType<typeof postForm>>;
    try {
      reply = await postForm("/api/auth/oauth2/token", { grant_type: DEVICE_GRANT, device_code: login.deviceCode, client_id: CLIENT_ID });
    } catch {
      // A dropped connection while the user is still approving; the code's expiry bounds the retries.
      continue;
    }
    const { ok, status, body } = reply;
    if (ok) {
      const auth = toStoredAuth(body, await accountEmail(body.access_token));
      await withLock(async () => writeStoredAuth(auth));
      return auth;
    }
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5000;
        continue;
      case "access_denied":
        throw new Error("The sign-in was declined in the browser.");
      case "expired_token":
        throw new Error(EXPIRED_MESSAGE);
      default:
        throw new Error(`The Paxa sign-in failed: ${oauthFailure(body, status)}.`);
    }
  }
}

/** Open a URL in the user's default browser. False when no opener ran (a server without a desktop, say). */
export function openInBrowser(url: string): Promise<boolean> {
  // cmd would read these as its own syntax; the caller then shows the URL to open by hand.
  if (process.platform === "win32" && /[&|^<>%"]/.test(url)) return Promise.resolve(false);
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    // Some openers stay attached to the browser they started; one still running has opened it.
    const timer = setTimeout(() => {
      child.unref();
      resolve(true);
    }, 5000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * The stored sign-in, checked with one free API call: undefined when there is none, or when the API refused it
 * (signed out elsewhere, or the app disconnected), in which case it is cleared so a new sign-in can start.
 */
export async function verifiedSignIn(check: () => Promise<unknown>): Promise<StoredAuth | undefined> {
  if (!readStoredAuth()) return undefined;
  try {
    await check();
  } catch (err) {
    if (err instanceof PaxaApiError && err.status === 401) {
      clearStoredAuth();
      return undefined;
    }
    if (err instanceof Error && err.message === SIGNED_OUT_MESSAGE) return undefined;
    throw err;
  }
  return readStoredAuth();
}

/** Revoke the refresh token and forget the sign-in. undefined when there was none; false when only the local copy went. */
export async function signOut(): Promise<boolean | undefined> {
  if (!readStoredAuth()) return undefined;
  return withLock(async () => {
    const auth = readStoredAuth();
    let revoked = false;
    if (auth) {
      const reply = await postForm("/api/auth/oauth2/revoke", {
        token: auth.refresh_token,
        token_type_hint: "refresh_token",
        client_id: CLIENT_ID,
      }).catch(() => undefined);
      revoked = reply?.ok ?? false;
    }
    clearStoredAuth();
    return revoked;
  });
}
