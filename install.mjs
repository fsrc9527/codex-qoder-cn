#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findQoderCli } from "./runtime/qoder-cli.mjs";

const source = dirname(fileURLToPath(import.meta.url));
const packageInfo = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function writeAtomic(path, content) {
  if (readText(path) === content) return;
  mkdirSync(dirname(path), { recursive: true });
  const staged = join(dirname(path), ".qoder-cn-" + randomUUID() + ".tmp");
  try {
    writeFileSync(staged, content, { encoding: "utf8", flag: "wx" });
    renameSync(staged, path);
  } finally {
    rmSync(staged, { force: true });
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function installDependencies(directory) {
  const npmArguments = ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
  const npmEntry = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].find(path => path && isAbsolute(path) && path.endsWith("npm-cli.js") && existsSync(path));

  const options = { cwd: directory, stdio: "inherit", windowsHide: true };
  let result;
  if (npmEntry) {
    result = spawnSync(process.execPath, [npmEntry, ...npmArguments], options);
  } else if (process.platform === "win32") {
    result = spawnSync(process.env.ComSpec ?? "cmd.exe", [
      "/d", "/s", "/c", "npm " + npmArguments.join(" "),
    ], options);
  } else {
    result = spawnSync("npm", npmArguments, options);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("npm ci did not finish successfully.");
}

function prepareRuntime(releases) {
  const runtimeFiles = packageInfo.files.filter(path => path.startsWith("runtime/")).map(path => ({
    name: path.slice("runtime/".length),
    content: readFileSync(join(source, path)),
  }));
  const hash = createHash("sha256");
  for (const { name, content } of runtimeFiles) {
    hash.update(name).update("\0").update(content).update("\0");
  }
  const release = hash.digest("hex").slice(0, 16);

  mkdirSync(releases, { recursive: true });
  const releaseRoot = realpathSync(releases);
  const installed = join(releaseRoot, release);
  if (existsSync(installed)) {
    if (dirname(realpathSync(installed)) !== releaseRoot) {
      throw new Error("The installed runtime is outside its release directory.");
    }
    return { directory: installed, release };
  }

  const staging = mkdtempSync(join(releaseRoot, ".install-"));
  try {
    for (const { name, content } of runtimeFiles) {
      writeFileSync(join(staging, name), content);
    }
    installDependencies(staging);
    renameSync(staging, installed);
  } finally {
    if (existsSync(staging)) {
      const target = realpathSync(staging);
      if (dirname(target) !== releaseRoot) {
        throw new Error("Could not verify the temporary installation directory.");
      }
      rmSync(target, { recursive: true, force: true });
    }
  }
  return { directory: installed, release };
}

function acquireInstallLock(root) {
  const lockPath = join(root, ".install.lock");
  try {
    writeFileSync(lockPath, String(process.pid) + "\n", { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error("Another installation may be active. Check " + lockPath + " before retrying.");
  }
  return lockPath;
}

function install(profile) {
  const root = join(profile, "qoder-cn");
  const manifestPath = join(root, "current.json");
  const launcher = join(root, "launch.mjs");
  const configPath = join(profile, "config.toml");
  const files = [
    ["launch.mjs", launcher],
    ["codex/agents/qoder.toml", join(profile, "agents", "qoder.toml")],
    ["codex/skills/qoder-delegate/SKILL.md", join(profile, "skills", "qoder-delegate", "SKILL.md")],
  ];

  mkdirSync(root, { recursive: true });
  const lock = acquireInstallLock(root);
  try {
    const previous = JSON.parse(readText(manifestPath) ?? "{}");
    const sources = files.map(([name, path]) => {
      const content = readFileSync(join(source, name), "utf8");
      return { name, path, content, hash: sha256(content) };
    });
    for (const file of sources) {
      const installed = readText(file.path);
      if (installed !== undefined && installed !== file.content && sha256(installed) !== previous.files?.[file.name]) {
        throw new Error("已有同名配置，请先处理冲突再安装。\n" + file.path);
      }
    }

    const qoderCliPath = findQoderCli();
    const { directory, release } = prepareRuntime(join(root, "releases"));
    const requireFromRuntime = createRequire(join(directory, "package.json"));
    const { parse, stringify } = requireFromRuntime("smol-toml");
    const config = readText(configPath) ?? "";
    const configured = parse(config).mcp_servers?.qoder;
    if (configured !== undefined &&
        (typeof configured.command !== "string" || configured.args?.length !== 1 || configured.args[0] !== launcher)) {
      throw new Error("Codex 已配置名为 qoder 的其他 MCP 服务，请先处理同名配置。\n" + configPath);
    }

    let updatedConfig;
    if (configured === undefined) {
      const entry = "[mcp_servers.qoder]\n" + stringify({
        command: process.execPath,
        args: [launcher],
        tool_timeout_sec: 660,
        default_tools_approval_mode: "approve",
      });
      const separator = config.endsWith("\n") ? "\n" : "\n\n";
      updatedConfig = config ? config + separator + entry : entry;
      parse(updatedConfig);
    }

    for (const file of sources) writeAtomic(file.path, file.content);
    writeAtomic(manifestPath, JSON.stringify({
      release,
      qoderCliPath,
      files: Object.fromEntries(sources.map(file => [file.name, file.hash])),
    }, null, 2) + "\n");

    if (updatedConfig !== undefined) {
      if ((readText(configPath) ?? "") !== config) {
        throw new Error("Codex 配置在安装时发生变化，请重新运行安装命令。");
      }
      writeAtomic(configPath, updatedConfig);
    }
    return qoderCliPath;
  } finally {
    unlinkSync(lock);
  }
}

function showNextStep(cli) {
  if (!cli) {
    console.log("首次使用请安装 Qoder CN CLI 并登录。https://docs.qoder.cn/cli/installation");
    return;
  }
  console.log("首次使用请登录 Qoder CN CLI，已有登录可直接使用。");
  if (process.platform === "win32") {
    console.log("& '" + cli.replaceAll("'", "''") + "' login");
  } else {
    console.log("'" + cli.replaceAll("'", "'\\''") + "' login");
  }
}

function main() {
  const { values } = parseArgs({
    options: { "codex-home": { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log("Usage: node install.mjs [--codex-home <directory>]");
    return;
  }

  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error("需要 Node.js 22.13 或更高版本。");
  }
  const profile = resolve(values["codex-home"] ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const cli = install(profile);
  console.log("Qoder CN 集成已安装到 " + profile);
  showNextStep(cli);
  console.log("重启 Codex 后，在本地项目对话中使用 $qoder-delegate。");
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
