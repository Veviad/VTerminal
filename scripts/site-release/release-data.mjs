import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const SEMVER =
  /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const TEXT_FIELDS = new Set([
  "version",
  "tag",
  "dmg_name",
  "dmg_size",
  "total_downloads",
  "stars",
  "release_label",
  "published_date",
]);
const HREF_FIELDS = new Set(["dmg", "release", "checksum"]);
const ARIA_FIELDS = new Set(["download", "announcement"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseSemVer(tag) {
  if (typeof tag !== "string") return null;
  const match = SEMVER.exec(tag.trim());
  if (!match) return null;
  return {
    tag: tag.trim(),
    version: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}${match[5] ? `+${match[5]}` : ""}`,
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSemVer(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    const compared = compareIdentifier(left[key], right[key]);
    if (compared !== 0) return compared;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const compared = compareIdentifier(left.prerelease[index], right.prerelease[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

function publishedRelease(release) {
  return (
    release &&
    release.draft === false &&
    typeof release.published_at === "string" &&
    !Number.isNaN(Date.parse(release.published_at)) &&
    parseSemVer(release.tag_name)
  );
}

export function selectLatestRelease(releases) {
  invariant(Array.isArray(releases), "GitHub releases response must be an array.");
  const eligible = releases
    .map((release) => ({ release, semver: publishedRelease(release) }))
    .filter(({ semver }) => Boolean(semver))
    .sort((left, right) => compareSemVer(right.semver, left.semver));
  invariant(eligible.length > 0, "No valid published SemVer release was found.");
  invariant(
    eligible.length === 1 || compareSemVer(eligible[0].semver, eligible[1].semver) !== 0,
    `Multiple published releases have the same highest SemVer precedence (${eligible[0].semver.version}).`,
  );
  return eligible[0];
}

function requireNonNegativeInteger(value, field) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${field} must be a non-negative integer.`);
  return value;
}

function matchingAsset(assets, name, tag) {
  const matches = assets.filter((asset) => asset?.name === name);
  invariant(matches.length === 1, `Release ${tag} must contain exactly one ${name} asset (found ${matches.length}).`);
  return matches[0];
}

function githubReleaseUrl(repository, tag) {
  return `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
}

function githubAssetUrl(repository, tag, name) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function validateGithubUrl(actual, expected, description) {
  invariant(typeof actual === "string", `${description} is missing its download URL.`);
  const normalized = new URL(actual).href;
  invariant(normalized === new URL(expected).href, `${description} has an unexpected GitHub URL.`);
  return expected;
}

export function validateSelectedAssets(release, semver, repository = "Veviad/VTerminal") {
  invariant(Array.isArray(release.assets), `Release ${semver.tag} has no asset list.`);
  const names = {
    dmg: `VTerminal_${semver.version}_aarch64.dmg`,
    updater: "VTerminal.app.tar.gz",
    signature: "VTerminal.app.tar.gz.sig",
    manifest: "latest.json",
    checksums: "SHA256SUMS.txt",
  };
  const selected = Object.fromEntries(
    Object.entries(names).map(([key, name]) => [key, matchingAsset(release.assets, name, semver.tag)]),
  );
  for (const [key, asset] of Object.entries(selected)) {
    validateGithubUrl(
      asset.browser_download_url,
      githubAssetUrl(repository, semver.tag, names[key]),
      `${names[key]} asset`,
    );
    requireNonNegativeInteger(asset.download_count, `${names[key]} download_count`);
    invariant(asset.state === "uploaded", `${names[key]} asset is not fully uploaded.`);
    invariant(
      Number.isSafeInteger(asset.size) && asset.size > 0,
      `${names[key]} size must be a positive integer.`,
    );
  }
  return selected;
}

export function aggregateApplicationDownloads(releases) {
  invariant(Array.isArray(releases), "GitHub releases response must be an array.");
  let total = 0;
  for (const release of releases) {
    if (
      !release ||
      release.draft !== false ||
      typeof release.published_at !== "string" ||
      Number.isNaN(Date.parse(release.published_at)) ||
      !Array.isArray(release.assets)
    ) {
      continue;
    }
    for (const asset of release.assets) {
      if (!asset?.name?.endsWith(".dmg") && asset?.name !== "VTerminal.app.tar.gz") continue;
      total += requireNonNegativeInteger(asset.download_count, `${asset.name} download_count`);
      invariant(Number.isSafeInteger(total), "Aggregate release downloads exceed JavaScript's safe integer range.");
    }
  }
  return total;
}

export function formatInteger(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function formatBytes(bytes) {
  invariant(Number.isSafeInteger(bytes) && bytes > 0, "Byte size must be a positive integer.");
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(bytes / 1_000_000)} MB`;
}

export function formatPublishedDate(value) {
  const date = new Date(value);
  invariant(!Number.isNaN(date.valueOf()), "Published date is invalid.");
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function validateRepository(repositoryData, repository) {
  invariant(repositoryData && typeof repositoryData === "object", "GitHub repository response is invalid.");
  const stars = requireNonNegativeInteger(repositoryData.stargazers_count, "stargazers_count");
  const expected = `https://github.com/${repository}`;
  if (repositoryData.html_url !== undefined) {
    validateGithubUrl(repositoryData.html_url, expected, "Repository");
  }
  return { stars, url: expected };
}

export function buildReleaseData({
  repositoryData,
  releases,
  repository = "Veviad/VTerminal",
  generatedAt = new Date().toISOString(),
}) {
  invariant(/^[-.A-Za-z0-9]+\/[-.A-Za-z0-9]+$/.test(repository), "Repository must use owner/name form.");
  const generated = new Date(generatedAt);
  invariant(!Number.isNaN(generated.valueOf()), "Generation timestamp is invalid.");
  const { release, semver } = selectLatestRelease(releases);
  const assets = validateSelectedAssets(release, semver, repository);
  const repositoryView = validateRepository(repositoryData, repository);
  const semanticPrerelease = semver.prerelease.length > 0;
  invariant(
    Boolean(release.prerelease) === semanticPrerelease,
    `Release ${semver.tag} has inconsistent GitHub prerelease status and SemVer precedence.`,
  );
  const prerelease = semanticPrerelease;
  const releaseUrl = githubReleaseUrl(repository, semver.tag);
  if (release.html_url !== undefined) validateGithubUrl(release.html_url, releaseUrl, "Release");
  const dmgUrl = githubAssetUrl(repository, semver.tag, assets.dmg.name);
  const checksumUrl = githubAssetUrl(repository, semver.tag, assets.checksums.name);
  const totalDownloads = aggregateApplicationDownloads(releases);
  const dmgSize = formatBytes(assets.dmg.size);
  const publishedDate = formatPublishedDate(release.published_at);
  const releaseLabel = prerelease ? "Pre-release" : "Latest release";

  return {
    schema_version: 1,
    release: {
      tag: semver.tag,
      version: semver.version,
      prerelease,
      label: releaseLabel,
      published_at: new Date(release.published_at).toISOString(),
      published_date: publishedDate,
      url: releaseUrl,
    },
    dmg: {
      name: assets.dmg.name,
      url: dmgUrl,
      bytes: assets.dmg.size,
      formatted_size: dmgSize,
    },
    // The desktop updater downloads the signed app archive rather than the
    // public DMG. Its exact size makes progress authoritative even when a CDN
    // response does not expose Content-Length.
    updater_bytes: {
      "darwin-aarch64": assets.updater.size,
    },
    checksum_url: checksumUrl,
    repository: {
      url: repositoryView.url,
      stars: repositoryView.stars,
    },
    total_downloads: totalDownloads,
    generated_at: generated.toISOString(),
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAttribute(tag, name, value) {
  const escaped = escapeHtml(value);
  const matcher = new RegExp(`\\s${escapeRegExp(name)}=(?:"[^"]*"|'[^']*')`, "i");
  if (matcher.test(tag)) return tag.replace(matcher, ` ${name}="${escaped}"`);
  return tag.replace(/>$/, ` ${name}="${escaped}">`);
}

function assertKnownMarkers(html) {
  const markerSets = [
    ["text", TEXT_FIELDS],
    ["href", HREF_FIELDS],
    ["aria", ARIA_FIELDS],
  ];
  for (const [kind, supported] of markerSets) {
    const matcher = new RegExp(`data-release-${kind}="([^"]+)"`, "g");
    for (const match of html.matchAll(matcher)) {
      invariant(supported.has(match[1]), `Unknown data-release-${kind} marker: ${match[1]}.`);
    }
  }
}

function markerValues(data) {
  const text = {
    version: data.release.version,
    tag: data.release.tag,
    dmg_name: data.dmg.name,
    dmg_size: data.dmg.formatted_size,
    total_downloads: formatInteger(data.total_downloads),
    stars: formatInteger(data.repository.stars),
    release_label: data.release.label,
    published_date: data.release.published_date,
  };
  const href = {
    dmg: data.dmg.url,
    release: data.release.url,
    checksum: data.checksum_url,
  };
  const aria = {
    download: `Download VTerminal ${data.release.version} for macOS (Apple Silicon), ${data.dmg.formatted_size}.`,
    announcement: `${data.release.label} ${data.release.version}. Read the release notes.`,
  };
  return { text, href, aria };
}

export function renderHtml(template, data) {
  invariant(typeof template === "string", "HTML template must be text.");
  assertKnownMarkers(template);
  const values = markerValues(data);
  let html = template;

  for (const [field, value] of Object.entries(values.text)) {
    const expectedCount = [...html.matchAll(new RegExp(`data-release-text="${escapeRegExp(field)}"`, "g"))].length;
    let replacementCount = 0;
    const matcher = new RegExp(
      `<([A-Za-z][\\w:-]*)([^>]*\\sdata-release-text="${escapeRegExp(field)}"[^>]*)>([\\s\\S]*?)<\\/\\1>`,
      "g",
    );
    html = html.replace(matcher, (whole, tagName, attributes, body) => {
      replacementCount += 1;
      invariant(!/<[A-Za-z!/]/.test(body), `data-release-text="${field}" must not contain nested markup.`);
      return `<${tagName}${attributes}>${escapeHtml(value)}</${tagName}>`;
    });
    invariant(
      replacementCount === expectedCount,
      `Could not replace every data-release-text="${field}" marker (${replacementCount}/${expectedCount}).`,
    );
  }

  const expectedHrefCount = [...html.matchAll(/data-release-href="[^"]+"/g)].length;
  let hrefCount = 0;
  html = html.replace(
    /<([A-Za-z][\w:-]*)([^>]*\sdata-release-href="([^"]+)"[^>]*)>/g,
    (tag, _name, _attributes, field) => {
      hrefCount += 1;
      return replaceAttribute(tag, "href", values.href[field]);
    },
  );
  invariant(hrefCount === expectedHrefCount, `Could not replace every data-release-href marker (${hrefCount}/${expectedHrefCount}).`);
  const expectedAriaCount = [...html.matchAll(/data-release-aria="[^"]+"/g)].length;
  let ariaCount = 0;
  html = html.replace(
    /<([A-Za-z][\w:-]*)([^>]*\sdata-release-aria="([^"]+)"[^>]*)>/g,
    (tag, _name, _attributes, field) => {
      ariaCount += 1;
      return replaceAttribute(tag, "aria-label", values.aria[field]);
    },
  );
  invariant(ariaCount === expectedAriaCount, `Could not replace every data-release-aria marker (${ariaCount}/${expectedAriaCount}).`);

  let jsonLdCount = 0;
  html = html.replace(
    /<script([^>]*\sdata-release-jsonld(?:=(?:"[^"]*"|'[^']*'))?[^>]*)>([\s\S]*?)<\/script>/g,
    (_whole, attributes, body) => {
      jsonLdCount += 1;
      let json;
      try {
        json = JSON.parse(body);
      } catch (error) {
        throw new Error(`Release JSON-LD is invalid: ${error.message}`);
      }
      json.softwareVersion = data.release.version;
      json.downloadUrl = data.dmg.url;
      json.releaseNotes = data.release.url;
      json.datePublished = data.release.published_at;
      json.fileSize = data.dmg.formatted_size;
      const serialized = JSON.stringify(json, null, 2).replaceAll("<", "\\u003c");
      return `<script${attributes}>\n${serialized}\n    </script>`;
    },
  );
  invariant(jsonLdCount > 0, "No data-release-jsonld marker was found.");

  html = html
    .replace(/\sdata-release-(?:text|href|aria)="[^"]*"/g, "")
    .replace(/\sdata-release-jsonld(?:=(?:"[^"]*"|'[^']*'))?/g, "");
  invariant(!/data-release-/.test(html), "Rendered HTML still contains unresolved release markers.");

  for (const match of html.matchAll(/https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/(?:download|tag)\/([^/"?#]+)/g)) {
    invariant(decodeURIComponent(match[1]) === data.release.tag, `Rendered HTML contains a stale release-scoped URL for ${match[1]}.`);
  }
  return html;
}

async function htmlFiles(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".html")) output.push(path);
    }
  }
  await visit(root);
  return output;
}

export async function renderSite({ sourceDir, outputDir, releaseData }) {
  const source = resolve(sourceDir);
  const output = resolve(outputDir);
  invariant(source !== output, "Source and output directories must differ.");
  invariant(!output.startsWith(`${source}${sep}`), "Output directory must not be inside the source site.");
  invariant(!source.startsWith(`${output}${sep}`), "Output directory must not contain the source site.");
  try {
    await lstat(output);
    throw new Error("Output directory already exists; choose a fresh staging path.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await mkdir(dirname(output), { recursive: true });
  await cp(source, output, { recursive: true });
  let renderedCount = 0;
  for (const file of await htmlFiles(output)) {
    const template = await readFile(file, "utf8");
    if (!template.includes("data-release-")) continue;
    await writeFile(file, renderHtml(template, releaseData), "utf8");
    renderedCount += 1;
  }
  invariant(renderedCount > 0, "The site contains no dynamic release markers.");
  await writeFile(
    resolve(output, "release.json"),
    `${JSON.stringify(releaseData, null, 2)}\n`,
    "utf8",
  );
  return { output, renderedCount, relativeOutput: relative(process.cwd(), output) };
}

export async function fetchGithubMetadata({
  token,
  repository = "Veviad/VTerminal",
  apiBase = "https://api.github.com",
  fetchImpl = globalThis.fetch,
}) {
  invariant(typeof token === "string" && token.trim() !== "", "GITHUB_TOKEN is required for live release rendering.");
  invariant(typeof fetchImpl === "function", "A Fetch API implementation is required.");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token.trim()}`,
    "User-Agent": "VTerminal-Pages-Renderer",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  async function request(path) {
    const response = await fetchImpl(`${apiBase}${path}`, { headers });
    invariant(response.ok, `GitHub API ${path} failed with HTTP ${response.status}.`);
    return response.json();
  }

  const repositoryData = await request(`/repos/${repository}`);
  const releases = [];
  for (let page = 1; ; page += 1) {
    invariant(page <= 100, "GitHub release pagination exceeded 10,000 releases.");
    const batch = await request(`/repos/${repository}/releases?per_page=100&page=${page}`);
    invariant(Array.isArray(batch), "GitHub releases page was not an array.");
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return { repositoryData, releases };
}
