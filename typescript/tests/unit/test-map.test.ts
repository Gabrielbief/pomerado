import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  readResults,
  guard,
  merge,
  normalize,
  readMap,
  select,
  type Change,
  type TestMap,
} from "../../../tools/test-map.js";

const script = fileURLToPath(new URL("../../../tools/test-map.ts", import.meta.url));
const preload = fileURLToPath(new URL("../../../tools/test-map-trace.ts", import.meta.url));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "test-map-test-"));
  directories.push(directory);
  return directory;
};

const unitA = "typescript/tests/unit/a.test.ts";
const unitB = "typescript/tests/unit/b.test.ts";
const specC = "typescript/tests/browser/c.spec.ts";
const map: TestMap = {
  version: 1,
  sha: "1".repeat(40),
  tests: [specC, unitA, unitB],
  failed: [],
  files: {
    "typescript/src/shared.ts": [0, 1],
    "typescript/src/only-b.ts": [2],
    "typescript/authoring/core/SKILL.md": [0],
    "README.md": [1],
  },
  folders: { "typescript/authoring/core/": [0] },
};
const headFiles = new Set([
  unitA,
  unitB,
  specC,
  "typescript/src/shared.ts",
  "typescript/src/only-b.ts",
]);
const modified = (path: string): Change => ({ status: "modified", path });
const added = (path: string): Change => ({ status: "added", path });
const pick = (
  changes: readonly Change[],
  options: { map?: TestMap | undefined; files?: Set<string>; head?: Record<string, string> } = {},
) =>
  select(
    "map" in options ? options.map : map,
    changes,
    options.files ?? headFiles,
    (path) => options.head?.[path] ?? "",
  );

describe("select", () => {
  it("runs the tests that read a changed file, and only those", () => {
    expect(pick([modified("typescript/src/only-b.ts")])).toMatchObject({
      mode: "selected",
      unit: [unitB],
      browser: [],
    });
    expect(pick([modified("typescript/src/shared.ts")])).toMatchObject({
      unit: [unitA],
      browser: [specC],
    });
    expect(pick([modified("typescript/authoring/core/SKILL.md")])).toMatchObject({
      unit: [],
      browser: [specC],
    });
  });

  it("runs everything for a changed file no test read, such as one only a computed path loads", () => {
    const selection = pick([
      modified("typescript/src/only-b.ts"),
      modified("typescript/src/hidden.ts"),
    ]);
    expect(selection.mode).toBe("full");
    expect(selection.reasons.join()).toContain("typescript/src/hidden.ts");
  });

  it("runs everything for the toolchain, test setup, workflows and the selector, and without a map", () => {
    for (const path of [
      "pnpm-lock.yaml",
      "package.json",
      "vitest.config.ts",
      ".github/workflows/check.yml",
      "tools/test-map-trace.ts",
    ])
      expect(pick([modified(path)]).mode).toBe("full");
    expect(pick([modified("typescript/src/only-b.ts")], { map: undefined }).mode).toBe("full");
    const many = Array.from({ length: 301 }, (_, index) => modified(`docs/page-${index}.md`));
    expect(pick(many).mode).toBe("full");
  });

  it("runs no test for documentation no test reads, and the readers of documentation a test reads", () => {
    expect(pick([modified("docs/guide.md"), modified("CHANGELOG.md")])).toMatchObject({
      mode: "selected",
      unit: [],
      browser: [],
    });
    expect(pick([modified("README.md")])).toMatchObject({ mode: "selected", unit: [unitA] });
  });

  it("runs a changed test, a new test and a test whose map run failed", () => {
    const files = new Set([...headFiles, "typescript/tests/unit/new.test.ts"]);
    const selection = pick([modified(unitB)], { map: { ...map, failed: [0] }, files });
    expect(selection).toMatchObject({
      mode: "selected",
      unit: [unitB, "typescript/tests/unit/new.test.ts"],
      browser: [specC],
    });
  });

  it("counts a new file in a folder a test lists, and a new file another changed file names", () => {
    expect(pick([added("typescript/authoring/core/NEW.md")])).toMatchObject({
      mode: "selected",
      browser: [specC],
    });
    const head = { "typescript/src/only-b.ts": 'import { x } from "./helper.js";' };
    const files = new Set([...headFiles, "typescript/src/helper.ts"]);
    expect(
      pick([modified("typescript/src/only-b.ts"), added("typescript/src/helper.ts")], {
        files,
        head,
      }),
    ).toMatchObject({
      mode: "selected",
      unit: [unitB],
    });
    expect(
      pick([added("typescript/src/orphan.ts")], {
        files: new Set([...headFiles, "typescript/src/orphan.ts"]),
      }).mode,
    ).toBe("full");
  });

  it("runs everything when a code change would otherwise run no test", () => {
    // The only test that read the file is deleted along with it.
    const files = new Set([unitA, specC, "typescript/src/shared.ts"]);
    const selection = pick(
      [
        { status: "deleted", path: "typescript/src/only-b.ts" },
        { status: "deleted", path: unitB },
      ],
      { files },
    );
    expect(selection.mode).toBe("full");
  });
});

describe("guard", () => {
  const empty = { mode: "selected", reasons: [], mapSha: null, unit: [], browser: [] } as const;
  it("fails an empty selection for a change to more than documentation, whatever chose it", () => {
    expect(guard(empty, [modified("typescript/src/only-b.ts")])).toContain("runs no test");
    expect(guard(empty, [modified("docs/guide.md")])).toBeUndefined();
    expect(
      guard({ ...empty, mode: "full" }, [modified("typescript/src/only-b.ts")]),
    ).toBeUndefined();
  });
});

describe("map building", () => {
  it("counts built files as their sources and drops guesses and folders every test lists", () => {
    const tracked = new Set([
      "typescript/src/a.ts",
      "typescript/src/b.ts",
      "typescript/authoring/x.md",
      "typescript/tests/unit/a.test.ts",
    ]);
    const recorded = [
      "dist/typescript/src/a.js",
      "dist/runtime-sources.json",
      "typescript/src/a.jsx",
      "typescript/src//",
      "node_modules",
      "dist/typescript/authoring/x.md",
    ];
    const { files, folders } = normalize(
      recorded,
      tracked,
      () => ["typescript/src/b.ts"],
      () => false,
    );
    expect([...files].toSorted()).toEqual([
      "typescript/authoring/x.md",
      "typescript/src/a.ts",
      "typescript/src/b.ts",
    ]);
    expect([...folders]).toEqual(["typescript/src/"]);
    // A built file with no source of its own stands for every source file.
    expect(
      normalize(
        ["dist/generated.json"],
        tracked,
        () => [],
        () => true,
      ).files.size,
    ).toBe(3);

    const built = merge("2".repeat(40), [
      {
        tests: {
          [unitA]: {
            passed: true,
            seconds: 1,
            files: ["typescript/src/a.ts"],
            folders: ["typescript/tests/unit/", "typescript/src/"],
          },
        },
      },
      {
        tests: {
          [unitB]: {
            passed: false,
            seconds: 1,
            files: ["typescript/src/a.ts"],
            folders: ["typescript/tests/unit/"],
          },
        },
      },
    ]);
    expect(built).toEqual({
      version: 1,
      sha: "2".repeat(40),
      tests: [unitA, unitB],
      failed: [1],
      files: { "typescript/src/a.ts": [0, 1] },
      folders: { "typescript/src/": [0] },
    });
  });

  it("reads failed test files from Vitest and Playwright results", () => {
    const vitest = {
      testResults: [
        { name: "/repo/typescript/tests/unit/a.test.ts", status: "failed" },
        { name: "/repo/typescript/tests/unit/b.test.ts", status: "passed" },
      ],
    };
    const playwright = {
      suites: [
        { file: "c.spec.ts", specs: [{ ok: false, file: "c.spec.ts" }], suites: [] },
        { file: "d.spec.ts", specs: [{ ok: true, file: "d.spec.ts" }] },
      ],
    };
    expect(readResults(vitest, "/repo").failed).toEqual([unitA]);
    expect(readResults(playwright, "/repo").failed).toEqual([specC]);
  });
});

describe("trace preload", () => {
  it("records modules, computed-path reads and a child's reads under a stripped environment", () => {
    const root = temporary();
    const out = temporary();
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write("lib/imported.mjs", "export const value = 1;\n");
    write("data/computed.txt", "text\n");
    write("data/child.txt", "text\n");
    write("data/listed/item.txt", "text\n");
    write("data/held/inside.txt", "text\n");
    write(
      "child.mjs",
      'import { readFileSync } from "node:fs";\nreadFileSync(new URL("./data/child.txt", import.meta.url));\n',
    );
    write(
      "main.mjs",
      [
        'import { closeSync, openSync, readFileSync, readdirSync } from "node:fs";',
        'import { spawnSync } from "node:child_process";',
        'import { value } from "./lib/imported.mjs";',
        'const name = ["comp", "uted"].join("");',
        "readFileSync(new URL(`./data/${name}.txt`, import.meta.url));",
        'readdirSync(new URL("./data/listed/", import.meta.url));',
        // Scoped reads on Linux open a file below a held folder descriptor.
        'if (process.platform === "linux") { const fd = openSync(new URL("./data/held/", import.meta.url), "r"); readFileSync(`/proc/self/fd/${fd}/inside.txt`); closeSync(fd); }',
        'const child = spawnSync(process.execPath, [new URL("./child.mjs", import.meta.url).pathname], { env: { PATH: process.env.PATH } });',
        "if (child.status !== 0 || value !== 1) process.exit(1);",
      ].join("\n"),
    );
    const run = spawnSync(process.execPath, [join(root, "main.mjs")], {
      cwd: root,
      env: {
        PATH: process.env["PATH"] ?? "",
        NODE_OPTIONS: `--import ${preload}`,
        TEST_MAP_OUT: out,
        TEST_MAP_ROOT: root,
      },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const recorded = new Set(
      readdirSync(out).flatMap((file) => readFileSync(join(out, file), "utf8").split("\n")),
    );
    for (const path of [
      "main.mjs",
      "lib/imported.mjs",
      "data/computed.txt",
      "data/listed/",
      "child.mjs",
      "data/child.txt",
      ...(process.platform === "linux" ? ["data/held/inside.txt"] : []),
    ])
      expect(recorded).toContain(path);
  });
});

describe("select and guard commands", () => {
  it("select a change's tests from git, and guard rejects an empty selection for code", () => {
    const repo = temporary();
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    };
    for (const path of headFiles) write(path, "export {};\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    write("typescript/src/only-b.ts", "export const changed = true;\n");
    git("commit", "-q", "-am", "change");
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "map.json"), JSON.stringify({ ...map, sha: base }));
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [script, ...args], {
        cwd: repo,
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "" },
      });

    const chosen = cli(
      "select",
      "--map",
      "map.json",
      "--base",
      base,
      "--head",
      head,
      "--out",
      "selection.json",
    );
    expect(chosen.status, chosen.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(repo, "selection.json"), "utf8"))).toMatchObject({
      mode: "selected",
      unit: [unitB],
      browser: [],
    });
    expect(
      cli("guard", "--selection", "selection.json", "--base", base, "--head", head).status,
    ).toBe(0);

    writeFileSync(
      join(repo, "empty.json"),
      JSON.stringify({ mode: "selected", reasons: [], mapSha: null, unit: [], browser: [] }),
    );
    const rejected = cli("guard", "--selection", "empty.json", "--base", base, "--head", head);
    expect(rejected.status).toBe(1);
    expect(rejected.stdout).toContain("runs no test");

    // No map, a map off the base's history and a stale map all select everything.
    expect(readMap(join(repo, "missing.json"), base, repo)).toBe("no test map");
    writeFileSync(join(repo, "foreign.json"), JSON.stringify(map));
    expect(readMap(join(repo, "foreign.json"), base, repo)).toContain("not on the base's history");
    const later = `@${Number(git("show", "-s", "--format=%ct", base)) + 4 * 86_400} +0000`;
    const env = { ...process.env, GIT_COMMITTER_DATE: later };
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "later"], { cwd: repo, env });
    expect(readMap(join(repo, "map.json"), git("rev-parse", "HEAD"), repo)).toContain("days older");
  });
});
