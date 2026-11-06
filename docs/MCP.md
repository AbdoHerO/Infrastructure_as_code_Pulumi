# MCP server

CloudForge can let an AI assistant such as Claude work with your projects through
the [Model Context Protocol](https://modelcontextprotocol.io). The assistant sees
the same features you see in the window: 231 tools covering projects, cloud
infrastructure, servers, Docker, Nginx, certificates, Cloudflare, WordPress, Jenkins
and the rest.

It is **off until you turn it on**, it only accepts connections from this computer,
and it works only while CloudForge is open, on the project open in the window.

## Turn it on and connect a client

1. Open **Settings → MCP** and switch on **Enable MCP server**.
2. Under **Connect a client**, copy what your client needs:
   - **Claude Code:** click **Command for Claude Code** and run the copied command.
   - **Claude Desktop:** click **Configuration for Claude Desktop** and paste it into
     Claude Desktop's configuration file (Settings → Developer → Edit Config), then
     restart Claude Desktop.
   - **Another client:** use the address shown under **Enable MCP server** with the
     header `Authorization: Bearer <token>`. Clients that only start local programs
     use the same bridge script as Claude Desktop.
3. Open and unlock a project in CloudForge. The titlebar shows **MCP · 1** while a
   client is connected.

What you copy contains the access token, so treat it like a password. **Replace
token** disconnects every client and makes the old token useless.

## What a client may do

You decide this under **Settings → MCP**. A client cannot change these settings.

| Permission               | Default          | What it covers                                                                         |
| ------------------------ | ---------------- | -------------------------------------------------------------------------------------- |
| Read                     | On               | See projects, servers, settings, logs and status                                       |
| Make changes             | On               | Create and update things, deploy, install software, open firewall ports                |
| Critical actions         | Ask me each time | Delete, destroy, terminate, cause downtime, cost money, give access, restore, restart  |
| Read secrets             | Off              | Passwords, private keys and tokens would reach the AI and its provider                 |
| Run commands on servers  | Off              | The SSH terminal, and running a command on a saved server                              |
| Use this computer        | On               | Read and create files at given paths, the clipboard, open links; never replaces a file |
| Open and switch projects | Off              | A project's passkey would pass through the AI to open it                               |

**Toolsets** switch off whole areas, such as Cloudflare or Jenkins. The client no
longer sees those tools, which also keeps the assistant focused.

### Approving critical actions

When a client asks for a critical action, CloudForge comes to the front and shows
what is being asked, with secret values hidden. Choose **Allow this once** or
**Refuse**. If nobody answers before the time runs out, the action is refused. A
client has no way to answer for you.

## What protects you

These apply to a client exactly as they apply to you, because both use the same
application code.

- **Preview before change.** Infrastructure and VPS runtime changes need a token from
  a preview of that exact change. A plan with problems cannot be applied, and a
  preview that deletes or replaces something has to be accepted explicitly.
- **Exact names.** Deleting a project, terminating an instance and removing a passkey
  need the exact name.
- **Pinned servers.** A client refers to a saved VPS target by its id. CloudForge
  loads the address, the key and the fingerprint itself, so a client cannot point an
  SSH connection at another machine. A client can only save a fingerprint CloudForge
  has just read from that server.
- **Wrong project.** If you switch project while a client is working, its next action
  is refused until it has looked at which project is open.
- **Secrets stay out of the conversation where possible.** An environment file, a
  stack's `.env` and a private key can be read from a path by CloudForge itself.
  WordPress passwords are generated and kept in Secrets.
- **Everything is recorded.** Every call is logged, without its contents. Every change
  appears in the activity feed as `mcp.tool.called`, with the client's name.

What a client sends as a passkey, a credential value or a file's contents passes
through the AI provider. Use the path options where you can.

## Long-running work

A cloud apply or a software installation can take many minutes. Such a tool waits
for a while (45 seconds unless the client asks otherwise, up to 5 minutes). If the
work is still going, it answers with an `operationId` and carries on regardless,
just as it does if you leave the page.

| Tool                | What it does                                  |
| ------------------- | --------------------------------------------- |
| `operations_list`   | Operations started by clients, newest first   |
| `operations_get`    | State, result or error of one                 |
| `operations_wait`   | Wait for one to finish, up to a limit         |
| `operations_logs`   | Its log lines; pass `nextCursor` to follow it |
| `operations_cancel` | Ask it to stop                                |

Deployments and Ansible runs can stop. Other work cannot, and the tool says so.

## Prompts and resources

**Prompts** are the workflows the window walks you through, ready for the assistant
to follow: `onboard-vps`, `install-service`, `provision-infrastructure`,
`deploy-docker-stack`, `deploy-wordpress`, `publish-domain-https`,
`issue-ssl-certificate`, `review-firewall`, `runtime-drift-and-apply`,
`jenkins-pipeline`, `give-ssh-access`, `diagnose-site-down` and `backup-project`.

**Resources** are read-only context under `cloudforge://`: the open project, saved
targets, activity, logs, settings, the built-in catalogues and this documentation.
A client can subscribe and be told when they change.

## Troubleshooting

| What you see                                        | What to do                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| "No project is open"                                | Open and unlock a project in CloudForge                                                |
| "The project open in CloudForge has changed"        | The assistant should call `projects_get_session` and check with you                    |
| A tool is missing, or "is switched off"             | Allow it under **Settings → MCP**. `mcp_get_permissions` shows what a client may do    |
| "CloudForge is not running, or … switched off"      | Start CloudForge and check **Enable MCP server**                                       |
| "Port … is already in use"                          | Choose another port under **Settings → MCP**, then copy the client configuration again |
| 401 "A valid token is required"                     | The token was replaced. Copy the client configuration again                            |
| The connection dropped after a restore or an update | Those restart CloudForge. Reconnect the client and unlock the project                  |

## For developers

The server lives in `apps/desktop/src/main/mcp`. Tools call the same IPC handlers as
the window, through `dispatch` in `main/ipc/registry.ts`, so a request has the same
project boundary, operation lease and error envelope.

**Adding an IPC channel does not compile until `mcp/coverage.ts` says which tool
serves it**, or records why none does. `mcp-coverage.test.ts` checks that table
against the tools. To add a tool, add it to a file in `mcp/catalog`, then list it in
`coverage.ts`.

The `mcp:*` channels manage the server itself and are refused to tools on purpose: a
client must never be able to widen its own permissions or approve its own requests.

Its settings and encrypted token are device-level values (`mcp.settings` and
`mcp.token` in `SystemSetting`), separate from a project's settings, and not reachable
through `settings:update`.
