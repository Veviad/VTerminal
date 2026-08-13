import { readFileSync } from "node:fs";

const path = new URL("./e5-release-manifest.json", import.meta.url);
const manifest = JSON.parse(readFileSync(path, "utf8"));

if (manifest.schema_version !== 1 || !Array.isArray(manifest.models) || manifest.models.length !== 2) {
  throw new Error("E5 release manifest must contain exactly the two schema-v1 models");
}

for (const model of manifest.models) {
  for (const field of ["source_repo", "source_revision", "source_safetensors_sha256", "source_safetensors_size", "gguf_quantization", "dimensions"]) {
    if (!model[field]) throw new Error(`${model.catalog_id}: missing ${field}`);
  }
  if (!/^[0-9a-f]{40}$/.test(model.source_revision)) {
    throw new Error(`${model.catalog_id}: source_revision must be an immutable commit`);
  }
  if (!/^[0-9a-f]{64}$/.test(model.source_safetensors_sha256)) {
    throw new Error(`${model.catalog_id}: invalid Safetensors SHA-256`);
  }
  if (manifest.status === "published") {
    for (const field of ["gguf_url", "gguf_size", "gguf_sha256", "minisign_signature"]) {
      if (!model[field]) throw new Error(`${model.catalog_id}: published manifest missing ${field}`);
    }
  }
}

console.log(`E5 manifest OK (${manifest.status})`);
