# WebSocket (Socket.IO) protocol

The socket runs on the same port as the API (`/socket.io`).

**Design rule:** the socket is for **listening**, not for writing. All changes go through the REST API, which validates them, checks permissions and writes the activity log. The server then broadcasts the result. This means there is only one place where writes are checked.

## Connecting

```js
const socket = io({ auth: { token: '<same JWT as REST>' } });
```

A bad or missing token gets a `connect_error` with message `UNAUTHORIZED`.

On connect, the server puts the socket in these rooms:

| Room | Who is in it | Used for |
|---|---|---|
| `user:<userId>` | all tabs of one user | "your access changed" |
| `org:<orgId>` | every org the user belongs to | "branch list changed" |
| `tenant:<tenantId>` | **only after `tenant:join`**, and only one at a time | all board data and presence |

## Client → server

| Event | Payload | Ack / effect |
|---|---|---|
| `tenant:join` | `{ tenantId }` | ack `{ ok: true, role, presence: [...] }` or `{ ok: false, error }`. Access is checked with the same `getTenantAccess()` as REST. Joining a new branch leaves the old room. |
| `tenant:leave` | – | leaves the current branch room |
| `presence:update` | `{ boardId, focusTaskId }` | which board I'm on and which card I have open |

## Server → client (tenant room)

Every payload includes `tenantId`. The client ignores events whose `tenantId` isn't the branch on screen (defence in depth, e.g. events already in flight while switching branch).

| Event | Payload |
|---|---|
| `task:created` | `{ task, clientKey }` |
| `task:updated` | `{ task }` |
| `task:moved` | `{ task }` |
| `task:deleted` | `{ taskId, boardId }` |
| `task:restored` | `{ task }` |
| `tasks:reordered` | `{ columnId, positions: [{ id, position }] }`. Sent after a rebalance. |
| `column:created` / `column:updated` | `{ column }` |
| `column:deleted` | `{ columnId, boardId }` |
| `columns:reordered` | `{ boardId, positions }` |
| `board:created` / `board:updated` | `{ board }` |
| `board:deleted` | `{ boardId }` |
| `activity:new` | `{ activity }` |
| `presence:update` | `{ users: [{ userId, name, color, boardId, focusTaskId, tabs }] }` |
| `members:changed` | `{}`. The client reloads `/members`. |

## Server → client (personal / org)

| Event | Payload | Meaning |
|---|---|---|
| `tenant:kicked` | `{ tenantId, reason }` | you were removed from the branch, or it was deleted. The socket has already been taken out of the room. |
| `access:changed` | `{}` | your memberships changed. Reload `/auth/me`. |
| `org:changed` | `{ orgId, deleted? }` | branches were added, renamed or deleted |

## How the client uses events

* **Dedupe by version:** a task event is applied only if `incoming.version >= local.version`. This also covers my own changes echoing back.
* **Own creates:** if `clientKey` is one of my pending creates, the event is ignored. The HTTP response swaps the temporary card for the real one.
* **Network recovery:** on `disconnect` the client sets `needsResync = true`. On the next `connect` it re-joins the branch and **re-downloads** the board, members and activity. Socket.IO reconnects by itself with backoff. While offline, a banner is shown and failed optimistic changes are rolled back.
