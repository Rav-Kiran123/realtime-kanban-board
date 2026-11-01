# REST API

Base URL: `http://localhost:4000/api`. Everything is JSON.

**Auth:** send `Authorization: Bearer <token>` (the token comes from `/auth/login`).

**Errors** always look like this:

```json
{ "error": "VERSION_CONFLICT", "message": "Someone else changed this item before you", "current": { ...latest task... } }
```

| Status | `error` | When |
|---|---|---|
| 400 | `BAD_REQUEST` | validation failed, missing `version` |
| 401 | `UNAUTHORIZED` | no token, bad token, or expired token |
| 403 | `FORBIDDEN` | you can see the branch, but your role is too low |
| 404 | `NOT_FOUND` | doesn't exist **or isn't yours**. Other tenants' data is always 404, never 403, so ids don't leak. |
| 409 | `VERSION_CONFLICT` | optimistic lock failed. The body includes `current`. |
| 409 | `CONFLICT` / `CONSTRAINT` | e.g. deleting a non-empty column, a duplicate name |

Roles: `MEMBER` < `TENANT_ADMIN` < `ORG_ADMIN`. A higher role can do everything a lower one can.

---

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/register` | `{ name, email, password }` | password ≥ 8 chars. Returns `{ token, user }` |
| POST | `/auth/login` | `{ email, password }` | returns `{ token, user }` |
| GET | `/auth/me` | – | `{ user, orgs: [{ id, name, isOrgAdmin, tenants: [{ id, name, role }] }] }`. This drives the org selector and branch switcher. |

## Organizations & branches (tenants)

| Method | Path | Role | Body |
|---|---|---|---|
| GET | `/orgs` | any | same tree as `/auth/me` |
| POST | `/orgs` | any logged-in user (becomes ORG_ADMIN) | `{ name, firstBranchName? }`. Creates a "Head Office" branch with a board. |
| GET | `/orgs/:orgId` | org member | |
| PATCH | `/orgs/:orgId` | ORG_ADMIN | `{ name }` |
| DELETE | `/orgs/:orgId` | ORG_ADMIN | cascades to everything |
| GET | `/orgs/:orgId/tenants` | org member | only the branches you can see |
| POST | `/orgs/:orgId/tenants` | ORG_ADMIN | `{ name }`. The new branch comes with a "Main Board". |
| PATCH | `/orgs/:orgId/tenants/:tenantId` | ORG_ADMIN | `{ name }` |
| DELETE | `/orgs/:orgId/tenants/:tenantId` | ORG_ADMIN | kicks connected sockets out of the room |
| GET | `/orgs/:orgId/admins` | ORG_ADMIN | |
| POST | `/orgs/:orgId/admins` | ORG_ADMIN | `{ email }` |

## Tenant-scoped routes: `/tenants/:tenantId/...`

Every route below first runs `requireAuth` and then `loadTenant`. If you're not a member of the branch (or an ORG_ADMIN of its org) you get a **404** before any route code runs. The `tenantId` from the URL is checked against your memberships; a `tenantId` in the body is never trusted.

### Members

| Method | Path | Role | Body |
|---|---|---|---|
| GET | `/members` | MEMBER | branch members + org admins |
| POST | `/members` | TENANT_ADMIN | `{ email, role: "MEMBER" \| "TENANT_ADMIN" }` (the user must be registered) |
| PATCH | `/members/:userId` | TENANT_ADMIN | `{ role }` |
| DELETE | `/members/:userId` | TENANT_ADMIN | unassigns their tasks and kicks their live sockets |

### Boards

| Method | Path | Role | Body |
|---|---|---|---|
| GET | `/boards` | MEMBER | |
| GET | `/boards/:boardId` | MEMBER | returns `{ board, columns, tasks }` in one call |
| POST | `/boards` | TENANT_ADMIN | `{ name, description?, withDefaultColumns? }` |
| PATCH | `/boards/:boardId` | TENANT_ADMIN | `{ version, name?, description? }` |
| DELETE | `/boards/:boardId` | TENANT_ADMIN | |

### Columns

| Method | Path | Role | Body |
|---|---|---|---|
| POST | `/boards/:boardId/columns` | TENANT_ADMIN | `{ name, wipLimit? }`. Appended at the end. |
| PATCH | `/columns/:columnId` | TENANT_ADMIN | `{ version, name?, wipLimit? }` |
| POST | `/columns/:columnId/move` | TENANT_ADMIN | `{ version, prevColumnId, nextColumnId }` |
| DELETE | `/columns/:columnId` | TENANT_ADMIN | only if the column is empty (otherwise 409) |

### Tasks

| Method | Path | Role | Body |
|---|---|---|---|
| POST | `/boards/:boardId/tasks` | MEMBER | `{ columnId, title, description?, priority?, assigneeId?, dueDate?, prevTaskId?, nextTaskId?, clientKey? }` |
| GET | `/tasks/:taskId` | MEMBER | `{ task, activity }` (the task's history) |
| PATCH | `/tasks/:taskId` | MEMBER | `{ version, ...only the fields you changed }` |
| POST | `/tasks/:taskId/move` | MEMBER | `{ version, columnId, prevTaskId, nextTaskId }` |
| DELETE | `/tasks/:taskId` | MEMBER | `{ version? }`. A soft delete. |
| POST | `/tasks/:taskId/restore` | MEMBER | undo for delete (idempotent) |

Task object:

```json
{
  "id": 12, "tenantId": 1, "boardId": 1, "columnId": 2,
  "title": "Login page redesign", "description": "", "priority": "medium",
  "assigneeId": 3, "dueDate": "2026-12-01", "position": 1536, "version": 4,
  "createdBy": 2, "updatedBy": 3, "createdAt": "…", "updatedAt": "…"
}
```

**Moving, explained.** The client never sends a position number. It only says "between card `prevTaskId` and card `nextTaskId`". The server looks those cards up *now* and:

1. if `prev` is still in that column → the card goes right after it
2. else if `next` is still there → the card goes right before it
3. else → the card goes to the end of the column

So a drop next to a card someone else just moved away still lands sensibly.

**`clientKey`** is a random string the browser makes for an optimistic create. The server sends it back in the `task:created` event, so the creator's tab can recognise its own echo.

### Activity

| Method | Path | Query |
|---|---|---|
| GET | `/activity` | `boardId?`, `taskId?`, `beforeId?` (paging), `limit?` (max 200) |

Example entry:

```json
{ "id": 91, "action": "task.moved", "entityType": "task", "entityId": 12, "userName": "Carol Coder",
  "details": { "title": "Login page redesign", "fromColumn": "To Do", "toColumn": "In Progress" }, "createdAt": "…" }
```

Actions: `task.created|updated|moved|deleted|restored`, `column.created|updated|moved|deleted`, `board.created|updated|deleted`, `member.added|role_changed|removed`.
