import { readExarchHost } from "../mcp/ExarchHostClient.ts";

/** Direct-code schedules use the existing scheduler and the app-owned plugin process. */
export async function runScheduledPlugin(
  id: string,
  env = process.env,
  request = fetch,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error("Invalid plugin id");
  const host = readExarchHost(env);
  if (host.status === "unset") throw new Error("Exarch is not connected.");
  if (host.status === "invalid") throw new Error("Invalid Exarch host.");
  const response = await request(new URL("/plugins/run", host.origin), {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    body: JSON.stringify({ action: "run", id }),
    signal: AbortSignal.timeout(610_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Plugin ${id} failed.`);
  const result = (await response.json()) as { ok?: boolean };
  if (result.ok !== true) throw new Error(`Plugin ${id} failed.`);
}
