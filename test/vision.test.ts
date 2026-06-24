import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMAGE_TOOL_NAMES,
  buildVisionMessages,
  imageContentFromSource,
  loadVisionConfig,
} from "../src/server.js";

const expectedTools = [
  "ui_to_artifact",
  "extract_text_from_screenshot",
  "diagnose_error_screenshot",
  "understand_technical_diagram",
  "analyze_data_visualization",
  "ui_diff_check",
  "analyze_image",
];

assert.deepEqual(IMAGE_TOOL_NAMES, expectedTools);

const config = loadVisionConfig({
  VISION_PROVIDER: "local",
  VISION_ENDPOINT: "http://localhost:11434/v1/chat/completions",
  VISION_MODEL: "llava",
  VISION_API_KEY: "test-key",
});

assert.equal(config.provider, "local");
assert.equal(config.endpoint, "http://localhost:11434/v1/chat/completions");
assert.equal(config.model, "llava");
assert.equal(config.apiKey, "test-key");

const dir = await mkdtemp(join(tmpdir(), "custom-vision-mcp-"));
try {
  const imagePath = join(dir, "sample.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const localImage = await imageContentFromSource(imagePath);
  assert.equal(localImage.type, "image_url");
  assert.match(localImage.image_url.url, /^data:image\/png;base64,/);

  const remoteImage = await imageContentFromSource("https://example.com/image.webp");
  assert.deepEqual(remoteImage, {
    type: "image_url",
    image_url: { url: "https://example.com/image.webp" },
  });

  const messages = buildVisionMessages("System", "Describe it", [localImage]);
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "user");
  assert.equal(messages[1]?.content.at(-1)?.type, "text");
} finally {
  await rm(dir, { recursive: true, force: true });
}
