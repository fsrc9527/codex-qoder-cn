---
name: qoder-delegate
description: Delegate a scoped coding task to the visible Qoder CN subagent through local MCP, inspect its tool activity, and follow up on the same Qoder session.
---

- Send `qoder.run` and `qoder.follow_up` through the native Codex role `qoder` so the user can view and stop each turn. Give it one scoped task and acceptance criteria. For a new task, pass the absolute project directory and the user's model or an available low-cost model. For a follow-up, pass the prior run ID.
- Keep tasks read-only by default. Enable `edit=true` only for authorized changes, name the files, and verify the diff and targeted tests.
- Use `qoder.trace` to inspect tool targets, outcomes, and errors. Omit the run ID to find active and recent runs. Use `qoder.cancel` with the run ID for an explicit stop request, then check the saved status and any applied edits.
