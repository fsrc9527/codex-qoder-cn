import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const windows = process.platform === "win32";
const commands = ["qoderclicn", "qodercn"].map(name => windows ? name + ".exe" : name);

function isNativeExecutable(path) {
  if (!isAbsolute(path) || (windows && !path.toLowerCase().endsWith(".exe"))) return false;
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findQoderCli(installedPath) {
  const override = process.env.QODERCN_CLI_PATH;
  if (override) {
    if (!isNativeExecutable(override)) {
      throw new Error("QODERCN_CLI_PATH must point to the absolute path of a native Qoder CN executable.");
    }
    return override;
  }

  if (installedPath && isNativeExecutable(installedPath)) return installedPath;
  const directories = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
  directories.push(join(homedir(), ".local", "bin"));
  for (const directory of directories) {
    for (const name of commands) {
      const path = join(directory, name);
      if (isNativeExecutable(path)) return path;
    }
  }
}
