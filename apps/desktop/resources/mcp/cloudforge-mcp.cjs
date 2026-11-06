#!/usr/bin/env node
'use strict';

/**
 * Connects an MCP client that speaks stdio to CloudForge's local HTTP endpoint.
 *
 * The client starts this script; it forwards JSON-RPC messages to CloudForge and
 * writes the answers back. It holds no logic and has no dependencies, because it
 * ships as a single file and runs with CloudForge's own executable:
 *
 *   ELECTRON_RUN_AS_NODE=1 CloudForge cloudforge-mcp.cjs
 *
 * CLOUDFORGE_MCP_URL   the endpoint, default http://127.0.0.1:47821/mcp
 * CLOUDFORGE_MCP_TOKEN the token shown in CloudForge under Settings, MCP
 */

const url = process.env.CLOUDFORGE_MCP_URL || 'http://127.0.0.1:47821/mcp';
const token = process.env.CLOUDFORGE_MCP_TOKEN;

if (!token) {
  process.stderr.write(
    'CLOUDFORGE_MCP_TOKEN is not set. Copy the configuration from CloudForge, Settings, MCP.\n',
  );
  process.exit(1);
}

const STREAM_RETRY_MS = 3000;

let sessionId = null;
let protocolVersion = null;
let streamOpen = false;
let closing = false;
/** Everything waits for `initialize` to answer, because it sets the session. */
let initializing = Promise.resolve();

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function headers(extra) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    ...(protocolVersion ? { 'Mcp-Protocol-Version': protocolVersion } : {}),
    ...extra,
  };
}

/** Write every message found in a server-sent event stream. */
async function forwardEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const data = buffer
        .slice(0, end)
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      buffer = buffer.slice(end + 2);
      if (data) forwardMessage(JSON.parse(data));
    }
  }
}

function forwardMessage(message) {
  if (message && message.result && message.result.protocolVersion) {
    protocolVersion = message.result.protocolVersion;
  }
  write(message);
}

function explain(error) {
  const code = error && error.cause && error.cause.code;
  return code === 'ECONNREFUSED'
    ? 'CloudForge is not running, or its MCP server is switched off (Settings, MCP).'
    : `Could not reach CloudForge: ${error instanceof Error ? error.message : String(error)}`;
}

async function send(message) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(message),
    });
    const session = response.headers.get('mcp-session-id');
    if (session) sessionId = session;
    if (response.status === 202) return;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`CloudForge answered ${response.status}: ${text}`);
    }
    if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
      await forwardEvents(response.body);
    } else {
      forwardMessage(await response.json());
    }
  } catch (error) {
    if (message.id !== undefined) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: explain(error) } });
    } else {
      process.stderr.write(`${explain(error)}\n`);
    }
  }
}

/** Receive what the server sends on its own, such as a change in the tool list. */
async function followServer() {
  if (streamOpen) return;
  streamOpen = true;
  while (!closing && sessionId) {
    try {
      const response = await fetch(url, { method: 'GET', headers: headers() });
      if (response.status === 404 || response.status === 405) break;
      if (response.ok && response.body) await forwardEvents(response.body);
    } catch {
      // CloudForge restarted or the connection dropped: try again shortly.
    }
    if (!closing) await new Promise((resolve) => setTimeout(resolve, STREAM_RETRY_MS));
  }
  streamOpen = false;
}

function handleLine(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write('Ignored a line that is not JSON\n');
    return;
  }
  if (message.method === 'initialize') {
    initializing = send(message);
    return;
  }
  void initializing.then(async () => {
    await send(message);
    if (message.method === 'notifications/initialized') void followServer();
  });
}

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\n')) !== -1) {
    handleLine(pending.slice(0, end));
    pending = pending.slice(end + 1);
  }
});
process.stdin.on('end', () => {
  closing = true;
  const finish = () => process.exit(0);
  if (!sessionId) return finish();
  void fetch(url, { method: 'DELETE', headers: headers() }).then(finish, finish);
});
