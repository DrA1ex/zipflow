# Local server and client API

Zipflow 1.9 runs standalone workflows through the same authenticated local
server boundary used by external clients. Running `zipflow` starts or reuses the
local service and drives the existing TUI through `zipflow/client`. The
temporary direct path is available only with `ZIPFLOW_DIRECT_MODE=1`.

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
