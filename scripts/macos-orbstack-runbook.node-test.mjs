import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Fixed repository fixture; no user-controlled path is read.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const source = readFileSync(new URL("../examples/runbooks/macos-orbstack-docker-cleanup/runbook.vrun.yaml", import.meta.url), "utf8");
const commands = new Map();
let step;
let phase;
for (const line of source.split("\n")) {
  if (line.startsWith("    - id: ")) step = line.slice("    - id: ".length);
  const match = /^      (check|apply|verify):$/.exec(line);
  if (match) phase = match[1];
  if (line.startsWith("          command: ")) {
    commands.set(`${step}/${phase}`, JSON.parse(line.slice("          command: ".length)));
  }
}

const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
const now = "2026-10-30T12:00:00Z";
const old = "2026-10-29T10:59:59.123456789Z";
const recent = "2026-10-30T11:00:00Z";
const boundary = "2026-10-29T12:00:00Z";
const offsetNow = "2026-10-30T08:51:48.950408645+01:00";
const offsetOld = "2026-10-28T23:30:00.123456789-05:00";
const normalizeTimestamp = (stamp) => {
  const zoneLength = stamp.endsWith("Z") ? 1 : 6;
  const zone = stamp.slice(-zoneLength);
  const dateAndTime = stamp.slice(0, -zoneLength);
  const fraction = dateAndTime.indexOf(".");
  const wholeSeconds = fraction < 0 ? dateAndTime : dateAndTime.slice(0, fraction);
  return wholeSeconds + (zone === "Z" ? "+0000" : zone.replace(":", ""));
};

// All executable commands go to these temporary shell stubs. The host's Docker
// executable and daemon are never invoked, including when testing apply phases.
function run(key, scenario = {}) {
  const root = mkdtempSync(join(tmpdir(), "orbstack runbook "));
  const docker = join(root, "docker stub");
  const config = join(root, "config with ' quote");
  const date = join(root, "date stub");
  const log = join(root, "calls");
  // All paths here are generated inside this test's private temporary directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(config);
  const candidates = scenario.containers ?? [];
  const timestampCases = [now, old, recent, boundary, offsetNow, offsetOld, scenario.now, ...candidates.map((item) => item.created)].filter((stamp) => Number.isFinite(Date.parse(stamp))).map((stamp) => {
    const normalized = normalizeTimestamp(stamp);
    return `${quote(normalized)}) printf '%s\\n' ${Math.floor(Date.parse(stamp) / 1000)};;`;
  }).join("\n");
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(date, `#!/bin/sh\ntest "$1 $2 $3 $5" = '-ju -f %Y-%m-%dT%H:%M:%S%z +%s' || exit 98\ncase "$4" in\n${timestampCases}\n*) exit 1;;\nesac\n`, { mode: 0o700 });
  const inspectCases = candidates.map(({ id, created }) => `${quote(id)}) printf '%s\\n' ${quote(created)};;`).join("\n");
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(docker, `#!/bin/sh
test "$1" = --config && test "$2" = ${quote(config)} && test "$3" = --context && test "$4" = orbstack || exit 97
shift 4
printf '%s\\n' "$*" >> ${quote(log)}
case "$1 $2" in
'context inspect') ${scenario.contextFailure ? "exit 17" : `printf '%s\\n' ${quote(scenario.endpoint ?? "unix:///tmp/orbstack.sock")}`};;
'info --format') ${scenario.infoFailure ? "exit 17" : `printf '%s\\n' ${quote(scenario.now ?? now)}`};;
'container ls')
  case "$*" in
    *ancestor=*) ${scenario.referenceFailure ? "exit 17" : `printf '%s' ${quote(scenario.usedImage ? "using-container" : "")}`};;
    *) ${scenario.listFailure ? "exit 17" : `printf '%s' ${quote(candidates.map((item) => item.id).join("\n"))}`};;
  esac;;
'container inspect')
  ${scenario.inspectFailure ? "exit 17" : `case "$5" in\n${inspectCases}\n*) exit 99;;\nesac`};;
'image ls') ${scenario.imageFailure ? "exit 17" : `printf '%s' ${quote(scenario.images ?? "")}`};;
'system df'|'container prune'|'image prune'|'builder prune') exit ${scenario.actionFailure ? 17 : 0};;
*) exit 96;;
esac
`, { mode: 0o700 });
  try {
    const command = commands.get(key);
    assert.ok(command, `missing shell phase ${key}`);
    // The BSD date adapter makes these behavioral cases portable to Linux CI.
    // Production always executes macOS /bin/date with these same arguments.
    const adapted = command.replaceAll("/bin/date", quote(date));
    const semantic = `/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C VRUN_DOCKER_BINARY=${quote(docker)} VRUN_DOCKER_CONFIG_DIR=${quote(config)} /bin/sh -c ${quote(adapted)}`;
    const result = spawnSync("/bin/sh", ["-c", semantic], { env: {}, encoding: "utf8" });
    assert.equal(result.error, undefined);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const calls = readFileSync(log, "utf8");
    assert.doesNotMatch(calls, /volume prune|system prune|--all.*prune|prune.*--all/);
    return { ...result, calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("local context check rejects remote endpoints and CLI failures", () => {
  assert.equal(run("local-orbstack-context/check").status, 0);
  assert.equal(run("local-orbstack-context/check", { endpoint: "tcp://remote:2375" }).status, 64);
  assert.equal(run("local-orbstack-context/check", { endpoint: "" }).status, 64);
  assert.equal(run("local-orbstack-context/check", { contextFailure: true }).status, 2);
});

test("container check and verification use creation age with an exclusive 24-hour cutoff", () => {
  for (const phase of ["check", "verify"]) {
    const key = `old-stopped-containers/${phase}`;
    assert.equal(run(key).status, 0);
    assert.equal(run(key, { containers: [{ id: "recent", created: recent }] }).status, 0);
    assert.equal(run(key, { containers: [{ id: "boundary", created: boundary }] }).status, 0);
    const result = run(key, { containers: [{ id: "old", created: old }, { id: "recent", created: recent }] });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Eligible stopped container.*old/);
    assert.doesNotMatch(result.stdout, /recent/);
    assert.match(result.calls, /status=created.*status=exited.*status=dead/);
    assert.equal(run(key, { now: offsetNow, containers: [{ id: "offset-old", created: offsetOld }] }).status, 1);
    for (const scenario of [{ infoFailure: true }, { listFailure: true }, { containers: [{ id: "old", created: old }], inspectFailure: true }, { containers: [{ id: "bad", created: "invalid-date" }] }]) {
      assert.equal(run(key, scenario).status, 2);
    }
  }
});

test("native macOS date parses Docker RFC3339 timestamps with Z and positive or negative offsets", { skip: process.platform !== "darwin" }, () => {
  const command = commands.get("old-stopped-containers/check");
  const parser = command.slice(0, command.indexOf("now=$("));
  assert.ok(parser.startsWith("parse_time()"));
  for (const stamp of [now, old, offsetNow, offsetOld]) {
    const result = spawnSync("/bin/sh", ["-c", `${parser}parse_time ${quote(stamp)}`], { env: {}, encoding: "utf8" });
    assert.equal(result.status, 0, `${stamp}: ${result.stderr}`);
    assert.equal(Number(result.stdout.trim()), Math.floor(Date.parse(stamp) / 1000), stamp);
  }
});

test("image checks retain dangling images still referenced by a container and propagate errors", () => {
  for (const phase of ["check", "verify"]) {
    const key = `dangling-images/${phase}`;
    assert.equal(run(key).status, 0);
    assert.equal(run(key, { images: "sha256:unused" }).status, 1);
    assert.equal(run(key, { images: "sha256:used", usedImage: true }).status, 0);
    assert.equal(run(key, { imageFailure: true }).status, 2);
    assert.equal(run(key, { images: "sha256:unknown", referenceFailure: true }).status, 2);
  }
});

test("disk observations and bounded prune commands preserve Docker exit status", () => {
  const expected = new Map([
    ["docker-space-before/check", "system df"],
    ["docker-space-after/check", "system df"],
    ["old-stopped-containers/apply", "container prune --force --filter until=24h"],
    ["dangling-images/apply", "image prune --force"],
    ["old-dangling-build-cache/apply", "builder prune --force --filter until=168h"],
  ]);
  for (const [key, argv] of expected) {
    assert.equal(run(key).status, 0);
    assert.equal(run(key).calls.trim(), argv);
    assert.equal(run(key, { actionFailure: true }).status, key.endsWith("/check") ? 2 : 17);
  }
});

test("shell commands fit the guarded PTY limit and use explicit Docker context", () => {
  for (const [key, command] of commands) {
    assert.ok(!/[\n\r]/.test(command), key);
    // Reserve enough room for nested input quoting and both engine wrappers.
    assert.ok(command.length < 1600, `${key}: ${command.length}`);
    if (key === "supported-macos-target/check" || key === "explicit-docker-inputs/check") continue;
    assert.ok(command.includes('"$VRUN_DOCKER_BINARY" --config "$VRUN_DOCKER_CONFIG_DIR" --context orbstack'), key);
    assert.doesNotMatch(command, /\bsudo\b|context use|(?<!\|)\|(?!\|)/);
  }
});
