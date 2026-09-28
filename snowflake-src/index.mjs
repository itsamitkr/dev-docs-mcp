// dev-doc-s — an MCP server (Lambda, fronted by API Gateway) that answers
// questions about Snowflake using the official docs index at
// https://docs.snowflake.com/llms.txt.
//
// It speaks MCP over Streamable HTTP with plain JSON responses (stateless, no
// session, no SSE), which Claude's connectors accept. It exposes two tools:
//
//   search_snowflake_docs(query, limit)  -> ranked list of doc pages (title+url)
//   fetch_snowflake_doc(url)             -> the page's Markdown content
//
// The docs index is a tree of llms.txt files: the root lists sections, each
// section llms.txt lists pages, and page URLs end in .md (clean Markdown, so no
// HTML scraping needed). search parses the root, scores entries against the
// query, then drills one level into the best-matching sections to surface
// actual pages.

import https from "node:https";
import { URL } from "node:url";
import { timingSafeEqual } from "node:crypto";

// Shared secret callers must present as the `x-api-key` header. Configured via
// the API_KEY environment variable. If unset, the server stays open (useful for
// local testing), but in deployment API_KEY is always set.
const API_KEY = process.env.API_KEY;

const ROOT_INDEX = "https://docs.snowflake.com/llms.txt";
const DOCS_HOST = "docs.snowflake.com";
const SERVER_NAME = "dev-doc-s";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL = "2025-06-18";

const MAX_INDEX_FETCHES = 30; // budget of llms.txt files crawled per search
const MAX_DOC_CHARS = 60000; // cap returned page content
const CACHE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tiny fetch helper with in-memory cache, redirect handling, and a size cap.
// ---------------------------------------------------------------------------

const cache = new Map(); // url -> { body, expires }

function httpsGet(url, redirectsLeft = 3, maxBytes = 3_000_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          "User-Agent": "dev-doc-s-mcp/1.0 (+lambda)",
          Accept: "text/plain, text/markdown, */*",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          if (redirectsLeft <= 0) {
            reject(new Error("Too many redirects"));
            res.resume();
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          resolve(httpsGet(next, redirectsLeft - 1, maxBytes));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status} for ${url}`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new Error("Response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Upstream timeout")));
    req.end();
  });
}

async function fetchText(url) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.body;
  const body = await httpsGet(url);
  cache.set(url, { body, expires: Date.now() + CACHE_TTL_MS });
  return body;
}

// ---------------------------------------------------------------------------
// llms.txt parsing + scoring.
// ---------------------------------------------------------------------------

// Parse "- [Title](url): description" lines, tracking the current "## Section".
function parseIndex(markdown) {
  const entries = [];
  let section = "";
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.*\S)\s*$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const link = line.match(/^\s*[-*]\s*\[([^\]]+)\]\(([^)]+)\)\s*:?\s*(.*)$/);
    if (link) {
      const [, title, url, description] = link;
      entries.push({
        title: title.trim(),
        url: url.trim(),
        description: (description || "").trim(),
        section,
        isSectionIndex: /\/llms\.txt$/i.test(url.trim()),
      });
    }
  }
  return entries;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are",
  "how", "do", "i", "with", "what", "when", "where", "my", "me", "can", "use",
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function scoreEntry(entry, tokens) {
  const title = entry.title.toLowerCase();
  const desc = entry.description.toLowerCase();
  const path = entry.url.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (title.includes(t)) score += 5;
    if (desc.includes(t)) score += 2;
    if (path.includes(t)) score += 1;
  }
  // Down-weight noisy, dated pages so conceptual/reference docs rank first.
  if (path.includes("/release-notes/")) score *= 0.35;
  return score;
}

// Crawl the llms.txt tree breadth-first (root -> section indexes -> ...),
// bounded by MAX_INDEX_FETCHES, collecting every page entry. Section index
// titles are too generic to rank on, so we gather all pages and score those.
async function collectPages() {
  const pages = [];
  const visited = new Set();
  let queue = [ROOT_INDEX];
  let fetches = 0;

  while (queue.length > 0 && fetches < MAX_INDEX_FETCHES) {
    const budget = MAX_INDEX_FETCHES - fetches;
    const batch = queue.slice(0, budget);
    queue = queue.slice(budget);
    fetches += batch.length;

    const nextLevel = [];
    await Promise.all(
      batch.map(async (url) => {
        if (visited.has(url)) return;
        visited.add(url);
        try {
          const entries = parseIndex(await fetchText(url));
          for (const e of entries) {
            if (e.isSectionIndex) {
              if (!visited.has(e.url)) nextLevel.push(e.url);
            } else {
              pages.push(e);
            }
          }
        } catch {
          // Skip an index file that fails to load; the crawl continues.
        }
      })
    );
    queue = queue.concat(nextLevel);
  }
  return pages;
}

async function searchDocs(query, limit) {
  const tokens = tokenize(String(query || ""));
  if (tokens.length === 0) {
    return { results: [], note: "Provide a non-empty query." };
  }

  const pages = await collectPages();

  // Dedupe by URL (a page can appear under multiple indexes).
  const byUrl = new Map();
  for (const p of pages) {
    if (!byUrl.has(p.url)) byUrl.set(p.url, p);
  }

  const ranked = [...byUrl.values()]
    .map((p) => ({ ...p, score: scoreEntry(p, tokens) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (ranked.length === 0) {
    return {
      results: [],
      note: "No matching pages found. Try different or more specific keywords.",
    };
  }

  return {
    results: ranked.map((p) => ({
      title: p.title,
      url: p.url,
      section: p.section || undefined,
      description: p.description || undefined,
    })),
  };
}

async function fetchDoc(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error("Invalid URL.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== DOCS_HOST) {
    throw new Error(`Only https://${DOCS_HOST}/ URLs are allowed.`);
  }
  const text = await fetchText(parsed.toString());
  if (text.length > MAX_DOC_CHARS) {
    return (
      text.slice(0, MAX_DOC_CHARS) +
      `\n\n[...truncated at ${MAX_DOC_CHARS} characters. Fetch a more specific page for the rest.]`
    );
  }
  return text;
}

// ---------------------------------------------------------------------------
// MCP tool definitions + dispatch.
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "search_snowflake_docs",
    description:
      "Search the official Snowflake documentation index and return the most " +
      "relevant pages (title + URL) for a natural-language query. Use this " +
      "first, then fetch_snowflake_doc on the best result.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language search query about Snowflake.",
        },
        limit: {
          type: "integer",
          description: "Max number of pages to return (default 8).",
          default: 8,
          minimum: 1,
          maximum: 25,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_snowflake_doc",
    description:
      "Fetch the full Markdown content of a Snowflake documentation page by " +
      "its docs.snowflake.com URL (as returned by search_snowflake_docs).",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "A https://docs.snowflake.com/... page URL.",
        },
      },
      required: ["url"],
    },
  },
];

async function callTool(name, args) {
  if (name === "search_snowflake_docs") {
    const out = await searchDocs(args?.query, Math.min(Math.max(args?.limit ?? 8, 1), 25));
    return JSON.stringify(out, null, 2);
  }
  if (name === "fetch_snowflake_doc") {
    return await fetchDoc(args?.url);
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------
// JSON-RPC handling.
// ---------------------------------------------------------------------------

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleMessage(msg) {
  // Notifications (no id) get no response.
  if (msg == null || msg.id === undefined || msg.id === null) {
    return null;
  }
  const { id, method } = msg;

  if (method === "initialize") {
    const protocolVersion = msg.params?.protocolVersion || DEFAULT_PROTOCOL;
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") return rpcResult(id, { tools: TOOLS });

  if (method === "tools/call") {
    const { name, arguments: args } = msg.params || {};
    try {
      const text = await callTool(name, args);
      return rpcResult(id, { content: [{ type: "text", text }] });
    } catch (err) {
      return rpcResult(id, {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      });
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(obj),
});

// Case-insensitive header lookup (API Gateway lowercases, but stay defensive).
function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

// Constant-time comparison of the presented key against the configured secret.
function keyMatches(presented) {
  if (!API_KEY) return true; // open when no secret is configured
  if (typeof presented !== "string") return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const handler = async (event) => {
  const method = (
    event.requestContext?.http?.method ??
    event.httpMethod ??
    "POST"
  ).toUpperCase();

  // Gate every request on the shared secret.
  if (!keyMatches(getHeader(event.headers, "x-api-key"))) {
    return json(401, rpcError(null, -32001, "Unauthorized: missing or invalid x-api-key."));
  }

  // We don't offer a server-initiated SSE stream; reject GET cleanly.
  if (method === "GET") {
    return json(405, rpcError(null, -32000, "GET not supported; POST JSON-RPC."));
  }

  let raw = event.body ?? "";
  if (event.isBase64Encoded && raw) raw = Buffer.from(raw, "base64").toString("utf8");

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(400, rpcError(null, -32700, "Parse error: body is not valid JSON."));
  }

  // Batch request.
  if (Array.isArray(payload)) {
    const responses = [];
    for (const msg of payload) {
      const r = await handleMessage(msg);
      if (r) responses.push(r);
    }
    if (responses.length === 0) return { statusCode: 202, body: "" };
    return json(200, responses);
  }

  const response = await handleMessage(payload);
  if (!response) return { statusCode: 202, body: "" };
  return json(200, response);
};
