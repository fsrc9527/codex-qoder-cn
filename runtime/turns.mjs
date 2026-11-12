import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { qodercliAuth, query } from "@qodercn-ai/qodercn-agent-sdk";
import { findQoderCli } from "./qoder-cli.mjs";
import { summarizeRun } from "./runs.mjs";

const readTools = ["Read", "Grep", "Glob"];
const editTools = [...readTools, "Edit", "Write"];

function compactText(value, limit) {
  const text = Array.isArray(value)
    ? value.map(item => typeof item === "string" ? item : item?.text ?? "").join(" ")
    : String(value ?? "");
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function errorMessage(error) {
  return compactText(error instanceof Error ? error.message : error, 1200);
}

function displayPath(cwd, path) {
  if (!isAbsolute(path)) return path;
  const local = relative(cwd, path);
  if (isAbsolute(local) || local === ".." || local.startsWith(".." + sep)) return path;
  return local || ".";
}

function recordSteps(steps, content, cwd) {
  if (!Array.isArray(content)) return [];
  const changed = [];
  for (const block of content) {
    if (block.type === "tool_use") {
      const step = { status: "running", ...steps.get(block.id), tool: block.name };
      for (const key of ["file_path", "path", "pattern", "glob"]) {
        const value = block.input?.[key];
        if (typeof value !== "string") continue;
        const detail = key === "file_path" || key === "path" ? displayPath(cwd, value) : value;
        step[key] = detail.slice(0, 240);
      }
      steps.set(block.id, step);
      changed.push(step);
    } else if (block.type === "tool_result") {
      const step = { tool: "unknown", ...steps.get(block.tool_use_id) };
      step.status = block.is_error ? "error" : "ok";
      if (block.is_error) step.error = compactText(block.content, 240);
      else delete step.error;
      steps.set(block.tool_use_id, step);
      changed.push(step);
    }
  }
  return changed;
}

function reportProgress(extra, id) {
  const progressToken = extra._meta?.progressToken;
  let progress = 0;
  return message => {
    if (progressToken === undefined || extra.signal.aborted) return;
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: ++progress, message: `Qoder ${id} ${message}` },
    }).catch(() => {});
  };
}

function finalAnswer(result, sessionId) {
  if (!result) throw new Error("Qoder exited without a final result.");
  if (result.subtype !== "success" || result.is_error) {
    throw new Error(compactText(result.errors ?? result.result ?? result.subtype, 1200)
      || "Qoder reported a failure.");
  }
  if (!sessionId) throw new Error("Qoder returned no session ID for follow-up.");
  const answer = typeof result.result === "string" ? result.result.trim() : "";
  if (!answer) throw new Error("Qoder returned an empty answer.");
  return answer;
}

export function createTurns(runs, cliPath) {
  const active = new Map();

  async function execute({ cwd, model, task, edit, timeout_seconds }, extra, resume) {
    if (extra.signal.aborted) return { status: "cancelled" };
    if (!isAbsolute(cwd)) throw new Error("Pass an absolute working directory.");
    cwd = realpathSync(cwd);
    if (!statSync(cwd).isDirectory()) throw new Error("The working directory must be a directory.");
    const qoderPath = findQoderCli(cliPath);
    if (!qoderPath) {
      throw new Error("Install and sign in to the native Qoder CN CLI. See https://docs.qoder.cn/cli/installation.");
    }

    const id = runs.begin(cwd, model, resume);
    const steps = new Map();
    const progress = reportProgress(extra, id);
    const abortController = new AbortController();
    let sessionId = resume;
    let execution;
    let result;
    let outcome;
    let stopStatus;
    let cancelPoll;
    let deadline;
    let forceStop;

    function interrupt(status) {
      if (stopStatus || result) return false;
      stopStatus = status;
      forceStop = setTimeout(() => abortController.abort(), 2200);
      void execution.interrupt().catch(() => abortController.abort());
      return true;
    }

    function requestStop(status) {
      if (!interrupt(status)) return;
      try {
        runs.requestCancel(id);
      } catch (error) {
        console.error("Could not record the Qoder stop request.", errorMessage(error));
      }
    }

    const cancel = () => requestStop("cancelled");
    try {
      execution = query({
        prompt: task,
        options: {
          auth: qodercliAuth(),
          pathToQoderCLIExecutable: qoderPath,
          abortController,
          cwd,
          model,
          resume,
          strictMcpConfig: true,
          tools: edit ? editTools : readTools,
          permissionMode: edit ? "acceptEdits" : "default",
          canUseTool: async () => ({ behavior: "deny", message: "This operation needs interactive Qoder permission." }),
          extraArgs: { "max-model-request-retries": "0" },
        },
      });
      active.set(id, cancel);
      extra.signal.addEventListener("abort", cancel, { once: true });
      // A cancellation can arrive through a separate Codex MCP process.
      cancelPoll = setInterval(() => {
        if (!stopStatus && !result && runs.cancelRequested(id)) interrupt("cancelled");
      }, 250);
      deadline = setTimeout(() => requestStop("timed_out"), timeout_seconds * 1000);
      progress("started");

      for await (const event of execution) {
        if (event.type === "result" || (event.type === "system" && event.subtype === "init")) {
          const nextSession = event.session_id;
          if (nextSession && nextSession !== sessionId) {
            if (sessionId) throw new Error("Qoder returned a different session ID.");
            sessionId = nextSession;
            runs.saveSession(id, sessionId);
          }
        }
        if (event.type === "result") {
          result = event;
          break;
        }
        if ((event.type === "assistant" || event.type === "user") && !event.isReplay) {
          const changed = recordSteps(steps, event.message.content, cwd);
          if (!changed.length) continue;
          runs.saveSteps(id, [...steps.values()]);
          for (const step of changed) {
            progress([step.tool, step.file_path ?? step.path, step.status].filter(Boolean).join(" "));
          }
        }
      }
      outcome = { status: "succeeded", answer: finalAnswer(result, sessionId) };
    } catch (error) {
      outcome = { status: "failed", error: errorMessage(error) };
    } finally {
      clearInterval(cancelPoll);
      clearTimeout(deadline);
      extra.signal.removeEventListener("abort", cancel);
      active.delete(id);
      try {
        await execution?.close();
      } catch (error) {
        outcome = { status: "failed", error: errorMessage(error) };
      }
      clearTimeout(forceStop);
    }

    if (stopStatus) {
      outcome = {
        status: stopStatus,
        error: stopStatus === "timed_out" ? "Qoder reached the requested time limit." : null,
      };
    }
    const credits = Number.isFinite(result?.total_credits) ? result.total_credits : null;
    runs.finish(id, { ...outcome, credits });
    const errors = [...steps.values()].filter(step => step.status === "error");
    return {
      ...summarizeRun(runs.get(id)),
      ...(outcome.answer !== undefined ? { answer: outcome.answer } : {}),
      tool_steps: steps.size,
      tool_errors: errors.length,
      ...(errors.length ? { recent_errors: errors.slice(-2) } : {}),
    };
  }

  async function cancel(id) {
    let run = runs.get(id);
    if (!run) throw new Error("Qoder run was not found.");
    if (run.status === "running") {
      const stop = active.get(id);
      if (stop) stop();
      else runs.requestCancel(id);

      for (let attempt = 0; attempt < 12 && run.status === "running"; attempt++) {
        await delay(250);
        run = runs.get(id);
      }
    }
    return summarizeRun(run);
  }

  return {
    execute,
    cancel,
    stopAll() {
      for (const stop of active.values()) stop();
    },
  };
}
