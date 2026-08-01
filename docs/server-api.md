# Local server and client API

Zipflow 1.9 runs standalone workflows through the same authenticated local
server boundary used by external clients. Running `zipflow` starts or reuses the
local service and drives the existing TUI through `zipflow/client`. The
direct path is retained only as a temporary diagnostic fallback through
`ZIPFLOW_DIRECT_MODE=1`; it is not the released default.

Start a headless daemon explicitly with:

```sh
zipflow serve
```

Runtime discovery, the bearer token, and the ownership lock are stored below
`~/.zipflow/runtime/`. The default endpoint is a private Unix socket. The server
does not bind TCP.

The protocol v1 resources cover hello/capability negotiation, projects,
workflow configuration, verified ZIP blobs, archive and check runs, operations,
revisioned semantic surfaces and actions, plans, diffs, bounded output, reports,
history, rollback, and ordered SSE events. OpenAPI and JSON Schema documents
are available from the authenticated local endpoint.

Clients must:

- validate API major, schema revision, server epoch, and capabilities;
- send an idempotency key for every mutation;
- send the advertised surface revision when executing an action;
- choose only advertised semantic actions and configured command IDs;
- resume SSE from a durably stored cursor;
- perform a full read resynchronization after an epoch change or `stream.gap`;
- never retry an unsafe mutation merely because its response was lost.

## Standalone interaction parity

The server-backed standalone TUI is the normal product mode. Its user-visible
interaction must remain equivalent to the Zipflow 1.8.3 baseline at commit
`f44e0cb127437ea6ce3e4c7773ccf553673d74dc`, including:

- path completion and deliberate double-Enter discovery of the newest archive;
- archive warnings, interpretation, changed-file groups, files, and diffs;
- per-file conflict decisions and dangerous-action confirmation;
- checks, failure analysis, manual and autopilot decisions;
- commit candidates, editing, skipping, amend and squash operations;
- run history, historical prompts and decisions, rollback, export, and
  source-archive keep, move, or delete disposition.

The server owns durable workflow state and filesystem mutations. The client may
own only ephemeral terminal state and client-local source-archive disposition
metadata. The checked-in baseline records complete client-backed parity;
future capability changes must keep that executable gate green rather than
hide regressions behind a separate UI mode.

The npm client is side-effect free:

```js
import { createZipflowClient } from 'zipflow/client';

const client = createZipflowClient({
  socketPath,
  token,
  client: { name: 'my-client', instanceId },
});
```

## Windows portability

The package can be installed on Windows and the client accepts local named-pipe
endpoints. Runtime discovery and endpoint identity are designed to carry the
same protocol without TCP. Server startup currently fails closed on Windows
until owner, DACL, and reparse-point validation is available; it does not
weaken authentication or filesystem checks as a compatibility fallback.
