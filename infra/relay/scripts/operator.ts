// @effect-diagnostics globalFetch:off globalConsole:off preferSchemaOverJson:off - A small operator command run by hand from a terminal.
// Operator commands for AI reports and account deletions on a deployed relay.
//
//   RELAY_OPERATOR_TOKEN=… node scripts/operator.ts summary
//   RELAY_OPERATOR_TOKEN=… node scripts/operator.ts reports
//   RELAY_OPERATOR_TOKEN=… node scripts/operator.ts resolve-report <report id>
//   RELAY_OPERATOR_TOKEN=… node scripts/operator.ts delete-report <report id>
//   RELAY_OPERATOR_TOKEN=… node scripts/operator.ts delete-account <clerk user id>
//
// RELAY_URL defaults to https://relay.exarch.run. `reports` prints report text
// to this terminal only; don't paste it into issues, chats or logs.
// Review reports daily. `resolve-report` permanently deletes the handled report;
// there is no resolved-content archive. Unresolved reports expire after seven days.
// `delete-account` is for requests that arrived by email: confirm the request
// came from the account's address, find the user id in the Clerk dashboard,
// then queue the same cleanup the phone's Delete account runs.

const relayUrl = (process.env.RELAY_URL ?? "https://relay.exarch.run").replace(/\/+$/u, "");
const token = process.env.RELAY_OPERATOR_TOKEN ?? "";
const [command, argument] = process.argv.slice(2);

const usage =
  "Usage: node scripts/operator.ts summary | reports | resolve-report <id> | delete-report <id> | delete-account <user id>";

async function call(method: string, path: string, body?: object) {
  const response = await fetch(`${relayUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} answered ${response.status}${text ? `: ${text}` : ""}`);
  }
  return text ? (JSON.parse(text) as unknown) : null;
}

async function main() {
  if (token.length < 32) throw new Error("Set RELAY_OPERATOR_TOKEN to the relay's operator token.");
  switch (command) {
    case "summary":
      return call("GET", "/v1/operator/summary");
    case "reports":
      return call("GET", "/v1/operator/reports");
    case "resolve-report":
    case "delete-report":
      if (!argument) throw new Error(usage);
      return call("DELETE", `/v1/operator/reports/${encodeURIComponent(argument)}`);
    case "delete-account":
      if (!argument) throw new Error(usage);
      return call("POST", "/v1/operator/account-deletions", { userId: argument });
    default:
      throw new Error(usage);
  }
}

main().then(
  (result) => console.log(JSON.stringify(result, null, 2)),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
