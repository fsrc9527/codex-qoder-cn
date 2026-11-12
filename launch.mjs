import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const install = JSON.parse(readFileSync(join(root, "current.json"), "utf8"));
if (typeof install.release !== "string" || !/^[0-9a-f]{16}$/.test(install.release)) {
  throw new Error("Invalid Qoder CN installation state. Run the installer again.");
}

process.env.QODER_MCP_DB ??= join(root, "runs.sqlite");
if (install.qoderCliPath) process.env.QODER_MCP_CLI_HINT = install.qoderCliPath;
await import(pathToFileURL(join(root, "releases", install.release, "server.mjs")).href);
