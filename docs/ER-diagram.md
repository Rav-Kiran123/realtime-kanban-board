# Database schema / ER diagram

The real schema is in [`server/db/schema.sql`](../server/db/schema.sql) (SQLite).
The diagram below is Mermaid. GitHub and VS Code (with a Mermaid extension) draw it automatically.

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ TENANTS : "has branches"
    ORGANIZATIONS ||--o{ MEMBERSHIPS : ""
    USERS ||--o{ MEMBERSHIPS : "belongs via"
    TENANTS ||--o{ MEMBERSHIPS : "branch-level roles"
    TENANTS ||--o{ BOARDS : "owns"
    BOARDS ||--o{ COLUMNS : "has"
    COLUMNS ||--o{ TASKS : "contains"
    BOARDS ||--o{ TASKS : ""
    TENANTS ||--o{ ACTIVITY_LOGS : "audit trail"
    USERS ||--o{ TASKS : "assignee"
    USERS ||--o{ ACTIVITY_LOGS : "actor"

    ORGANIZATIONS {
        int id PK
        text name
        text created_at
        text updated_at
    }
    TENANTS {
        int id PK
        int org_id FK
        text name "UNIQUE(org_id, name)"
    }
    USERS {
        int id PK
        text name
        text email "UNIQUE, NOCASE"
        text password_hash "bcrypt"
        text avatar_color
    }
    MEMBERSHIPS {
        int id PK
        int user_id FK
        int org_id FK
        int tenant_id FK "NULL = org-wide (ORG_ADMIN)"
        text role "ORG_ADMIN | TENANT_ADMIN | MEMBER"
    }
    BOARDS {
        int id PK
        int tenant_id FK
        text name
        text description
        int version "optimistic lock"
    }
    COLUMNS {
        int id PK
        int tenant_id FK
        int board_id FK "(board_id, tenant_id) -> boards"
        text name
        real position "fractional index"
        int wip_limit "nullable"
        int version
    }
    TASKS {
        int id PK
        int tenant_id FK
        int board_id FK
        int column_id FK "(column_id, board_id, tenant_id) -> columns"
        text title
        text description
        text priority "low|medium|high|urgent"
        int assignee_id FK
        text due_date
        real position "fractional index"
        int version "bumped on every change"
        text deleted_at "soft delete, enables undo"
    }
    ACTIVITY_LOGS {
        int id PK
        int tenant_id FK
        int board_id "nullable"
        int user_id FK
        text action "e.g. task.moved"
        text entity_type
        int entity_id
        text details "JSON before/after"
    }
```

## Why it looks like this

| Decision | Reason |
|---|---|
| `tenant_id` is on **every** business table, even when it could be found through the parent | Every query can filter with `WHERE tenant_id = ?` directly, with no joins needed. It also makes a later move to Postgres Row-Level Security or sharding by tenant simple. |
| **Composite foreign keys**, e.g. `tasks(column_id, board_id, tenant_id) → columns(id, board_id, tenant_id)` | The **database** refuses a task that points to a column in another branch or board, even if the app code had a bug. That is my second line of defence. |
| `memberships(tenant_id, org_id) → tenants(id, org_id)` | A branch membership can't point to a branch of a *different* organization. |
| `CHECK` on memberships: ORG_ADMIN ⇔ `tenant_id IS NULL` | One row per role scope, so the roles can't get mixed up. |
| Partial unique indexes on memberships | SQLite treats NULLs in UNIQUE as distinct, so I used one index for org-level rows and one for branch rows. |
| `position REAL` | Fractional indexing: moving a card updates **one** row. |
| `version INTEGER` | Optimistic locking: `UPDATE … WHERE version = ?`. |
| `deleted_at` (soft delete) | "Undo delete" just clears it. The history stays in the activity log. |
| Index `tasks(tenant_id, column_id, position) WHERE deleted_at IS NULL` | Exactly the "cards of a column in order" query. It's a partial index, so deleted cards don't bloat it. |
| Index `activity_logs(tenant_id, id DESC)` | The activity feed is "newest N for a tenant", paged with `beforeId`. |
