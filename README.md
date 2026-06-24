# z_ai_vision_mcp_server_clone

OpenAI-compatible MCP server for running image analysis tools against your own vision model endpoint.

## Tools

- `ui_to_artifact`
- `extract_text_from_screenshot`
- `diagnose_error_screenshot`
- `understand_technical_diagram`
- `analyze_data_visualization`
- `ui_diff_check`
- `analyze_image`

## Configuration

Set either `VISION_ENDPOINT` or `VISION_BASE_URL`.

| Variable | Required | Description |
| --- | --- | --- |
| `VISION_ENDPOINT` | Yes, unless `VISION_BASE_URL` is set | Full chat completions endpoint. |
| `VISION_BASE_URL` | Yes, unless `VISION_ENDPOINT` is set | Base URL; `/chat/completions` is appended. |
| `VISION_MODEL` | Yes | Vision model name sent in the request body. |
| `VISION_API_KEY` | No | Bearer token. Omit for local endpoints that do not require auth. |
| `VISION_PROVIDER` | No | Label for your provider. Defaults to `custom`. |
| `VISION_MAX_IMAGE_MB` | No | Local image size limit. Defaults to `5`. |
| `VISION_TIMEOUT_MS` | No | Request timeout. Defaults to `300000`. |
| `VISION_TEMPERATURE` | No | Optional model temperature. |
| `VISION_TOP_P` | No | Optional model top_p. |
| `VISION_MAX_TOKENS` | No | Optional max_tokens. |

You can also place these values in a local `.env` file in the working directory where the server starts. Real environment variables override `.env` values.

## Run

```bash
npm install
npm run build
VISION_ENDPOINT=http://localhost:11434/v1/chat/completions VISION_MODEL=llava npm start
```

Or with `.env`:

```bash
npm start
```

## MCP Client Example

```json
{
  "mcpServers": {
    "z-ai-vision-clone": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "z_ai_vision_mcp_server_clone"],
      "env": {
        "VISION_ENDPOINT": "https://your-provider.com/v1/chat/completions",
        "VISION_MODEL": "your-vision-model",
        "VISION_API_KEY": "your-api-key"
      }
    }
  }
}
```
