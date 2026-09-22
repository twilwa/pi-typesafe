import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createStartupSelector } from "./selection.ts";
import { createSidecar } from "./sidecar.ts";

/** Pi package entry: loaded by Pi's TypeScript extension loader. */
export default function piTypeSafe(pi: ExtensionAPI) {
  const sidecar = createSidecar({
    record: (entry) => pi.appendEntry("jev-assessment", entry),
  });
  const startupSelector = createStartupSelector(pi);
  pi.on("tool_call", sidecar.toolCall);
  pi.on("tool_result", sidecar.toolResult);
  pi.on("session_start", (event, ctx) => {
    sidecar.reset();
    return startupSelector(event, ctx);
  });
  pi.on("session_shutdown", sidecar.reset);
}
