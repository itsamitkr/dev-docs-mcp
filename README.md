# dev-docs

A test Lambda that proxies requests to an upstream remote MCP server.

## Why this exists

Claude's account-level custom connectors (the kind that sync to **claude.ai
web**) auto-allow only standard auth headers like `x-api-key`. The upstream
server authenticates with a non-standard `X-Goog-Api-Key` header, which
requires Anthropic connector review and org-admin beta access to use directly.

This proxy sidesteps that by renaming the header:

```
Claude (x-api-key)  ->  Lambda Function URL  ->  upstream MCP (X-Goog-Api-Key)
```

Claude sends its key as the standard `x-api-key`. The Lambda takes that same
value and forwards the request upstream as `X-Goog-Api-Key`, then streams the
response back. **The key is never stored in the Lambda** — it's supplied by
Claude on every request and simply re-headered. The function holds no secrets.

## What's here

| File               | Purpose                                            |
| ------------------ | -------------------------------------------------- |
| `src/index.mjs`    | Streaming pass-through proxy handler               |
| `src/package.json` | Function metadata (no dependencies)                |
| `template.yaml`    | SAM template: Lambda + Function URL (RESPONSE_STREAM) |

## Prerequisites

- An AWS account with the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) installed.
- An upstream API key. You add this directly in Claude; nothing is stored in AWS.

## Deploy

```powershell
sam build
sam deploy --guided
```

On the first `--guided` run, SAM asks for a stack name and region and saves your
answers to `samconfig.toml`. After that, `sam deploy` alone redeploys. There are
no secret parameters to pass.

When it finishes, copy the **`FunctionUrl`** value from the stack outputs. That
is your MCP endpoint.

## Connect Claude

### claude.ai web / Desktop (account connector, syncs everywhere)

1. Settings → **Connectors** → **Add custom connector**.
2. **Remote MCP server URL**: paste the `FunctionUrl` (no extra path).
3. When prompted for authentication, provide the header:
   - Header name: `x-api-key`
   - Value: your upstream API key
4. Save and connect. Requires a Pro/Max/Team/Enterprise plan.

### Claude Code (local)

```bash
claude mcp add dev-docs-g \
  --transport http <FunctionUrl> \
  --header "x-api-key: <your-api-key>"
```

## Verify

After connecting, ask Claude a question the upstream docs corpus can answer. If
it invokes the server's tools and returns results, the proxy is working.

You can also smoke-test the endpoint directly with an MCP `initialize` call:

```bash
curl -N -X POST "<FunctionUrl>" \
  -H "x-api-key: <your-api-key>" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

A `401` means no key was sent; a JSON-RPC `result` means it works. If the key
itself is invalid, the upstream server returns its own auth error.

## Security notes

- The Function URL uses `AuthType: NONE`. There is no shared secret in the
  Lambda — the upstream server validates the key that Claude passes through, so
  an invalid or missing key fails upstream (or at the `x-api-key` presence check).
- IAM auth on the Function URL isn't usable here because Claude can't sign
  SigV4 requests.
- Because the URL is open, anyone who finds it can relay requests upstream using
  *their own* valid key; they can't use yours (you never stored it). If you want
  to also gate access to the URL itself, put the function behind a WAF or add a
  second shared-secret header check.
