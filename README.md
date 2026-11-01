# 📋 TeamBoard: real-time collaborative Kanban (multi-org + multi-tenant)

TeamBoard is a Trello-style board where several **organizations** each have several **branches (tenants)**. People in the same branch see each other's changes live. People in other branches or other organizations can never see that data.

> Stack: **Node.js 22.13+ · Express 5 · Socket.IO 4 · SQLite (built-in `node:sqlite`) · plain HTML/CSS/JS (ES modules, no build step)**

---

## 1. Run it

```bash
npm install
npm start            # -> http://localhost:4000
npm test             # 22 automated tests (isolation, RBAC, conflicts, realtime)
npm run reset-db     # delete the DB, demo data is re-created on next start
```

There's no database server to install. The SQLite file is created in `data/` and filled with demo data on first start.

**Demo logins** (password `password123` for everyone, or click the buttons on the login screen):

| User | Organization | Branch(es) | Role |
|---|---|---|---|
| alice@acme.test | Acme Corp | all | **Org Admin** |
| bob@acme.test | Acme Corp | Hyderabad | **Tenant Admin** |
| carol@acme.test | Acme Corp | Hyderabad + Bangalore | Member |
| dan@acme.test | Acme Corp | Bangalore | Member |
| gina@globex.test | Globex Inc | all | **Org Admin** |
| omar@globex.test | Globex Inc | London | Member |

👉 **To see the realtime part:** open a normal window as Bob and a private window as Carol. Switch Carol to *Hyderabad Branch*, then drag cards around, edit the same task in both windows, and pull the network cable.

---

## 2. Project structure

```
server/
  index.js               starts HTTP + Socket.IO on one port
  app.js                 Express app + route mounting
  config.js
  db/        schema.sql, database.js (connection + transaction helper), seed.js
  middleware/ auth.js (JWT), access.js (loadTenant / requireRole), errorHandler.js
  services/  access.js   <- tenancy rules (used by REST *and* sockets)
             ordering.js <- fractional indexing + drag-drop conflict fallback
             boards.js, activity.js, auth.js
  routes/    auth, orgs, members, boards, columns, tasks, activity
  realtime/  socket.js (handshake, rooms), hub.js (emit helpers), presence.js
  utils/     httpError.js, validate.js, mappers.js
public/
  index.html, css/style.css
  js/ store.js      tiny global state + subscribe/notify
      api.js        fetch wrapper
      actions.js    optimistic actions + undo commands
      conflict.js   3-way merge
      history.js    undo/redo stack
      realtime.js   socket client + network recovery
      loaders.js    org/branch/board switching
      board.js      rendering + drag & drop
      taskPanel.js  task detail panel
      panels.js     activity log + members dialog
tests/api.test.js
docs/ ER-diagram.md · API.md · WEBSOCKET.md
```

The layers are kept separate: **routes** handle HTTP, **services** hold the rules and queries, **realtime** handles broadcasting. Routes never touch Socket.IO directly; they call `hub.emitToTenant()`.

---

## 3. Tenancy model

```
Organization (Acme Corp)
 ├── Tenant / Branch (Hyderabad)  ── Boards ── Columns ── Tasks
 └── Tenant / Branch (Bangalore)  ── Boards ── Columns ── Tasks
```

* **Users are global.** One login can be in many orgs and branches (Carol is in two branches).
* **`memberships`** says who can access what:
  * `ORG_ADMIN`: `tenant_id = NULL`, covers *every* branch of that org, can create, rename and delete branches.
  * `TENANT_ADMIN`: one branch. Manages boards, columns and members.
  * `MEMBER`: one branch. Works with tasks.
* **Every** business table (`boards`, `columns`, `tasks`, `activity_logs`) has a `tenant_id`.

### How isolation is enforced (four layers)

1. **One access function.** `services/access.js → getTenantAccess(userId, tenantId)` is the only place that decides whether someone can enter a branch. Both the REST middleware (`loadTenant`) and the socket `tenant:join` use it.
2. **Tenant from the URL, checked, never from the body.** Routes live under `/api/tenants/:tenantId/...`. After `loadTenant`, the code only uses `req.tenant.id`.
3. **Every query is filtered by tenant.** Each lookup helper takes `tenantId` first, e.g. `getTask(tenantId, taskId)` → `WHERE id = ? AND tenant_id = ?`. Guessing another branch's task id gives a 404 (tested as "IDOR" in the test suite).
4. **The database double-checks.** Composite foreign keys (`tasks(column_id, board_id, tenant_id) → columns(...)`) make it *physically impossible* to store a task in another tenant's column, even if the app code had a bug.

Other details:

* Other tenants' resources return **404, not 403**, so attackers can't probe which ids exist.
* Assignees must be members of the branch.
* Socket rooms are per branch (`tenant:<id>`). A socket is in at most **one** branch room. Removing a member **kicks their open tabs** out of the room immediately (`tenant:kicked`), and deleting a branch closes its room.
* The client also drops any event whose `tenantId` isn't the branch on screen, and wipes all state *before* loading a new branch.

---

## 4. Realtime

* REST does all writes; the server then emits to `tenant:<id>`. See [docs/WEBSOCKET.md](docs/WEBSOCKET.md).
* **Presence:** in-memory map `tenantId → socketId → {user, boardId, focusTaskId}`, merged per user (several tabs show one avatar). The UI shows avatars in the top bar, a 👀 badge on cards someone has open, and "Carol also has this task open" in the panel.
* **Network recovery:** Socket.IO reconnects with backoff. A red dot and a banner show while offline. After reconnecting we **re-join the room and re-download** the board, because events sent while we were away are lost. Failed optimistic writes roll back with a toast.

---

## 5. Concurrency & conflict resolution

### Optimistic locking

Every board, column and task has a `version`. Each update must send the version it was based on:

```sql
UPDATE tasks SET ..., version = version + 1 WHERE id = ? AND tenant_id = ? AND version = ?
```

If the version doesn't match, the server answers **409 `VERSION_CONFLICT`** together with the latest copy. Everything runs inside `BEGIN IMMEDIATE` transactions, so the check and the write can't interleave.

### Field edits: 3-way merge (`public/js/conflict.js`)

The panel remembers `base` (what you started editing from). On save it sends **only the changed fields**. If there's a conflict, for each of my fields it compares base / mine / theirs:

* Different fields changed (Bob edits the title, Carol the description) → **auto-merge**: retry on the new version, and both changes survive.
* Same field changed → a dialog shows *Theirs vs Mine* and you choose.

A subtle bug I found while testing: the websocket may already have put the *newer* version into my local state, so my save would carry the new version number and quietly overwrite the other person. The fix is to run the same 3-way check against the local copy **before** sending.

### Drag & drop: fractional indexing + neighbour ids

* `position` is a REAL. Dropping between A and B gives `(A+B)/2`, so **only one row changes** per move.
* The client sends **neighbour ids**, not numbers. The server re-reads the real neighbours: after `prev` if it still exists, else before `next`, else at the end. A stale view can therefore never produce a broken order.
* After many inserts into the same gap (gap < 1e-6), the column is **rebalanced** to 1024, 2048, … and clients get `tasks:reordered` (tested with 60 inserts in one spot).
* If the card *itself* changed while you were dragging it, you get a 409. The UI snaps to the server's copy and tells you.

### Undo / redo

Command pattern (`history.js`). Each action pushes `{ undo, redo }`. Both are normal API calls (move back, put the old values back, restore a soft-deleted task), so **undo goes through the same conflict checks**: if someone changed the card since, the undo is refused rather than overwriting their work. Shortcuts are Ctrl+Z and Ctrl+Y / Ctrl+Shift+Z. The history is cleared when you switch board or branch.

### Optimistic UI

Creating, moving, editing and deleting all change local state first. Creates show a faded "ghost" card with a temporary id; a `clientKey` lets the tab recognise its own socket echo, so the card doesn't appear twice. Socket updates are applied only if `version` is newer, which also de-duplicates echoes.

---

## 6. Trade-offs

| I chose | Instead of | Why / cost |
|---|---|---|
| SQLite (`node:sqlite`) | Postgres/MySQL | Zero setup for reviewers. Single writer. Fine for a demo, not for heavy write load. |
| REST for writes, WS only for broadcasting | Writes over the socket | One validation and permission path, easy to test with curl. Costs one extra HTTP round trip. |
| Full re-render of the board | Virtual DOM / diffing | Simple and correct for tens of cards. Rendering pauses during a drag and keeps input focus. |
| Re-download on reconnect | Event replay / offline queue | Always correct, and boards are small. Edits made *while offline* fail instead of being queued. |
| Version-based locking (moves included) | Last-write-wins for moves | Never silently loses an edit. A rare 409 during a drag is shown to the user. |
| Column delete only when empty | Cascade delete | Avoids wiping cards someone is adding at that moment. |
| Native HTML5 drag & drop | A library | No dependency. Doesn't work on touch screens. |
| In-memory presence | Redis | Lost on restart (fine, presence is temporary). Doesn't work across several servers. |
| JWT in localStorage | httpOnly cookie | Simpler with sockets. More exposed to XSS, so all user text is escaped. |

## 7. Scaling it up (what I'd do next)

1. **Postgres** with Row-Level Security on `tenant_id` as a 5th isolation layer. All indexes already lead with `tenant_id`, so partitioning or sharding by tenant is straightforward.
2. **Several Node instances** behind a load balancer with the **Socket.IO Redis adapter**, so `emitToTenant` reaches sockets on every instance. Presence would move to Redis hashes with TTLs.
3. **Outbox table** for events, so broadcast happens reliably *after* commit, plus an event sequence number per tenant, so clients can ask "what did I miss since seq N" instead of a full reload.
4. An **offline queue** in IndexedDB that replays writes on reconnect, using the same conflict handling.
5. Rate limiting, refresh tokens, and invite emails instead of "the user must already be registered".

## 8. Tests

`npm test` runs [tests/api.test.js](tests/api.test.js) against a fresh in-memory DB. It covers:

* cross-org and cross-tenant reads, IDOR on board ids, moving into another tenant's column, assigning a user from another branch
* RBAC for MEMBER, TENANT_ADMIN and ORG_ADMIN
* 409 on a concurrent edit followed by a successful merge, a required `version`, a drag-drop next to a vanished neighbour, rebalancing, soft delete and restore
* socket auth, joining a foreign room, events reaching only the right branch, presence, and kicking a removed member

I also ran a two-browser end-to-end check (headless Edge with Bob + Carol): live create, drag & drop sync, undo, auto-merge, the same-field conflict dialog, and the activity feed.
