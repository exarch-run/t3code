/** Direct-code schedules use the existing scheduler and the app-owned plugin process. */
export async function runScheduledPlugin(
  id: string,
  env = process.env,
  request = fetch,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error("Invalid plugin id");
  const origin = env.EXARCH_HOST_URL;
  const token = env.EXARCH_HOST_TOKEN;
  if (!origin || !token) throw new Error("Exarch is not connected.");
  const target = new URL(origin);
  if (
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    target.username ||
    target.password
  )
    throw new Error("Invalid Exarch host.");
  target.pathname = "/plugins/run";
  const response = await request(target, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ action: "run", id }),
    signal: AbortSignal.timeout(610_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Plugin ${id} failed.`);
  const result = (await response.json()) as { ok?: boolean };
  if (result.ok !== true) throw new Error(`Plugin ${id} failed.`);
}
