import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const verifier = await readFile("scripts/verify-windows-installer.ps1", "utf8");

function bitmap(relativePath, bytes, expectedWidth, expectedHeight) {
  assert.equal(bytes.toString("ascii", 0, 2), "BM", `${relativePath} must be a BMP`);
  assert.equal(bytes.readUInt32LE(14), 40, `${relativePath} must use the Windows 3.x BMP header`);
  assert.equal(bytes.readInt32LE(18), expectedWidth, `${relativePath} has the wrong width`);
  assert.equal(Math.abs(bytes.readInt32LE(22)), expectedHeight, `${relativePath} has the wrong height`);
  assert.equal(bytes.readUInt16LE(26), 1, `${relativePath} must have one color plane`);
  assert.equal(bytes.readUInt16LE(28), 24, `${relativePath} must be 24-bit RGB`);
  assert.equal(bytes.readUInt32LE(30), 0, `${relativePath} must be uncompressed`);
}

test("NSIS uses the Veviad icon and branded wizard artwork", async () => {
  const base = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
  const windows = JSON.parse(await readFile("src-tauri/tauri.windows.conf.json", "utf8"));
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

  bitmap(
    nsis.headerImage,
    await readFile("src-tauri/windows/installer-header.bmp"),
    150,
    57,
  );
  bitmap(
    nsis.sidebarImage,
    await readFile("src-tauri/windows/installer-sidebar.bmp"),
    164,
    314,
  );
});

test("the Windows icon contains every required shell size", async () => {
  const bytes = await readFile("src-tauri/icons/icon.ico");
  assert.equal(bytes.readUInt16LE(0), 0, "ICO reserved field must be zero");
  assert.equal(bytes.readUInt16LE(2), 1, "ICO must contain icons");
  const count = bytes.readUInt16LE(4);
  const sizes = [];

  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = bytes.readUInt8(entry) || 256;
    const height = bytes.readUInt8(entry + 1) || 256;
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
  const localModels = JSON.parse(
    await readFile("src-tauri/tauri.windows.local-llm.conf.json", "utf8"),
  );
  const resources = localModels.bundle.resources;
  assert.equal(resources["binaries/llama-runtime/*.dll"], "");
  assert.equal(resources["binaries/llama-backends/*.dll"], "llama-backends/");
});

test("icon verification owns native handles and supports runspace reuse", () => {
  assert.match(verifier, /if \(-not \("VTerminal\.IconResource" -as \[type\]\)\) \{/);
  assert.match(
    verifier,
    /return \[Drawing\.Icon\]::FromHandle\(\$handles\[0\]\)\.Clone\(\)/,
  );
  assert.match(
    verifier,
    /finally \{\s+\[VTerminal\.IconResource\]::DestroyIcon\(\$handles\[0\]\)/,
  );
});

test("installer verification waits for GUI setup processes", () => {
  assert.match(
    verifier,
    /Start-Process -FilePath \$Executable -ArgumentList \$ArgumentList -Wait -PassThru/,
  );
});
