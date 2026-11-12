import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import packageInfo from "./package.json" with { type: "json" };
import { openRuns, summarizeRun } from "./runs.mjs";
import { createTurns, errorMessage } from "./turns.mjs";

const runId = z.uuid().describe("Run ID from run, follow_up, or trace");
const turnOptions = {
  task: z.string().trim().min(1).describe("One scoped task or follow-up for Qoder"),
  edit: z.boolean().default(false).describe("Allow workspace file edits when authorized"),
  timeout_seconds: z.number().int().min(1).max(600).default(180),
};
const turnAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

function reply(data, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    ...(isError ? { isError: true } : {}),
  };
}

const databasePath = process.env.QODER_MCP_DB;
if (!databasePath) throw new Error("Start the MCP server with the installed launch.mjs.");

const runs = openRuns(databasePath);
const turns = createTurns(runs, process.env.QODER_MCP_CLI_HINT);
const server = new McpServer({ name: "qoder", version: packageInfo.version }, {
  instructions: "Delegate run and follow_up to the native qoder subagent to keep each turn visible and stoppable. Use trace for run history and tool outcomes. Use cancel to stop a turn by ID. Enable edit only when authorized.",
});

function register(name, options, handler) {
  server.registerTool(name, options, async (args, extra) => {
    try {
      runs.recoverDisconnected();
      return await handler(args, extra);
    } catch (error) {
      return reply({ error: errorMessage(error) }, true);
    }
  });
}

async function run(options, extra, resume) {
  const result = await turns.execute(options, extra, resume);
  return reply(result, result.status !== "succeeded");
}

register("run", {
  title: "Run a Qoder CN task",
  description: "Send a task to Qoder CN and save its session for follow-up. The call stays open until the task stops.",
  inputSchema: {
    cwd: z.string().trim().min(1).describe("Absolute directory of the selected project"),
    model: z.string().trim().min(1).describe("Explicit Qoder CN model name"),
    ...turnOptions,
  },
  annotations: turnAnnotations,
}, run);

register("follow_up", {
  title: "Continue a Qoder CN session",
  description: "Send a new instruction in the Qoder session of a prior run, using its working directory and model.",
  inputSchema: { run_id: runId, ...turnOptions },
  annotations: turnAnnotations,
}, ({ run_id, ...options }, extra) => {
  const prior = runs.get(run_id);
  if (!prior?.session_id) throw new Error("No saved Qoder session exists for that run.");
  return run({ ...options, cwd: prior.cwd, model: prior.model }, extra, prior.session_id);
});

register("trace", {
  title: "Inspect Qoder runs",
  description: "Look up status and a page of recorded tool steps. Omit run_id to see active and recent runs.",
  inputSchema: {
    run_id: runId.optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(50).default(10),
    include_answer: z.boolean().default(false),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, ({ run_id, offset, limit, include_answer }) => {
  if (!run_id) return reply({ runs: runs.recent(limit, offset).map(summarizeRun) });
  const row = runs.getDetails(run_id);
  if (!row) throw new Error("Qoder run was not found.");
  const { steps: savedSteps, answer, ...run } = row;
  const steps = JSON.parse(savedSteps);
  const page = steps.slice(offset, offset + limit);
  const next = offset + page.length;
  return reply({
    ...summarizeRun(run),
    steps: page.map((step, index) => ({ step: offset + index + 1, ...step })),
    next_offset: next < steps.length ? next : null,
    ...(include_answer && answer !== null ? { answer } : {}),
  });
});

register("cancel", {
  title: "Stop a Qoder turn",
  description: "Interrupt an active Qoder turn by run ID. Returns its current status, including cancelling while it stops.",
  inputSchema: { run_id: runId },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ run_id }) => reply(await turns.cancel(run_id)));

process.stdin.once("end", turns.stopAll);
await server.connect(new StdioServerTransport());
