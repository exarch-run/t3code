import * as Stream from "effect/Stream";
import { HttpBody, HttpServerResponse } from "effect/unstable/http";

function filterJson(text: string): string {
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value?.result?.tools)) {
      value.result.tools = value.result.tools.filter(
        (tool: { name?: string }) => tool.name !== "delegate_task",
      );
      return JSON.stringify(value);
    }
  } catch {
    /* SSE control lines and empty lines carry no tools. */
  }
  return text;
}

/** Preserve SSE framing and all other tools; only the authenticated caller's list changes. */
export function hideHelperTool(response: HttpServerResponse.HttpServerResponse) {
  if (response.body._tag === "Uint8Array") {
    const text = new TextDecoder().decode(response.body.body);
    return HttpServerResponse.setBody(
      response,
      HttpBody.text(filterJson(text), response.body.contentType),
    );
  }
  if (response.body._tag === "Stream") {
    const body = response.body;
    return HttpServerResponse.setBody(
      response,
      HttpBody.stream(
        body.stream.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.map(
            (line) =>
              `${line.startsWith("data: ") ? `data: ${filterJson(line.slice(6))}` : filterJson(line)}\n`,
          ),
          Stream.encodeText,
        ),
        body.contentType,
      ),
    );
  }
  return response;
}
