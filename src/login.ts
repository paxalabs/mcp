// `paxa login` and `paxa logout`: the sign_in tool's sign-in, from a terminal.
//
//   paxa login    open the Paxa sign-in page, wait for the approval, keep the sign-in
//   paxa logout   revoke the sign-in and forget it on this machine
//
// The sign-in serves every server process and `paxa say` on this machine that
// has no PAXA_API_KEY.
import { PaxaClient } from "./api.js";
import { Credentials, SIGN_IN_API, authFile, finishDeviceLogin, openInBrowser, signOut, startDeviceLogin, verifiedSignIn } from "./auth.js";
import { loadConfig } from "./config.js";

function say(line: string): void {
  process.stderr.write(line + "\n");
}

function fail(err: unknown): never {
  say(`paxa: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

export async function runLogin(): Promise<void> {
  try {
    const config = loadConfig();
    // Check the stored sign-in itself, against the API it is for, not a key or API this shell happens to set.
    const client = new PaxaClient(SIGN_IN_API, new Credentials(undefined));
    const current = await verifiedSignIn(() => client.me());
    if (current) {
      say(`Already signed in${current.email ? ` as ${current.email}` : ""}. Run \`paxa logout\` first to switch accounts.`);
      return;
    }
    const login = await startDeviceLogin();
    const opened = await openInBrowser(login.url);
    say(opened ? `Opened ${login.url} in your browser.` : `Open this page in a browser: ${login.url}`);
    say(`Approve the request there; the page shows the code ${login.userCode}. Waiting (Ctrl-C to stop)...`);
    const auth = await finishDeviceLogin(login);
    say(`Signed in${auth.email ? ` as ${auth.email}` : ""}. The Paxa MCP server and paxa say on this machine use this account.`);
    if (config.apiKey) say("PAXA_API_KEY is set in this shell; wherever it is set, the key is used instead of the sign-in.");
  } catch (err) {
    fail(err);
  }
}

export async function runLogout(): Promise<void> {
  try {
    const revoked = await signOut();
    if (revoked === undefined) {
      say("Not signed in on this machine.");
      return;
    }
    say(
      revoked
        ? `Signed out on this machine: ${authFile()} is removed and the sign-in can no longer be renewed. The last ` +
            "access token works until its hour is up."
        : `Removed ${authFile()}, but the server could not be told; the sign-in lapses after 30 days unused.`,
    );
    say("The app stays connected to your account until you disconnect it under API keys at https://paxalabs.com/app/keys.");
  } catch (err) {
    fail(err);
  }
}
