#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import * as z from "zod/v4";

export const IMAGE_TOOL_NAMES = [
  "ui_to_artifact",
  "extract_text_from_screenshot",
  "diagnose_error_screenshot",
  "understand_technical_diagram",
  "analyze_data_visualization",
  "ui_diff_check",
  "analyze_image",
] as const;

type Environment = Record<string, string | undefined>;

export type VisionConfig = {
  provider: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  maxImageBytes: number;
  timeoutMs: number;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
};

export type ImageContent = {
  type: "image_url";
  image_url: { url: string };
};

type TextContent = {
  type: "text";
  text: string;
};

type SystemMessage = {
  role: "system";
  content: string;
};

type UserMessage = {
  role: "user";
  content: Array<ImageContent | TextContent>;
};

type VisionMessages = [SystemMessage, UserMessage];

const imageSourceSchema = z.string().min(1);
const promptSchema = z.string().min(1);

const mimeTypes: Record<string, string> = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const prompts = {
  analyzeImage:
    "Analyze the provided image according to the user request. Be precise, practical, and mention uncertainty when details are not visible.",
  textExtraction:
    "Extract visible text from the screenshot. Preserve code, logs, whitespace, line breaks, and ordering as accurately as possible.",
  errorDiagnosis:
    "Diagnose the error shown in the screenshot. Identify the likely cause, the relevant evidence, and concrete next steps.",
  diagram:
    "Explain the technical diagram. Identify components, relationships, flow, assumptions, and any unclear parts.",
  dataVisualization:
    "Analyze the chart or dashboard. Extract the key metrics, trends, comparisons, anomalies, and business implications.",
  uiDiff:
    "Compare the reference UI and actual UI. Report visible differences, severity, likely causes, and fixes.",
  uiArtifact: {
    code: "Turn the UI screenshot into implementation guidance or frontend code. Keep the result faithful to the visible layout and states.",
    prompt: "Write a clear prompt that another AI system can use to recreate the UI screenshot.",
    spec: "Extract a design specification from the UI screenshot, including layout, spacing, typography, colors, and component behavior.",
    description: "Describe the UI screenshot in natural language with enough detail to understand its structure and purpose.",
  },
};

export function loadVisionConfig(env: Environment = process.env): VisionConfig {
  const endpoint = env.VISION_ENDPOINT || endpointFromBaseUrl(env.VISION_BASE_URL);
  if (!endpoint) {
    throw new Error("VISION_ENDPOINT or VISION_BASE_URL is required");
  }

  const model = env.VISION_MODEL;
  if (!model) {
    throw new Error("VISION_MODEL is required");
  }

  return {
    provider: env.VISION_PROVIDER || "custom",
    endpoint,
    model,
    apiKey: env.VISION_API_KEY || env.OPENAI_API_KEY,
    maxImageBytes: readMegabytes(env.VISION_MAX_IMAGE_MB, 5) * 1024 * 1024,
    timeoutMs: readNumber(env.VISION_TIMEOUT_MS, 300_000),
    temperature: readOptionalNumber(env.VISION_TEMPERATURE),
    topP: readOptionalNumber(env.VISION_TOP_P),
    maxTokens: readOptionalNumber(env.VISION_MAX_TOKENS),
  };
}

function endpointFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }

  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function readMegabytes(value: string | undefined, fallback: number): number {
  const numberValue = readNumber(value, fallback);
  if (numberValue <= 0) {
    throw new Error("VISION_MAX_IMAGE_MB must be greater than 0");
  }
  return numberValue;
}

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new Error(`Invalid numeric environment value: ${value}`);
  }

  return numberValue;
}

function readOptionalNumber(value: string | undefined): number | undefined {
  return value ? readNumber(value, 0) : undefined;
}

function isRemoteUrl(source: string): boolean {
  try {
    const url = new URL(source);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function imageContentFromSource(
  source: string,
  maxBytes = 5 * 1024 * 1024,
): Promise<ImageContent> {
  if (isRemoteUrl(source)) {
    return { type: "image_url", image_url: { url: source } };
  }

  const stats = await stat(source);
  if (!stats.isFile()) {
    throw new Error(`Image source is not a file: ${source}`);
  }

  if (stats.size > maxBytes) {
    throw new Error(
      `Image file is too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB`,
    );
  }

  const extension = extname(source).toLowerCase();
  const mimeType = mimeTypes[extension];
  if (!mimeType) {
    throw new Error(`Unsupported image format: ${extension || "(none)"}`);
  }

  const bytes = await readFile(source);
  return {
    type: "image_url",
    image_url: { url: `data:${mimeType};base64,${bytes.toString("base64")}` },
  };
}

export function buildVisionMessages(
  systemPrompt: string,
  prompt: string,
  images: ImageContent[],
): VisionMessages {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: [...images, { type: "text", text: prompt }] },
  ];
}

async function analyzeImageSources(
  config: VisionConfig,
  sources: string[],
  systemPrompt: string,
  prompt: string,
): Promise<string> {
  const images: ImageContent[] = [];
  for (const source of sources) {
    images.push(await imageContentFromSource(source, config.maxImageBytes));
  }

  return callVisionEndpoint(config, buildVisionMessages(systemPrompt, prompt, images));
}

async function callVisionEndpoint(
  config: VisionConfig,
  messages: VisionMessages,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: false,
  };
  if (config.temperature !== undefined) {
    body.temperature = config.temperature;
  }
  if (config.topP !== undefined) {
    body.top_p = config.topP;
  }
  if (config.maxTokens !== undefined) {
    body.max_tokens = config.maxTokens;
  }

  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return extractVisionText(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Vision endpoint timed out after ${config.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractVisionText(payload: unknown): string {
  const root = asRecord(payload);
  const choices = root ? root.choices : undefined;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("Vision endpoint response did not include choices");
  }

  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const content = message?.content;

  if (typeof content === "string" && content.trim()) {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => asRecord(part)?.text)
      .filter((part): part is string => typeof part === "string")
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }

  throw new Error("Vision endpoint response did not include message content");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function toolResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

function withOptionalHint(prompt: string, tag: string, value: string | undefined): string {
  return value?.trim() ? `${prompt}\n\n<${tag}>${value}</${tag}>` : prompt;
}

export function createServer(configLoader: () => VisionConfig = loadVisionConfig): McpServer {
  const server = new McpServer({
    name: "custom-vision-mcp-server",
    version: "0.1.0",
  });

  const analyze = async (sources: string[], systemPrompt: string, prompt: string) =>
    analyzeImageSources(configLoader(), sources, systemPrompt, prompt);

  server.registerTool(
    "ui_to_artifact",
    {
      title: "UI to Artifact",
      description: "Convert a UI screenshot into code guidance, a recreation prompt, a design spec, or a description.",
      inputSchema: {
        image_source: imageSourceSchema,
        output_type: z.enum(["code", "prompt", "spec", "description"]),
        prompt: promptSchema,
      },
    },
    async ({ image_source, output_type, prompt }) => {
      try {
        return toolResponse(
          await analyze([image_source], prompts.uiArtifact[output_type], prompt),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "extract_text_from_screenshot",
    {
      title: "Extract Text from Screenshot",
      description: "Extract visible text from a screenshot, including code, logs, terminal output, and documents.",
      inputSchema: {
        image_source: imageSourceSchema,
        prompt: promptSchema,
        programming_language: z.string().optional(),
      },
    },
    async ({ image_source, prompt, programming_language }) => {
      try {
        const enhancedPrompt = withOptionalHint(
          prompt,
          "programming_language",
          programming_language,
        );
        return toolResponse(await analyze([image_source], prompts.textExtraction, enhancedPrompt));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "diagnose_error_screenshot",
    {
      title: "Diagnose Error Screenshot",
      description: "Analyze an error screenshot and suggest likely causes and fixes.",
      inputSchema: {
        image_source: imageSourceSchema,
        prompt: promptSchema,
        context: z.string().optional(),
      },
    },
    async ({ image_source, prompt, context }) => {
      try {
        const enhancedPrompt = withOptionalHint(prompt, "error_context", context);
        return toolResponse(await analyze([image_source], prompts.errorDiagnosis, enhancedPrompt));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "understand_technical_diagram",
    {
      title: "Understand Technical Diagram",
      description: "Explain architecture diagrams, flowcharts, UML, ER diagrams, and related technical drawings.",
      inputSchema: {
        image_source: imageSourceSchema,
        prompt: promptSchema,
        diagram_type: z.string().optional(),
      },
    },
    async ({ image_source, prompt, diagram_type }) => {
      try {
        const enhancedPrompt = withOptionalHint(prompt, "diagram_type", diagram_type);
        return toolResponse(await analyze([image_source], prompts.diagram, enhancedPrompt));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "analyze_data_visualization",
    {
      title: "Analyze Data Visualization",
      description: "Analyze charts, graphs, and dashboards for metrics, trends, anomalies, and implications.",
      inputSchema: {
        image_source: imageSourceSchema,
        prompt: promptSchema,
        analysis_focus: z.string().optional(),
      },
    },
    async ({ image_source, prompt, analysis_focus }) => {
      try {
        const enhancedPrompt = withOptionalHint(prompt, "analysis_focus", analysis_focus);
        return toolResponse(
          await analyze([image_source], prompts.dataVisualization, enhancedPrompt),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "ui_diff_check",
    {
      title: "UI Diff Check",
      description: "Compare a reference UI screenshot with an actual implementation screenshot.",
      inputSchema: {
        expected_image_source: imageSourceSchema,
        actual_image_source: imageSourceSchema,
        prompt: promptSchema,
      },
    },
    async ({ expected_image_source, actual_image_source, prompt }) => {
      try {
        const enhancedPrompt = `The first image is the expected reference UI. The second image is the actual UI.\n\n${prompt}`;
        return toolResponse(
          await analyze(
            [expected_image_source, actual_image_source],
            prompts.uiDiff,
            enhancedPrompt,
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "analyze_image",
    {
      title: "Analyze Image",
      description: "General-purpose image analysis for cases not covered by the specialized image tools.",
      inputSchema: {
        image_source: imageSourceSchema,
        prompt: promptSchema,
      },
    },
    async ({ image_source, prompt }) => {
      try {
        return toolResponse(await analyze([image_source], prompts.analyzeImage, prompt));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

export function redirectConsoleToStderr(): void {
  console.log = console.error.bind(console);
  console.info = console.error.bind(console);
  console.debug = console.error.bind(console);
}

async function main(): Promise<void> {
  redirectConsoleToStderr();
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
