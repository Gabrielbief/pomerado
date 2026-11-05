/**
 * Splits the browser tests into CI shards of about equal duration, and records each test's duration
 * for the next plan. .github/workflows/check.yml runs it.
 *
 * Playwright's own `--shard` gives each shard an equal number of tests in file order. The tests
 * differ in length by up to a hundred times, so some shards took several times as long as others.
 * This plan uses each test's duration from the latest Release run on main instead, and Playwright's
 * `--test-list` to run each shard's tests.
 *
 * - `plan` reads `playwright test --list --reporter=json` and the durations, picks the shard count
 *   that keeps each shard's share near the target, and writes `shard-<k>.txt` (the test list) and
 *   `shard-<k>.json` (the tests the shard must report) for each shard. It prints `shards=[1,…,N]`
 *   for the workflow's matrix. A test without a recorded duration counts as the median of its
 *   file's recorded tests, or of all of them. Without any durations, every test counts as
 *   `--default-seconds`, which splits by count as Playwright does.
 * - `record` reads one shard's JSON report. It writes each test's duration, and fails when a test
 *   the plan gave the shard has no result, so a test the list missed can't pass unnoticed, or when
 *   a test took longer than `--budget-seconds`. One test longer than a shard's share sets the
 *   shortest time the whole run can take, so split such a test or give it a controlled clock.
 *
 * A test-list line names a file and a title path, and Playwright runs every test whose title path
 * starts with it. A file is planned whole, as one line, when its tests can't be named apart that
 * way: when a title holds the list's delimiter `›`, when one test's title path starts with another's,
 * or when the file runs tests in serial mode, whose tests must stay together.
 *
 * Usage:
 *   node tools/browser-shards.ts plan --tests <list.json> --durations <dir> --out <dir>
 *     [--target-seconds 100] [--workers 4] [--max-shards 12] [--default-seconds 3]
 *   node tools/browser-shards.ts record --results <report.json> --expected <shard-k.json>
 *     --out <durations.json> [--budget-seconds 100]
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const delimiter = " › ";

/** One test, by its file relative to the test directory and its title path within the file. */
export interface TestId {
  readonly file: string;
  readonly titles: readonly string[];
}

export const testKey = (test: TestId) => [test.file, ...test.titles].join(delimiter);

interface ReportSuite {
  readonly title?: unknown;
  readonly file?: unknown;
  readonly specs?: readonly ReportSpec[];
  readonly suites?: readonly ReportSuite[];
}

interface ReportSpec {
  readonly title?: unknown;
  readonly file?: unknown;
  readonly tests?: readonly { readonly results?: readonly { readonly duration?: unknown }[] }[];
}

interface ReportTest extends TestId {
  /** The last attempt's duration in seconds, when the report has one. */
  readonly seconds: number | undefined;
}

/** Every test in a Playwright JSON report, or in the output of `--list --reporter=json`. */
export const reportTests = (report: unknown): ReportTest[] => {
  const tests: ReportTest[] = [];
  const walk = (suite: ReportSuite, titles: readonly string[]) => {
    for (const spec of suite.specs ?? []) {
      if (typeof spec.file !== "string" || typeof spec.title !== "string")
        throw new Error("A report spec has no file or title.");
      for (const test of spec.tests ?? []) {
        const duration = test.results?.at(-1)?.duration;
        tests.push({
          file: spec.file,
          titles: [...titles, spec.title],
          seconds: typeof duration === "number" && Number.isFinite(duration) ? duration / 1000 : undefined,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, String(child.title)]);
  };
  const suites = (report as { suites?: unknown }).suites;
  if (!Array.isArray(suites)) throw new Error("The report has no suites.");
  // Each top-level suite is a file, whose title is the file name the specs already carry.
  for (const file of suites as ReportSuite[]) walk(file, []);
  return tests;
};

/** Recorded durations in seconds by test key, merged from every JSON file in `directory`. */
export const readDurations = (directory: string | undefined): Map<string, number> => {
  const durations = new Map<string, number>();
  if (directory === undefined || !existsSync(directory)) return durations;
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    for (const [key, seconds] of Object.entries(parsed))
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) durations.set(key, seconds);
  }
  return durations;
};

const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const startsWith = (titles: readonly string[], prefix: readonly string[]) =>
  prefix.length <= titles.length && prefix.every((title, index) => titles[index] === title);

/** Files whose tests a test list can't name one by one, so the plan keeps them whole. */
export const wholeFiles = (tests: readonly TestId[], serialFiles: ReadonlySet<string>): Set<string> => {
  const whole = new Set([...serialFiles].filter((file) => tests.some((test) => test.file === file)));
  const byFile = Map.groupBy(tests, (test) => test.file);
  for (const [file, fileTests] of byFile) {
    const named = fileTests.some((test) =>
      test.titles.some((title) => title.includes("›") || title !== title.trim() || title === ""),
    );
    const nested = fileTests.some((test, index) =>
      fileTests.some((other, otherIndex) => otherIndex !== index && startsWith(other.titles, test.titles)),
    );
    if (named || nested) whole.add(file);
  }
  return whole;
};

export interface PlanOptions {
  /** Seconds of test time each worker should get, which sets the shard count. */
  readonly targetSeconds: number;
  /** Playwright workers per shard. */
  readonly workers: number;
  readonly maxShards: number;
  /** Each test's estimate when no test has a recorded duration. */
  readonly defaultSeconds: number;
}

export interface Shard {
  /** Test-list lines, one per test or per whole file. */
  readonly lines: string[];
  /** Keys of every test the lines select. */
  readonly tests: string[];
  seconds: number;
}

export interface Plan {
  readonly shards: Shard[];
  /** How many tests had a recorded duration. */
  readonly known: number;
  readonly total: number;
}

export const plan = (
  tests: readonly TestId[],
  durations: ReadonlyMap<string, number>,
  serialFiles: ReadonlySet<string>,
  options: PlanOptions,
): Plan => {
  if (tests.length === 0) throw new Error("There are no browser tests to plan.");
  const recorded = tests.flatMap((test) => {
    const seconds = durations.get(testKey(test));
    return seconds === undefined ? [] : [{ test, seconds }];
  });
  const overall = median(recorded.map(({ seconds }) => seconds)) ?? options.defaultSeconds;
  const fileMedians = new Map(
    [...Map.groupBy(recorded, ({ test }) => test.file)].map(([file, rows]) => [
      file,
      median(rows.map(({ seconds }) => seconds)) ?? overall,
    ]),
  );
  const estimate = (test: TestId) =>
    durations.get(testKey(test)) ?? fileMedians.get(test.file) ?? overall;

  // A unit is one test-list line: a test, or a whole file.
  const whole = wholeFiles(tests, serialFiles);
  const units = new Map<string, { line: string; tests: string[]; seconds: number }>();
  for (const test of tests) {
    const line = whole.has(test.file) ? test.file : testKey(test);
    const unit = units.get(line) ?? { line, tests: [], seconds: 0 };
    unit.tests.push(testKey(test));
    unit.seconds += estimate(test);
    units.set(line, unit);
  }
  const total = [...units.values()].reduce((sum, unit) => sum + unit.seconds, 0);
  const count = Math.max(
    1,
    Math.min(options.maxShards, units.size, Math.ceil(total / (options.workers * options.targetSeconds))),
  );
  const shards: Shard[] = Array.from({ length: count }, () => ({ lines: [], tests: [], seconds: 0 }));
  // Longest first, each to the shard with the least time so far. Ties go by line, then shard
  // number, so every run with the same inputs makes the same plan.
  const ordered = [...units.values()].sort((a, b) => b.seconds - a.seconds || (a.line < b.line ? -1 : 1));
  for (const unit of ordered) {
    const shard = shards.reduce((least, candidate) => (candidate.seconds < least.seconds ? candidate : least));
    shard.lines.push(unit.line);
    shard.tests.push(...unit.tests);
    shard.seconds += unit.seconds;
  }
  for (const shard of shards) {
    shard.lines.sort();
    shard.tests.sort();
  }
  return { shards, known: recorded.length, total: tests.length };
};

/** Spec files that put a describe block in serial mode. */
const findSerialFiles = (testDirectory: string, files: ReadonlySet<string>): Set<string> =>
  new Set(
    [...files].filter((file) =>
      /describe\.serial\b|mode:\s*["']serial["']/u.test(readFileSync(join(testDirectory, file), "utf8")),
    ),
  );

const number = (value: string | undefined, fallback: number, name: string): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive number.`);
  return parsed;
};

const output = (line: string) => {
  const path = process.env["GITHUB_OUTPUT"];
  if (path) appendFileSync(path, `${line}\n`);
};

const summary = (text: string) => {
  console.log(text);
  const path = process.env["GITHUB_STEP_SUMMARY"];
  if (path) appendFileSync(path, `${text}\n`);
};

const runPlan = (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: {
      tests: { type: "string" },
      durations: { type: "string" },
      out: { type: "string" },
      "test-dir": { type: "string", default: "typescript/tests/browser" },
      "target-seconds": { type: "string" },
      workers: { type: "string" },
      "max-shards": { type: "string" },
      "default-seconds": { type: "string" },
    },
  });
  if (values.tests === undefined || values.out === undefined)
    throw new Error("plan needs --tests and --out.");
  const list = JSON.parse(readFileSync(values.tests, "utf8")) as { errors?: unknown };
  if (Array.isArray(list.errors) && list.errors.length > 0)
    throw new Error(`Listing the browser tests failed: ${JSON.stringify(list.errors).slice(0, 2000)}`);
  const tests = reportTests(list);
  const durations = readDurations(values.durations);
  const options: PlanOptions = {
    targetSeconds: number(values["target-seconds"], 100, "target-seconds"),
    workers: number(values.workers, 4, "workers"),
    maxShards: number(values["max-shards"], 12, "max-shards"),
    defaultSeconds: number(values["default-seconds"], 3, "default-seconds"),
  };
  const serialFiles = findSerialFiles(values["test-dir"], new Set(tests.map((test) => test.file)));
  const result = plan(tests, durations, serialFiles, options);
  mkdirSync(values.out, { recursive: true });
  result.shards.forEach((shard, index) => {
    writeFileSync(join(values.out ?? "", `shard-${index + 1}.txt`), `${shard.lines.join("\n")}\n`);
    writeFileSync(join(values.out ?? "", `shard-${index + 1}.json`), `${JSON.stringify(shard.tests)}\n`);
  });
  output(`shards=${JSON.stringify(result.shards.map((_, index) => index + 1))}`);
  if (result.known === 0)
    console.log("::warning::No recorded browser test durations were found, so the shards split by test count.");
  summary(
    [
      `Browser shards: ${result.shards.length}, for ${result.total} tests, ${result.known} with a recorded duration.`,
      ...result.shards.map(
        (shard, index) =>
          `- shard ${index + 1}: ${shard.tests.length} tests, ` +
          `about ${Math.round(shard.seconds / options.workers)} s with ${options.workers} workers`,
      ),
    ].join("\n"),
  );
};

const runRecord = (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: {
      results: { type: "string" },
      expected: { type: "string" },
      out: { type: "string" },
      "budget-seconds": { type: "string" },
    },
  });
  if (values.results === undefined || values.out === undefined) throw new Error("record needs --results and --out.");
  const tests = reportTests(JSON.parse(readFileSync(values.results, "utf8")));
  const durations: Record<string, number> = {};
  for (const test of tests)
    if (test.seconds !== undefined) durations[testKey(test)] = Math.round(test.seconds * 10) / 10;
  writeFileSync(values.out, `${JSON.stringify(durations)}\n`);
  const problems: string[] = [];
  if (values.expected !== undefined) {
    const reported = new Set(tests.map(testKey));
    const expected = JSON.parse(readFileSync(values.expected, "utf8")) as string[];
    const missing = expected.filter((key) => !reported.has(key));
    if (missing.length > 0)
      problems.push(`${missing.length} planned tests have no result, such as ${missing.slice(0, 5).join("; ")}`);
  }
  if (values["budget-seconds"] !== undefined) {
    const budget = number(values["budget-seconds"], 0, "budget-seconds");
    for (const test of tests)
      if (test.seconds !== undefined && test.seconds > budget)
        problems.push(
          `${testKey(test)} took ${Math.round(test.seconds)} s, over the ${budget} s budget for one ` +
            "browser test. Split it, or give its waits a controlled clock.",
        );
  }
  for (const problem of problems) console.log(`::error::${problem}`);
  if (problems.length > 0) process.exitCode = 1;
};

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "plan") runPlan(args);
    else if (command === "record") runRecord(args);
    else throw new Error("Usage: node tools/browser-shards.ts plan|record [options]");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
