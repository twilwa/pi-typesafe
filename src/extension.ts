import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSidecar } from "./sidecar.ts";

/** Pi package entry: loaded by Pi's TypeScript extension loader. */
export default function jevSidecar(pi: ExtensionAPI) {
  const sidecar = createSidecar({
    record: (entry) => pi.appendEntry("jev-assessment", entry),
  });
  pi.on("tool_call", sidecar.toolCall);
  pi.on("tool_result", sidecar.toolResult);
  pi.on("session_start", sidecar.reset);
  pi.on("session_shutdown", sidecar.reset);
}
