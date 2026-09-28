// MCP proxy Lambda for an upstream remote MCP server.
//
// Fronted by API Gateway (HTTP API, payload format 2.0). Claude connects to the
// API Gateway endpoint and sends a standard `x-api-key` header. This function:
//   1. Reads the caller's `x-api-key` value.
//   2. Forwards the MCP JSON-RPC request upstream, sending that same value in
//      the `X-Goog-Api-Key` header that the upstream server requires.
//   3. Returns the upstream response (JSON or buffered text/event-stream).
//
// The key is never stored in the Lambda. It's supplied by the client on every
// request and simply re-headered upstream, so this function holds no secrets.
//
// API Gateway buffers responses, so this is a standard (non-streaming) handler
// that returns the proxy response format { statusCode, headers, body }.

import https from "node:https";
import { URL } from "node:url";

const UPSTREAM_URL =
  process.env.UPSTREAM_MCP_URL ?? "https://developerknowledge.googleapis.com/mcp";

// Headers forwarded from the client -> upstream.
const FORWARD_TO_UPSTREAM = new Set([
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

// Headers forwarded from upstream -> client.
const FORWARD_TO_CLIENT = new Set([
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
]);

function jsonResponse(statusCode, obj) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
    isBase64Encoded: false,
  };
}

// Pull an incoming header regardless of casing.
function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

export const handler = async (event) => {
  const headers = event.headers ?? {};
  const method = (
    event.requestContext?.http?.method ??
    event.httpMethod ??
    "POST"
  ).toUpperCase();

  // 1. Read the key the client supplied. There is no stored secret to compare
  //    against; the upstream server is the one that validates it.
  const presented = getHeader(headers, "x-api-key");
  if (!presented) {
    return jsonResponse(401, {
      error: "unauthorized",
      message: "Missing x-api-key header.",
    });
  }

  // 2. Build the upstream request, re-headering the client's key.
  const upstream = new URL(UPSTREAM_URL);
  const outboundHeaders = { "X-Goog-Api-Key": presented };
  for (const [key, value] of Object.entries(headers)) {
    if (FORWARD_TO_UPSTREAM.has(key.toLowerCase()) && value !== undefined) {
      outboundHeaders[key] = value;
    }
  }
  // MCP Streamable HTTP clients must accept both JSON and SSE. Default it so
  // the upstream doesn't reject the request with 406.
  if (!getHeader(outboundHeaders, "accept")) {
    outboundHeaders["Accept"] = "application/json, text/event-stream";
  }

  // Decode the request body. API Gateway base64-encodes binary bodies.
  let body;
  if (event.body !== undefined && event.body !== null) {
    body = event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : Buffer.from(event.body);
  }

  const options = {
    hostname: upstream.hostname,
    port: upstream.port || 443,
    path: upstream.pathname + upstream.search,
    method,
    headers: outboundHeaders,
  };

  return await new Promise((resolve) => {
    const req = https.request(options, (upstreamRes) => {
      const chunks = [];
      upstreamRes.on("data", (chunk) => chunks.push(chunk));
      upstreamRes.on("end", () => {
        const outHeaders = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (FORWARD_TO_CLIENT.has(key.toLowerCase())) {
            outHeaders[key] = value;
          }
        }
        if (!outHeaders["content-type"]) {
          outHeaders["content-type"] = "application/json";
        }
        const payload = Buffer.concat(chunks);
        resolve({
          statusCode: upstreamRes.statusCode ?? 502,
          headers: outHeaders,
          body: payload.toString("base64"),
          isBase64Encoded: true,
        });
      });
      upstreamRes.on("error", (err) => {
        resolve(
          jsonResponse(502, {
            error: "bad_gateway",
            message: `Upstream response error: ${err.message}`,
          })
        );
      });
    });

    req.on("error", (err) => {
      resolve(
        jsonResponse(502, {
          error: "bad_gateway",
          message: `Upstream request failed: ${err.message}`,
        })
      );
    });

    if (body) req.write(body);
    req.end();
  });
};
