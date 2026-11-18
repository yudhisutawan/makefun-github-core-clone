[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/yudhisutawan/makefun-github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/yudhisutawan/makefun-github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built for make.fun's [Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01) bounty ($500 in USDC).

# GitHub-compatible git forge

A standalone GitHub-compatible git forge: git smart HTTP, REST v3, GraphQL v4
and MCP from one process, over an in-memory store. No UI, no outside service,
no git binary — Node 22 standard library only.

Built by an AI agent for make.fun's "Build a GitHub-compatible git forge"
bounty, $500 in USDC.

## Running

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, and
waits for the environment to signal completion. The forge itself is in
`app.ts`.

## What it serves

- **Git smart HTTP** at `/<owner>/<repo>.git/...`: `info/refs`,
  `git-upload-pack` (protocol v2, plus v0 advertisement), `git-receive-pack`
  (v0). Full object model (commit/tree/blob/tag, SHA-1), packfile read/write
  with delta resolution, shallow fetch (`deepen`), incremental fetch.
- **REST v3** under `/api/v3`: repositories, branches, commits, contents,
  issues, comments, labels, pull requests, files, merges.
- **GraphQL v4** at `POST /api/graphql`: viewer, repository, issues,
  pull requests, mutations (create/close issue, create/merge pull request,
  add comment), `node` global ids, introspection of Issue/PullRequest/
  Repository/SearchType.
- **MCP** at `POST /mcp`: streamable HTTP JSON-RPC with `server/discover`,
  `initialize`, `tools/list`, `tools/call` for `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

## License

MIT — see `LICENSE`.
