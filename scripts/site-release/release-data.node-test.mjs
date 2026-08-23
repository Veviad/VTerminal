import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  aggregateApplicationDownloads,
  buildReleaseData,
  compareSemVer,
  fetchGithubMetadata,
  formatBytes,
  formatInteger,
  parseSemVer,
  renderHtml,
  renderSite,
  selectLatestRelease,
} from "./release-data.mjs";

const fixtureDirectory = resolve("scripts/site-release/fixtures");

async function fixture(name) {
  return JSON.parse(await readFile(resolve(fixtureDirectory, name), "utf8"));
}

function copy(value) {
  return structuredClone(value);
}

function asset(tag, name, { size = 1000, downloads = 0 } = {}) {
  return {
    name,
    browser_download_url: `https://github.com/Veviad/VTerminal/releases/download/${tag}/${name}`,
    size,
    download_count: downloads,
    state: "uploaded",
  };
}

function completeRelease(tag, { prerelease = false, publishedAt = "2026-08-11T12:00:00Z" } = {}) {
  const parsed = parseSemVer(tag);
  assert.ok(parsed);
  return {
    tag_name: tag,
    draft: false,
    prerelease,
    published_at: publishedAt,
    html_url: `https://github.com/Veviad/VTerminal/releases/tag/${tag}`,
    assets: [
      asset(tag, `VTerminal_${parsed.version}_aarch64.dmg`, { size: 12_345_678, downloads: 2 }),
      asset(tag, "VTerminal.app.tar.gz", { downloads: 1 }),
      asset(tag, "VTerminal.app.tar.gz.sig"),
      asset(tag, `VTerminal_${parsed.version}_x64-setup.exe`, { size: 18_765_432 }),
      asset(tag, `VTerminal_${parsed.version}_x64-setup.exe.sig`),
      asset(tag, "latest.json"),
      asset(tag, "SHA256SUMS.txt"),
    ],
  };
}

function macOnlyRelease(tag, options) {
  const release = completeRelease(tag, options);
  release.assets = release.assets.filter(
    ({ name }) => !name.endsWith("_x64-setup.exe") && !name.endsWith("_x64-setup.exe.sig"),
  );
  return release;
}

test("selects the greatest published SemVer, including prereleases", async () => {
  const metadata = await fixture("releases.json");
  const selected = selectLatestRelease(metadata.releases);
  assert.equal(selected.semver.version, "0.3.0-beta.2");
  assert.equal(selected.release.prerelease, true);

  const stable = completeRelease("v0.3.0", { prerelease: false });
  const withStable = selectLatestRelease([...metadata.releases, stable]);
  assert.equal(withStable.semver.version, "0.3.0");
  assert.ok(compareSemVer(parseSemVer("v0.3.0"), parseSemVer("v0.3.0-beta.99")) > 0);
});

test("rejects invalid SemVer identifiers and ignores invalid, draft, and unpublished releases", async () => {
  assert.equal(parseSemVer("nightly-2026-08-13"), null);
  assert.equal(parseSemVer("v1.2.3-01"), null);
  assert.equal(parseSemVer("v01.2.3"), null);
  assert.equal(parseSemVer("v1.2"), null);
  assert.ok(
    compareSemVer(
      parseSemVer("v9007199254740993.0.0"),
      parseSemVer("v9007199254740992.999.999"),
    ) > 0,
  );
  const metadata = await fixture("releases.json");
  assert.equal(selectLatestRelease(metadata.releases).release.tag_name, "v0.3.0-beta.2");
});

test("fails rather than falling back when the highest release is incomplete", async () => {
  const metadata = await fixture("releases.json");
  const incomplete = completeRelease("v0.4.0");
  incomplete.assets = incomplete.assets.filter(({ name }) => name !== "latest.json");
  assert.throws(
    () => buildReleaseData({ repositoryData: metadata.repositoryData, releases: [...metadata.releases, incomplete] }),
    /exactly one latest\.json asset \(found 0\)/,
  );
});

test("accepts a legacy macOS-only latest release but rejects half-published Windows assets", async () => {
  const metadata = await fixture("releases.json");
  const legacy = metadata.releases.find(({ tag_name }) => tag_name === "v0.2.0");
  assert.ok(legacy, "legacy macOS-only release fixture is missing");
  const data = buildReleaseData({
    repositoryData: metadata.repositoryData,
    releases: [legacy],
    generatedAt: "2026-08-13T12:00:00Z",
  });

  assert.equal(data.windows, null);
  assert.deepEqual(data.updater_bytes, { "darwin-aarch64": 9_000_000 });

  const partial = macOnlyRelease("v0.2.1");
  partial.assets.push(asset("v0.2.1", "VTerminal_0.2.1_x64-setup.exe"));
  assert.throws(
    () => buildReleaseData({ repositoryData: metadata.repositoryData, releases: [partial] }),
    /must include both VTerminal_0\.2\.1_x64-setup\.exe and VTerminal_0\.2\.1_x64-setup\.exe\.sig, or neither/,
  );
});

test("does not silently regress to macOS-only after Windows has shipped", async () => {
  const metadata = await fixture("zero.json");
  const previous = completeRelease("v0.3.0", { publishedAt: "2026-08-10T12:00:00Z" });
  const regressed = macOnlyRelease("v0.3.1", { publishedAt: "2026-08-11T12:00:00Z" });

  assert.throws(
    () => buildReleaseData({
      repositoryData: metadata.repositoryData,
      releases: [previous, regressed],
    }),
    /cannot omit Windows assets after a Windows installer has been published/,
  );
});

test("rejects ambiguous duplicate highest release precedence", async () => {
  const metadata = await fixture("zero.json");
  const duplicate = completeRelease("0.1.0", { publishedAt: "2026-01-03T03:04:05Z" });
  assert.throws(
    () => selectLatestRelease([...metadata.releases, duplicate]),
    /Multiple published releases have the same highest SemVer precedence/,
  );
});

test("rejects duplicate required assets and a mismatched DMG filename", async () => {
  const metadata = await fixture("releases.json");
  const duplicate = completeRelease("v0.4.0");
  duplicate.assets.push(copy(duplicate.assets.find(({ name }) => name === "SHA256SUMS.txt")));
  assert.throws(
    () => buildReleaseData({ repositoryData: metadata.repositoryData, releases: [...metadata.releases, duplicate] }),
    /exactly one SHA256SUMS\.txt asset \(found 2\)/,
  );

  const mismatch = completeRelease("v0.4.0");
  mismatch.assets.find(({ name }) => name.endsWith("_aarch64.dmg")).name = "VTerminal_0.3.9_aarch64.dmg";
  assert.throws(
    () => buildReleaseData({ repositoryData: metadata.repositoryData, releases: [...metadata.releases, mismatch] }),
    /exactly one VTerminal_0\.4\.0_aarch64\.dmg asset \(found 0\)/,
  );

  const emptyUpdater = completeRelease("v0.4.0");
  emptyUpdater.assets.find(({ name }) => name === "VTerminal.app.tar.gz").size = 0;
  assert.throws(
    () => buildReleaseData({ repositoryData: metadata.repositoryData, releases: [...metadata.releases, emptyUpdater] }),
    /VTerminal\.app\.tar\.gz size must be a positive integer/,
  );

  const pendingSignature = completeRelease("v0.4.0");
  pendingSignature.assets.find(({ name }) => name.endsWith(".sig")).state = "new";
  assert.throws(
    () => buildReleaseData({ repositoryData: metadata.repositoryData, releases: [...metadata.releases, pendingSignature] }),
    /VTerminal\.app\.tar\.gz\.sig asset is not fully uploaded/,
  );
});

test("aggregates every published non-draft application download", async () => {
  const metadata = await fixture("releases.json");
  assert.equal(aggregateApplicationDownloads(metadata.releases), 1027);
  const selected = buildReleaseData({
    ...metadata,
    generatedAt: "2026-08-13T12:00:00Z",
  });
  assert.equal(selected.total_downloads, 1027);
  assert.equal(selected.repository.stars, 1234);
  assert.equal(selected.release.label, "Pre-release");
  assert.equal(selected.release.published_date, "10 Aug 2026");
  assert.equal(selected.dmg.formatted_size, "12.8 MB");
  assert.equal(selected.windows.formatted_size, "18.8 MB");
  assert.deepEqual(selected.updater_bytes, {
    "darwin-aarch64": 10_000_000,
    "windows-x86_64": 18_750_000,
  });
  assert.equal(formatInteger(1_234_567), "1,234,567");
  assert.equal(formatBytes(10_000_000), "10 MB");
});

test("rejects a GitHub prerelease flag that disagrees with SemVer", async () => {
  const metadata = await fixture("zero.json");
  const inconsistent = completeRelease("v0.2.0-rc.1", { prerelease: false });
  assert.throws(
    () => buildReleaseData({ repositoryData: metadata.repositoryData, releases: [...metadata.releases, inconsistent] }),
    /inconsistent GitHub prerelease status/,
  );
});

test("renders full zero counters instead of placeholders", async () => {
  const metadata = await fixture("zero.json");
  const data = buildReleaseData({ ...metadata, generatedAt: "2026-08-13T12:00:00Z" });
  const template = [
    '<script type="application/ld+json" data-release-jsonld>{"softwareVersion":"Latest"}</script>',
    '<strong data-release-text="stars">—</strong>',
    '<strong data-release-text="total_downloads">—</strong>',
  ].join("");
  const html = renderHtml(template, data);
  assert.equal((html.match(/<strong>0<\/strong>/g) || []).length, 2);
  assert.doesNotMatch(html, /data-release-/);
});

test("hides Windows release controls when the latest published release predates Windows", async () => {
  const metadata = await fixture("zero.json");
  const data = buildReleaseData({
    repositoryData: metadata.repositoryData,
    releases: [macOnlyRelease("v0.2.0")],
    generatedAt: "2026-08-13T12:00:00Z",
  });
  const template = [
    '<script type="application/ld+json" data-release-jsonld>{"softwareVersion":"Latest"}</script>',
    '<a data-release-platform="windows" data-release-href="windows" data-release-aria="windows_download">',
    '<span data-release-text="windows_name">Windows installer</span></a>',
    '<p data-release-platform="windows"><span data-release-text="windows_size">EXE</span></p>',
  ].join("");
  const html = renderHtml(template, data);

  assert.match(html, /<a[^>]*hidden[^>]*href="https:\/\/github\.com\/Veviad\/VTerminal\/releases\/tag\/v0\.2\.0"/);
  assert.match(html, /<p hidden><span>Not available for this release<\/span><\/p>/);
  assert.match(
    html,
    /"downloadUrl": "https:\/\/github\.com\/Veviad\/VTerminal\/releases\/download\/v0\.2\.0\/VTerminal_0\.2\.0_aarch64\.dmg"/,
  );
  assert.doesNotMatch(html, /data-release-/);
});

test("renders the checked-in Pages source and writes sanitized release.json", async (context) => {
  const metadata = await fixture("releases.json");
  const data = buildReleaseData({ ...metadata, generatedAt: "2026-08-13T12:00:00Z" });
  const temporary = await mkdtemp(join(tmpdir(), "vterminal-site-release-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const output = join(temporary, "site");
  await renderSite({ sourceDir: resolve("docs"), outputDir: output, releaseData: data });

  const html = await readFile(join(output, "index.html"), "utf8");
  const manifest = JSON.parse(await readFile(join(output, "release.json"), "utf8"));
  assert.doesNotMatch(html, /data-release-/);
  assert.doesNotMatch(html, /releases\/(?:download|tag)\/v(?!0\.3\.0-beta\.2)/);
  assert.doesNotMatch(html, /<strong>1,234<\/strong>/);
  assert.doesNotMatch(html, /<strong>1,027<\/strong>/);
  assert.match(html, /Published <span>10 Aug 2026<\/span>/);
  assert.match(html, /<code>VTerminal_0\.3\.0-beta\.2_aarch64\.dmg<\/code>/);
  assert.equal(
    (html.match(/href="https:\/\/github\.com\/Veviad\/VTerminal\/releases\/download\/v0\.3\.0-beta\.2\/VTerminal_0\.3\.0-beta\.2_aarch64\.dmg"/g) || []).length,
    4,
  );
  assert.equal(
    (html.match(/href="https:\/\/github\.com\/Veviad\/VTerminal\/releases\/download\/v0\.3\.0-beta\.2\/VTerminal_0\.3\.0-beta\.2_x64-setup\.exe"/g) || []).length,
    4,
  );
  assert.equal(
    (html.match(/href="https:\/\/github\.com\/Veviad\/VTerminal\/releases\/download\/v0\.3\.0-beta\.2\/SHA256SUMS\.txt"/g) || []).length,
    2,
  );
  assert.match(html, /aria-label="Download VTerminal 0\.3\.0-beta\.2 for macOS \(Apple Silicon\), 12\.8 MB\."/);
  assert.match(html, /aria-label="Download VTerminal 0\.3\.0-beta\.2 Windows 11 preview \(x64\), 18\.8 MB\."/);
  assert.match(html, /aria-label="Pre-release 0\.3\.0-beta\.2\. Read the release notes\."/);
  assert.match(html, /vterminal-terminal-ai\.webp/);
  assert.match(html, /vterminal-knowledge\.webp/);
  assert.match(html, /Pick Your Platform\. Start in Minutes\./);
  assert.match(html, /Verify and prepare Windows/);
  assert.match(html, /"softwareVersion": "0\.3\.0-beta\.2"/);
  assert.match(
    html,
    /"downloadUrl": \[\s*"https:\/\/github\.com\/Veviad\/VTerminal\/releases\/download\/v0\.3\.0-beta\.2\/VTerminal_0\.3\.0-beta\.2_aarch64\.dmg",\s*"https:\/\/github\.com\/Veviad\/VTerminal\/releases\/download\/v0\.3\.0-beta\.2\/VTerminal_0\.3\.0-beta\.2_x64-setup\.exe"\s*\]/,
  );
  assert.match(html, /"releaseNotes": "https:\/\/github\.com\/Veviad\/VTerminal\/releases\/tag\/v0\.3\.0-beta\.2"/);
  assert.match(html, /"datePublished": "2026-08-10T12:00:00\.000Z"/);
  assert.match(html, /"fileSize": "12\.8 MB"/);
  assert.equal(manifest.release.tag, "v0.3.0-beta.2");
  assert.equal(manifest.dmg.bytes, 12_750_000);
  assert.equal(manifest.windows.bytes, 18_750_000);
  assert.deepEqual(manifest.updater_bytes, {
    "darwin-aarch64": 10_000_000,
    "windows-x86_64": 18_750_000,
  });
  assert.equal(manifest.total_downloads, 1027);
  assert.deepEqual(Object.keys(manifest).sort(), [
    "checksum_url",
    "dmg",
    "generated_at",
    "release",
    "repository",
    "schema_version",
    "total_downloads",
    "updater_bytes",
    "windows",
  ]);
});

test("fails on unknown, malformed, or stale template markers", async () => {
  const metadata = await fixture("zero.json");
  const data = buildReleaseData({ ...metadata, generatedAt: "2026-08-13T12:00:00Z" });
  assert.throws(
    () => renderHtml('<span data-release-text="surprise">x</span>', data),
    /Unknown data-release-text marker/,
  );
  assert.throws(
    () => renderHtml('<span data-release-text="version"><b>x<\/b><\/span>', data),
    /must not contain nested markup/,
  );
  assert.throws(
    () =>
      renderHtml(
        '<script data-release-jsonld>{}</script><a href="https://github.com/Veviad/VTerminal/releases/tag/v9.9.9">old</a>',
        data,
      ),
    /stale release-scoped URL/,
  );
});

test("fetches every GitHub release page with authenticated requests", async () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ tag_name: `invalid-${index}` }));
  const secondPage = [{ tag_name: "v0.1.0" }];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    let body;
    if (url.endsWith("/repos/Veviad/VTerminal")) body = { stargazers_count: 0 };
    else if (url.endsWith("page=1")) body = firstPage;
    else if (url.endsWith("page=2")) body = secondPage;
    else assert.fail(`Unexpected request: ${url}`);
    return { ok: true, status: 200, json: async () => body };
  };
  const metadata = await fetchGithubMetadata({ token: "fixture-token", fetchImpl });
  assert.equal(metadata.releases.length, 101);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers.Authorization, "Bearer fixture-token");
  assert.match(calls[2].url, /per_page=100&page=2$/);
});
