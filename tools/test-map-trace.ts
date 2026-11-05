/**
 * Preloaded into every Node process of a test map run (`NODE_OPTIONS=--import`), it records each
 * file the process loads as a module or reads, stats or lists through `node:fs`. tools/test-map.ts
 * runs one test file at a time with this preload, so everything a process records belongs to that
 * test file, whichever process recorded it: the test runner, its workers, or a CLI a test spawns.
 *
 * It does nothing unless TEST_MAP_OUT names the folder to write to. Each process appends one path
 * per line, the first time it sees the path, to its own file there, so a process that is killed
 * still leaves what it recorded. Only paths under TEST_MAP_ROOT are kept. A child process started
 * with an environment of its own, such as one with only PATH, still gets this preload and its
 * settings, so a built CLI a test spawns that way is recorded too.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = process.env["TEST_MAP_OUT"];
const root = process.env["TEST_MAP_ROOT"];

if (out !== undefined && out !== "" && root !== undefined && root !== "") {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const writeSync = fs.writeSync.bind(fs);
  const readlink = fs.readlinkSync.bind(fs);
  const handle = fs.openSync(
    join(out, `${process.pid}-${Math.random().toString(36).slice(2)}.txt`),
    "a",
  );
  const seen = new Set<string>();

  /** Records a file or folder path, a `file:` URL, a Buffer path or an open file's descriptor. */
  const record = (target: unknown, kind: "file" | "dir" = "file"): void => {
    let path: string;
    if (typeof target === "string")
      path = target.startsWith("file:") ? fileURLToPath(target) : target;
    else if (target instanceof URL) {
      if (target.protocol !== "file:") return;
      path = fileURLToPath(target);
    } else if (Buffer.isBuffer(target)) path = target.toString();
    else return;
    // resolve() also normalizes an absolute path and drops a trailing slash.
    let absolute = resolve(path);
    // A path below an open folder's descriptor, as scoped reads open files on Linux.
    const below = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/u.exec(absolute);
    if (below !== null) {
      try {
        absolute = resolve(readlink(`/proc/self/fd/${below[1] ?? ""}`) + (below[2] ?? ""));
      } catch {
        return;
      }
    }
    if (!absolute.startsWith(prefix)) return;
    const relative = absolute.slice(prefix.length) + (kind === "dir" ? "/" : "");
    if (
      relative === "/" ||
      relative.startsWith("node_modules/") ||
      relative.includes("/node_modules/")
    )
      return;
    if (seen.has(relative)) return;
    seen.add(relative);
    writeSync(handle, `${relative}\n`);
  };

  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith("file:")) record(url);
      return nextLoad(url, context);
    },
  });

  type Target = Record<string, unknown>;
  const wrap = (target: Target, names: readonly string[], kind: "file" | "dir"): void => {
    for (const name of names) {
      const original = target[name];
      if (typeof original !== "function") continue;
      // Keep any properties on the original, such as util.promisify.custom.
      const wrapped = Object.assign(function (this: unknown, ...args: unknown[]) {
        record(args[0], kind);
        return Reflect.apply(original, this, args);
      }, original);
      target[name] = wrapped;
    }
  };

  const fileReads = [
    "readFileSync",
    "readFile",
    "openSync",
    "open",
    "createReadStream",
    "statSync",
    "stat",
    "lstatSync",
    "lstat",
    "existsSync",
    "accessSync",
    "access",
    "realpathSync",
    "copyFileSync",
    "copyFile",
    "cpSync",
    "cp",
  ];
  const folderReads = ["readdirSync", "readdir", "opendirSync", "opendir"];
  const callbackFs = fs as unknown as Target;
  const promiseFs = fs.promises as unknown as Target;
  wrap(callbackFs, fileReads, "file");
  wrap(callbackFs, folderReads, "dir");
  wrap(promiseFs, fileReads, "file");
  wrap(promiseFs, folderReads, "dir");

  const inherited: Record<string, string> = Object.fromEntries(
    ["NODE_OPTIONS", "TEST_MAP_OUT", "TEST_MAP_ROOT"].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const childProcesses = childProcess as unknown as Target;
  for (const name of [
    "spawn",
    "spawnSync",
    "fork",
    "execFile",
    "execFileSync",
    "exec",
    "execSync",
  ]) {
    const original = childProcesses[name];
    if (typeof original !== "function") continue;
    childProcesses[name] = Object.assign(function (this: unknown, ...args: unknown[]) {
      const index = args.findLastIndex(
        (arg) => typeof arg === "object" && arg !== null && !Array.isArray(arg),
      );
      const options = index === -1 ? undefined : (args[index] as { env?: unknown });
      if (options !== undefined && typeof options.env === "object" && options.env !== null) {
        // Settings the caller chose win, and the preload joins any NODE_OPTIONS it set.
        const env = options.env as Record<string, string | undefined>;
        const own = env["NODE_OPTIONS"];
        const nodeOptions =
          own === undefined
            ? inherited["NODE_OPTIONS"]
            : `${own} ${inherited["NODE_OPTIONS"] ?? ""}`.trim();
        args[index] = { ...options, env: { ...inherited, ...env, NODE_OPTIONS: nodeOptions } };
      }
      return Reflect.apply(original, this, args);
    }, original);
  }
  syncBuiltinESMExports();
}
