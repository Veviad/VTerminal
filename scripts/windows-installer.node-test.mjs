import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repository = fileURLToPath(new URL("../", import.meta.url));
const tauriDirectory = path.join(repository, "src-tauri");

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(repository, relativePath), "utf8"));
}

async function bitmap(relativePath, expectedWidth, expectedHeight) {
  const bytes = await readFile(path.join(tauriDirectory, relativePath));
  assert.equal(bytes.toString("ascii", 0, 2), "BM", `${relativePath} must be a BMP`);
  assert.equal(bytes.readUInt32LE(14), 40, `${relativePath} must use the Windows 3.x BMP header`);
  assert.equal(bytes.readInt32LE(18), expectedWidth, `${relativePath} has the wrong width`);
  assert.equal(Math.abs(bytes.readInt32LE(22)), expectedHeight, `${relativePath} has the wrong height`);
  assert.equal(bytes.readUInt16LE(26), 1, `${relativePath} must have one color plane`);
  assert.equal(bytes.readUInt16LE(28), 24, `${relativePath} must be 24-bit RGB`);
  assert.equal(bytes.readUInt32LE(30), 0, `${relativePath} must be uncompressed`);
}

test("NSIS uses the Veviad icon and branded wizard artwork", async () => {
  const base = await json("src-tauri/tauri.conf.json");
  const windows = await json("src-tauri/tauri.windows.conf.json");
  const configuration = windows.bundle.windows;
  const nsis = configuration.nsis;

  assert.equal(configuration.allowDowngrades, false);
  assert.deepEqual(nsis.languages, ["English", "German"]);
  assert.equal(nsis.installerIcon, "icons/icon.ico");
  assert.equal(nsis.uninstallerIcon, "icons/icon.ico");
  assert.equal(nsis.headerImage, "windows/installer-header.bmp");
  assert.equal(nsis.uninstallerHeaderImage, "windows/installer-header.bmp");
  assert.equal(nsis.sidebarImage, "windows/installer-sidebar.bmp");
  assert.ok(base.bundle.icon.includes(nsis.installerIcon));

  await bitmap(nsis.headerImage, 150, 57);
  await bitmap(nsis.sidebarImage, 164, 314);
});

test("the Windows icon contains every required shell size", async () => {
  const bytes = await readFile(path.join(tauriDirectory, "icons/icon.ico"));
  assert.equal(bytes.readUInt16LE(0), 0, "ICO reserved field must be zero");
  assert.equal(bytes.readUInt16LE(2), 1, "ICO must contain icons");
  const count = bytes.readUInt16LE(4);
  const sizes = [];

  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = bytes[entry] || 256;
    const height = bytes[entry + 1] || 256;
    const length = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    assert.equal(width, height, `ICO frame ${index} must be square`);
    assert.ok(length > 0, `ICO frame ${index} must not be empty`);
    assert.ok(offset + length <= bytes.length, `ICO frame ${index} exceeds the file`);
    sizes.push(width);
  }

  assert.deepEqual(sizes.sort((left, right) => left - right), [16, 24, 32, 48, 64, 256]);
});

test("the local-model overlay bundles every staged runtime and backend DLL", async () => {
  const localModels = await json("src-tauri/tauri.windows.local-llm.conf.json");
  const resources = localModels.bundle.resources;
  assert.equal(resources["binaries/llama-runtime/*.dll"], "");
  assert.equal(resources["binaries/llama-backends/*.dll"], "llama-backends/");
});
