#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildReleaseData, fetchGithubMetadata, renderSite } from "./release-data.mjs";

function usage() {
  return [
    "Usage: node scripts/site-release/render.mjs --source <dir> --output <dir> [options]",
    "",
    "Options:",
    "  --fixture <json>       Use checked-in metadata instead of the live GitHub API.",
    "  --repository <owner/name>  Override GITHUB_REPOSITORY (default: Veviad/VTerminal).",
    "  --generated-at <ISO>   Override the generation timestamp (fixture tests only).",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}.`);
    args[name] = value;
    index += 1;
  }
  return args;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.source || !args.output) throw new Error(`--source and --output are required.\n\n${usage()}`);
  const repository = args.repository || env.GITHUB_REPOSITORY || "Veviad/VTerminal";
  let metadata;
  if (args.fixture) {
    metadata = JSON.parse(await readFile(resolve(args.fixture), "utf8"));
  } else {
    metadata = await fetchGithubMetadata({ token: env.GITHUB_TOKEN, repository });
  }
  const releaseData = buildReleaseData({
    repositoryData: metadata.repositoryData,
    releases: metadata.releases,
    repository,
    generatedAt: args.generated_at || new Date().toISOString(),
  });
  const result = await renderSite({
    sourceDir: args.source,
    outputDir: args.output,
    releaseData,
  });
  process.stdout.write(
    `Rendered ${releaseData.release.tag} (${releaseData.release.label}) with ${formatCount(releaseData.total_downloads)} downloads and ${formatCount(releaseData.repository.stars)} stars into ${result.relativeOutput}.\n`,
  );
}

function formatCount(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    process.stderr.write(`site-release: ${error.message}\n`);
    process.exitCode = 1;
  });
}
