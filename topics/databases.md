# Quick Recap

- **SQL vs NoSQL**: SQL = fixed schema, joins, ACID. NoSQL = flexible schema, horizontal scale. Categories: document, key-value, wide-column, graph
- **ACID**: Atomicity (all-or-nothing), Consistency (valid state), Isolation (no interference), Durability (survives crashes)
- **Isolation levels**: Read Committed (Postgres default, snapshot per statement), Repeatable Read (snapshot per transaction, Postgres = Snapshot Isolation), Serializable (SSI, no anomalies, may abort)
- **Anomalies**: dirty read, non-repeatable read, phantom read, write skew (Snapshot Isolation vulnerability)
- **Locking**: pessimistic (`SELECT FOR UPDATE`, high contention) vs optimistic (version column, low contention). Advisory locks for app-level coordination
- **CAP**: partition-tolerant is mandatory → real trade-off is CP vs AP. PACELC extends: latency vs consistency when no partition
- **Indexes**: B-tree (default, equality + range), GIN (JSONB, full-text), BRIN (large time-ordered tables). Composite: leftmost prefix rule
- **Index strategies**: covering (INCLUDE), partial (WHERE clause), expression (LOWER(email)). Anti-pattern: indexing every column
- **Normalization**: 1NF (atomic values), 2NF (no partial deps), 3NF (no transitive deps). Denormalize intentionally for reads
- **Joins**: INNER (matching only), LEFT (all left + matching right), FULL OUTER (all from both). Always join on indexed columns
- **N+1 problem**: 1 query + N per record. Fix: JOIN, eager loading, batching (DataLoader), subquery
- **EXPLAIN ANALYZE**: check Seq Scan (add index), rows estimate mismatch (run ANALYZE), Index Only Scan = best
- **Keyset pagination**: `WHERE id > last_seen LIMIT N` — constant time. OFFSET degrades linearly
- **Speed up reads**: indexes, read replicas, caching, materialized views, denormalization, connection pooling
- **Speed up writes**: batch inserts, remove unused indexes, unlogged tables, tune autovacuum
- **Views**: virtual (no data stored, always current) vs materialized (cached, must refresh, can be indexed)
- **Triggers**: BEFORE/AFTER on INSERT/UPDATE/DELETE. Use for: audit logging, updated_at. Caution: hidden complexity
- **PostgreSQL features**: JSONB (indexable with GIN), CTEs (WITH), window functions (RANK, LAG, LEAD), partitioning (range, list, hash)
- **Migrations**: versioned SQL scripts, up/down, never edit applied migrations. `CREATE INDEX CONCURRENTLY` for production
- **Caching patterns**: cache-aside (lazy), write-through, write-behind. Invalidation: TTL, event-driven, version key
- **Replication**: single-leader (primary-replica), multi-leader, leaderless (quorum). Sync vs async trade-off
- **Sharding**: hash-based, range-based, geographic. Avoid as long as possible — vertical scaling + read replicas first
- **ORM vs native**: ORM for CRUD + migrations + type safety; native SQL for complex queries, bulk ops, performance-critical paths
- **TypeORM in NestJS**: `TypeOrmModule.forFeature([Entity])` per module, inject with `@InjectRepository(Entity)`, `QueryBuilder` for complex queries, `DataSource.transaction()` for multi-step ops
- **Connection pooling**: PgBouncer transaction mode (most common) — multiplexes many app connections onto few DB connections. App-level: configure `max`/`min` in TypeORM `extra`
- **Read optimisation layers**: (1) query — indexes, covering indexes, keyset pagination, no SELECT * (2) schema — materialized views, partitioning, denormalise (3) infra — read replicas, Redis cache (4) arch — CQRS, CDN
- **ORM vs native**: ORM for CRUD + migrations + type safety; native SQL for complex queries, bulk ops, performance-critical paths
- **TypeORM in NestJS**: `TypeOrmModule.forFeature([Entity])` per module, inject with `@InjectRepository(Entity)`, use `QueryBuilder` for complex queries
- **Connection pooling**: PgBouncer sits between app and DB. Session mode (1:1), transaction mode (multiplexed — most common), statement mode (most aggressive). Reduces connection overhead
- **Read optimisation checklist**: indexes → covering indexes → read replicas → caching (Redis) → materialized views → denormalisation → query rewrite → partitioning

---

## Databases

### Fundamentals

<details>
<summary>SQL vs NoSQL</summary>

| | SQL (Relational) | NoSQL |
|---|---|---|
| **Schema** | Fixed, predefined (schema-on-write) | Flexible (schema-on-read) |
| **Scaling** | Vertical (scale up) | Horizontal (scale out) |
| **Joins** | Native, powerful | Usually no joins (denormalize) |
| **Transactions** | ACID | BASE (usually), some support ACID (MongoDB 4.0+, DynamoDB) |
| **Query language** | SQL (standardized) | Varies per DB (MongoDB query API, CQL, etc.) |
| **Best for** | Structured data, complex queries, strong consistency | Unstructured/variable data, massive scale, low latency |

**NoSQL categories:**
- **Document** (MongoDB, CouchDB) — JSON-like docs, flexible schema. Nest related data in one document. Good for: content management, user profiles, catalogs.
- **Key-Value** (Redis, DynamoDB) — simple get/set by key, extremely fast. No query by value (without indexes). Good for: sessions, caching, feature flags, shopping carts.
- **Wide-Column / Columnar** (Cassandra, HBase, ScyllaDB) — rows with dynamic columns, optimized for write-heavy and time-series. Good for: IoT data, event logs, analytics.
- **Graph** (Neo4j, Amazon Neptune) — nodes + edges, relationships are first-class. Good for: social networks, fraud detection, recommendation engines.

**Pick SQL** when: data is relational, you need joins/transactions, schema is well-defined, complex queries and aggregations.
**Pick NoSQL** when: schema varies, need horizontal scale, high write throughput, data is naturally document/key-value shaped, low-latency reads.

**In practice:** most real-world systems use both. PostgreSQL for core transactional data + Redis for caching + DynamoDB for high-throughput events is a common stack.

</details><br>

<details>
<summary>ACID properties</summary>

- **Atomicity** — transaction is all-or-nothing. If any part fails, the entire transaction rolls back.
- **Consistency** — transaction brings the DB from one valid state to another. All constraints (FK, unique, checks) are satisfied.
- **Isolation** — concurrent transactions don't interfere with each other.
- **Durability** — once committed, data survives crashes (written to disk/WAL).

**Isolation levels (weakest → strongest):**

| Level | Dirty Read | Non-Repeatable Read | Phantom Read | Write Skew |
|---|---|---|---|---|
| Read Uncommitted | Yes | Yes | Yes | Yes |
| Read Committed | No | Yes | Yes | Yes |
| Repeatable Read | No | No | Yes (Postgres: No) | Yes |
| Serializable | No | No | No | No |

PostgreSQL default: **Read Committed**. MySQL InnoDB default: **Repeatable Read**.

**Each level explained:**

**Read Uncommitted:**
- A transaction can see uncommitted (dirty) data written by other in-flight transactions.
- Almost never used in practice — PostgreSQL doesn't even implement it (treats it as Read Committed).
- The only reason it exists: maximum concurrency with zero isolation. No real-world use case justifies the risk.

**Read Committed:**
- Each **statement** within a transaction sees a fresh snapshot of committed data at the moment that statement starts.
- Two identical `SELECT` statements in the same transaction can return different results if another transaction commits between them.
- **How Postgres implements it:** before each statement, take a new MVCC snapshot. Only rows committed before the snapshot are visible. Rows inserted/updated by concurrent uncommitted transactions are invisible.
- This is the safest "default" — prevents dirty reads while keeping concurrency high. Good enough for most CRUD applications.

**Repeatable Read:**
- The transaction sees a single snapshot taken at the **start of the transaction** (first statement). All subsequent reads see the same data, even if other transactions commit changes.
- **Postgres implementation (Snapshot Isolation):** Postgres's Repeatable Read is actually **Snapshot Isolation (SI)**, which is stronger than the SQL standard requires — it also prevents phantom reads (the standard allows them at this level).
- If a concurrent transaction modifies a row this transaction also tries to modify → Postgres raises a **serialization error** (`could not serialize access due to concurrent update`) → the application must retry.
- **Vulnerable to write skew** (see below) — two transactions read overlapping data, make decisions based on what they read, and write to different rows, resulting in a state that violates a business invariant.

**Serializable:**
- Transactions execute as if they ran one at a time (serially), even though they actually run concurrently.
- **Postgres implementation — SSI (Serializable Snapshot Isolation):** builds on Snapshot Isolation by tracking read/write dependencies between transactions. If a cycle is detected (indicating the result would differ from any serial execution), one transaction is aborted with a serialization error.
- **Not locking-based** in Postgres — SSI uses dependency tracking, not locks. This means readers don't block writers and writers don't block readers (unlike traditional 2PL serializable implementations in other databases).
- **Performance cost:** more aborts under contention → application must implement retry logic. Tracking overhead is moderate but increases with long transactions and high concurrency.
- **When to use:** financial calculations, inventory management, any logic where write skew or other anomalies could violate critical invariants and you don't want to manually reason about every edge case.

**Anomalies explained with examples:**

**Dirty read** — reading uncommitted data:
```
T1: UPDATE accounts SET balance = 0 WHERE id = 1;  -- not yet committed
T2: SELECT balance FROM accounts WHERE id = 1;      -- reads 0 (dirty)
T1: ROLLBACK;                                        -- balance is actually still 500
T2: -- just used balance = 0 to make a decision → based on data that never existed
```

**Non-repeatable read** — same row, different values:
```
T1: SELECT balance FROM accounts WHERE id = 1;  -- reads 500
T2: UPDATE accounts SET balance = 300 WHERE id = 1; COMMIT;
T1: SELECT balance FROM accounts WHERE id = 1;  -- reads 300 (different!)
-- T1 sees two different balances within the same transaction
```

**Phantom read** — same query, different rows:
```
T1: SELECT * FROM orders WHERE status = 'pending';  -- returns 5 rows
T2: INSERT INTO orders (status) VALUES ('pending'); COMMIT;
T1: SELECT * FROM orders WHERE status = 'pending';  -- returns 6 rows (phantom row appeared)
-- T1's range query result changed because a new matching row was inserted
```

**Write skew** — an anomaly specific to Snapshot Isolation (not in the SQL standard):
```
-- Invariant: at least one doctor must be on call at all times
-- Both Alice and Bob are currently on call

T1: SELECT count(*) FROM doctors WHERE on_call = true;  -- reads 2
T2: SELECT count(*) FROM doctors WHERE on_call = true;  -- reads 2

T1: UPDATE doctors SET on_call = false WHERE name = 'Alice';  -- still 1 on call (Bob)
T2: UPDATE doctors SET on_call = false WHERE name = 'Bob';    -- still 1 on call (Alice)

T1: COMMIT;
T2: COMMIT;
-- Result: 0 doctors on call — invariant violated!
-- Each transaction read consistent data and made a valid decision individually,
-- but the combined effect violates the business rule.
-- Fix: use Serializable isolation, or SELECT ... FOR UPDATE to lock the rows.
```

**Implementation mechanisms — MVCC vs locking:**

- **MVCC (Multi-Version Concurrency Control)** — used by PostgreSQL, MySQL InnoDB, Oracle. Each write creates a new version of the row. Readers see a snapshot of the appropriate version. Readers never block writers, writers never block readers. Isolation level controls which snapshot is visible and when conflicts are detected.
- **Two-Phase Locking (2PL)** — used by SQL Server (default), older MySQL. Transactions acquire shared (read) or exclusive (write) locks. Readers block writers, writers block readers. Stronger isolation guarantees but lower concurrency. Deadlocks are more common.
- **PostgreSQL's approach:** MVCC for all levels. Read Committed → new snapshot per statement. Repeatable Read → snapshot at transaction start (SI). Serializable → SI + dependency tracking (SSI). No read locks at any level.

**Practical guidance:**
- **Read Committed** — use for most CRUD applications. Safe default, high concurrency. Be aware of non-repeatable reads in multi-statement transactions.
- **Repeatable Read** — use when your transaction logic depends on consistent reads across multiple statements (e.g., read-then-write patterns). Must handle serialization errors with retry.
- **Serializable** — use when correctness is critical and you can't reason about all possible anomalies (financial systems, inventory). Wrap transactions in retry loops. Keep transactions short to minimize aborts.
- **Postgres vs MySQL behavioral difference:** Postgres Repeatable Read = Snapshot Isolation (prevents phantoms). MySQL InnoDB Repeatable Read uses **next-key locking** (gap locks) to prevent phantoms, but this is a locking approach that can cause more contention.

**Pessimistic vs Optimistic locking:**
- **Pessimistic** — lock the row/table before modifying. `SELECT ... FOR UPDATE`. Prevents conflicts but reduces concurrency.
- **Optimistic** — no locks. Read with a version/timestamp, check on write. If version changed → retry. Better concurrency, more retries under contention.
- **Use pessimistic** for high-contention, critical data (bank transfers). **Use optimistic** for low-contention, read-heavy (most web apps).

</details><br>

<details>
<summary>BASE properties and CAP theorem</summary>

**BASE** — an alternative consistency model for distributed/NoSQL systems:
- **Basically Available** — system guarantees availability (may return stale data).
- **Soft state** — state may change over time even without input (due to async propagation).
- **Eventually consistent** — given enough time with no new writes, all replicas converge.

**CAP theorem** — a distributed system can guarantee at most 2 of 3:
- **C**onsistency — every read returns the latest write.
- **A**vailability — every request gets a response.
- **P**artition tolerance — system works despite network splits.

In practice, P is non-negotiable, so the real trade-off is **CP vs AP**:
- **CP:** PostgreSQL, MongoDB (default), HBase — may reject writes during partition.
- **AP:** Cassandra, DynamoDB, CouchDB — always available, eventually consistent.

**PACELC theorem (extension of CAP):**
- If there's a **P**artition, choose **A**vailability or **C**onsistency.
- **E**lse (no partition), choose **L**atency or **C**onsistency.
- DynamoDB: PA/EL (available during partition, low latency when healthy). PostgreSQL: PC/EC (consistent always, higher latency).

</details><br>

### Indexes

<details>
<summary>Database indexes — how they work</summary>

An index is a data structure (usually B-tree) that speeds up reads at the cost of slower writes and extra storage.

**How it works:** instead of scanning every row (sequential scan), the DB looks up the index (like a book's table of contents) to jump directly to matching rows.

**B-tree (default):**
- Balanced tree structure. O(log n) lookups.
- Supports: equality (`=`), range (`<`, `>`, `BETWEEN`), sorting (`ORDER BY`), prefix `LIKE` (`LIKE 'abc%'`).
- Does NOT help: `LIKE '%abc'` (no left anchor), functions on indexed column (`WHERE LOWER(name) = 'john'` — use expression index instead).

**Index types (PostgreSQL):**
- **B-tree** (default) — equality and range queries. Use for 90% of cases.
- **Hash** — equality only (`=`). Slightly faster than B-tree for pure equality, but no range support. Rarely used.
- **GIN** (Generalized Inverted Index) — multiple values per row. Full-text search (`tsvector`), JSONB (`@>`, `?`, `?|`), arrays (`@>`, `&&`).
- **GiST** (Generalized Search Tree) — geometric/spatial data (PostGIS), range types, full-text search (less precise than GIN but supports `ORDER BY` distance).
- **BRIN** (Block Range Index) — very large tables with naturally ordered data (e.g., timestamps in append-only tables). Tiny index size, good for TB-scale tables.

</details><br>

<details>
<summary>Index strategies and anti-patterns</summary>

**Composite index:**
- Index on multiple columns: `CREATE INDEX idx ON orders (user_id, created_at)`.
- **Leftmost prefix rule** — the index is used for queries filtering on the leftmost column(s). `WHERE user_id = 1` ✅, `WHERE user_id = 1 AND created_at > ...` ✅, `WHERE created_at > ...` alone ❌ (index not used).
- Column order matters — put high-selectivity columns first, or match your most common query patterns.

**Covering index (INCLUDE):**
- Include non-key columns in the index to avoid table lookups (index-only scan).
- `CREATE INDEX idx ON orders (user_id) INCLUDE (total, status)`.
- Query `SELECT total, status FROM orders WHERE user_id = 1` reads only the index.

**Partial index:**
- Index with a `WHERE` clause — indexes only a subset of rows. Saves space and write overhead.
- `CREATE INDEX idx ON orders (created_at) WHERE status = 'pending'`.
- Useful for: hot data (active orders), soft-deleted rows (`WHERE deleted_at IS NULL`).

**Expression / Functional index:**
- Index on a computed expression: `CREATE INDEX idx ON users (LOWER(email))`.
- Makes `WHERE LOWER(email) = 'john@example.com'` use the index.

**Unique index:**
- Enforces uniqueness. `CREATE UNIQUE INDEX idx ON users (email)`.
- A `UNIQUE` constraint internally creates a unique index.

**When NOT to index:**
- Small tables (< few thousand rows) — seq scan is faster.
- Low cardinality columns (boolean, status with 2–3 values) — index doesn't help much (exception: partial index on the rare value).
- Write-heavy tables with rare reads — indexes slow down every INSERT/UPDATE/DELETE.
- Columns rarely used in WHERE/JOIN/ORDER BY.

**Anti-patterns:**
- Indexing every column "just in case" — wastes space, slows writes.
- Too many indexes on one table — each write updates all indexes.
- Not using `EXPLAIN ANALYZE` — always verify the index is actually used.
- Ignoring index bloat — dead tuples inflate index size. Use `REINDEX` or `pg_repack`.

**Key rule:** use `EXPLAIN ANALYZE` to verify the index is actually used and the query plan is optimal.

</details><br>

### Normalization & Data Modeling

<details>
<summary>Database normalization</summary>

**What it is:** organizing data to reduce redundancy and improve integrity. Each normal form (NF) builds on the previous.

**1NF — First Normal Form:**
- Each column holds atomic (indivisible) values. No arrays or comma-separated lists.
- Each row is unique (has a primary key).
- Bad: `tags: "js,ts,node"`. Good: separate `tags` table with one row per tag.

**2NF — Second Normal Form:**
- 1NF + no partial dependencies. Every non-key column depends on the **entire** primary key.
- Matters for composite keys. If `(order_id, product_id)` is the PK, `customer_name` depends only on `order_id` → violates 2NF. Move to `orders` table.

**3NF — Third Normal Form:**
- 2NF + no transitive dependencies. Non-key columns depend only on the primary key, not on other non-key columns.
- Bad: `orders` table has `customer_id`, `customer_name`, `customer_email`. Name and email depend on customer_id, not order. Move to `customers` table.

**BCNF (Boyce-Codd Normal Form):**
- Stricter 3NF. Every determinant is a candidate key. Rarely discussed in interviews beyond knowing it exists.

**When to denormalize:**
- Read-heavy workloads where joins are expensive (dashboards, analytics).
- Caching frequently accessed computed data (materialized views).
- NoSQL databases that don't support joins — denormalize by design.
- **Rule:** normalize by default, denormalize intentionally with a clear reason.

</details><br>

<details>
<summary>Database relationships and joins</summary>

**Relationships:**
- **One-to-One** — user ↔ profile. FK with UNIQUE constraint, or same PK in both tables.
- **One-to-Many** — user → orders. FK on the "many" side (`orders.user_id`). Most common.
- **Many-to-Many** — students ↔ courses. Junction/join table (`student_courses` with both FKs).

**Join types:**

```sql
-- INNER JOIN: only matching rows from both tables
SELECT * FROM orders o JOIN users u ON o.user_id = u.id;

-- LEFT JOIN: all rows from left + matching from right (NULL if no match)
SELECT * FROM users u LEFT JOIN orders o ON u.id = o.user_id;

-- RIGHT JOIN: all from right + matching from left (rarely used, just swap LEFT)

-- FULL OUTER JOIN: all from both, NULLs where no match

-- CROSS JOIN: cartesian product (every row × every row). Rarely intentional.
```

| Join | Returns |
|---|---|
| **INNER** | Only matching rows from both tables |
| **LEFT** | All left rows + matching right (NULL if none) |
| **RIGHT** | All right rows + matching left (NULL if none) |
| **FULL OUTER** | All rows from both (NULL where no match) |
| **CROSS** | Cartesian product (M × N rows) |

**Self join** — join a table to itself. Use for: hierarchical data (employee → manager), comparing rows within the same table.

**Tips:**
- Always join on indexed columns.
- Prefer explicit `JOIN ... ON` over implicit joins in `WHERE` (readability).
- Avoid `SELECT *` in joins — select only needed columns.

</details><br>

### Query Performance

<details>
<summary>N+1 query problem</summary>

**Problem:** fetching a list of N records, then issuing 1 additional query per record to load related data = 1 + N queries.

```js
// N+1: 1 query for orders + N queries for users
const orders = await db.query('SELECT * FROM orders');
for (const order of orders) {
  order.user = await db.query('SELECT * FROM users WHERE id = $1', [order.user_id]);
}
```

**Solutions:**
- **JOIN** — fetch everything in one query: `SELECT * FROM orders JOIN users ON ...`.
- **Eager loading** (ORM) — `Order.findAll({ include: User })` in Sequelize, `.populate()` in Mongoose.
- **Batching** — collect all IDs, fetch in one `WHERE id IN (...)` query. Libraries: DataLoader (GraphQL), batch loaders.
- **Subquery** — `SELECT * FROM orders WHERE user_id IN (SELECT id FROM users WHERE ...)`.

**Detection:** enable query logging, use ORM debug mode, or tools like `pg_stat_statements`.

</details><br>

<details>
<summary>Query optimization and EXPLAIN ANALYZE</summary>

**EXPLAIN ANALYZE** — run the query and show the actual execution plan with timing.

```sql
EXPLAIN ANALYZE SELECT * FROM orders WHERE user_id = 123 AND status = 'pending';
```

**What to look for:**
- **Seq Scan** (sequential scan) — reading every row. Fine for small tables, bad for large ones. Add an index.
- **Index Scan** — using an index to find rows. Good.
- **Index Only Scan** — reading from index without touching the table. Best (needs covering index + recent VACUUM).
- **Bitmap Index Scan** — combines multiple indexes or handles many matching rows. Good for medium selectivity.
- **Nested Loop** — joins by looping (fast for small datasets). Watch for N+1-like behavior.
- **Hash Join** — builds hash table for one side, probes with the other. Good for large joins.
- **Merge Join** — merges two sorted inputs. Good when both sides are pre-sorted (indexed).

**Key metrics in EXPLAIN output:**
- **actual time** — startup time and total time in ms.
- **rows** — actual rows processed vs estimated. Big mismatch = stale statistics → run `ANALYZE`.
- **loops** — how many times this node executed.

**Common optimizations:**
- Add missing indexes (check Seq Scans on large tables).
- Avoid `SELECT *` — select only needed columns.
- Use `LIMIT` for pagination (with keyset pagination for large offsets).
- Avoid functions on indexed columns in WHERE (`WHERE LOWER(email)` → use expression index).
- Run `ANALYZE` after bulk inserts to update statistics.
- Use `pg_stat_statements` to find slow queries in production.

**Keyset pagination vs OFFSET:**
- `OFFSET 10000 LIMIT 10` — DB reads and discards 10,000 rows. Gets slower with larger offsets.
- `WHERE id > last_seen_id ORDER BY id LIMIT 10` — index-based, constant performance. Preferred for large datasets.

</details><br>

<details>
<summary>How to speed up reads and writes</summary>

**Speed up reads:**
- **Indexes** — B-tree for equality/range, GIN for JSONB/full-text, BRIN for large time-ordered tables. Use `EXPLAIN ANALYZE` to verify they're used.
- **Read replicas** — route read queries to replicas, offload the primary for writes.
- **Caching** — Redis/Memcached for hot data. Cache-aside with TTL is the simplest starting point.
- **Materialized views** — precompute expensive aggregations, refresh on schedule or trigger.
- **Denormalization** — store computed/joined data to avoid expensive joins at read time. Trade write complexity for read speed.
- **Keyset pagination** — `WHERE id > last_seen ORDER BY id LIMIT N` instead of `OFFSET` (constant time vs linear).
- **Select only needed columns** — avoid `SELECT *`, reduce I/O and network transfer.
- **Partitioning** — range-partition large tables (e.g., by date) so queries scan only relevant partitions.
- **Connection pooling** — PgBouncer / application-level pools to avoid connection overhead per query.

**Speed up writes:**
- **Batch inserts** — `INSERT INTO ... VALUES (...), (...), (...)` or `COPY` for bulk loads instead of row-by-row.
- **Remove unnecessary indexes** — every index is updated on each write. Drop unused ones (`pg_stat_user_indexes` → `idx_scan = 0`).
- **Async replication** — don't wait for replica ACK if strong consistency isn't required.
- **Write-behind caching** — write to cache first, flush to DB in batches asynchronously.
- **Partitioning** — writes hit smaller partition indexes instead of one massive index.
- **Unlogged tables** — skip WAL for ephemeral data (staging tables, temp imports). Data lost on crash.
- **Tune autovacuum** — aggressive autovacuum on write-heavy tables to prevent bloat and maintain index performance.
- **Bulk operations** — disable triggers/indexes during large imports, re-enable after. Use `CREATE INDEX CONCURRENTLY` post-load.

**Speed up both:**
- **Connection pooling** — reduce per-connection overhead (PgBouncer, pgpool).
- **Proper schema design** — normalize for write-heavy, denormalize for read-heavy. Match the access pattern.
- **Hardware / vertical scaling** — more RAM (bigger shared_buffers, OS page cache), faster disks (NVMe SSDs), more CPU for parallel queries.
- **`pg_stat_statements`** — find the top slow queries in production and optimize them first.

</details><br>

### PostgreSQL-Specific

<details>
<summary>Triggers in PostgreSQL</summary>

Triggers are functions that automatically execute in response to `INSERT`, `UPDATE`, `DELETE`, or `TRUNCATE` on a table.

**Types:**
- **Row-level** (`FOR EACH ROW`) — fires once per affected row.
- **Statement-level** (`FOR EACH STATEMENT`) — fires once per SQL statement.
- **BEFORE / AFTER / INSTEAD OF** — when the trigger fires relative to the operation.

```sql
CREATE FUNCTION audit_log() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit (table_name, action, changed_at)
  VALUES (TG_TABLE_NAME, TG_OP, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit
AFTER INSERT OR UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION audit_log();
```

**Use cases:** audit logging, enforcing business rules, maintaining denormalized data, updating `updated_at` timestamps.

**Caution:** triggers add hidden complexity, make debugging harder, and can cause performance issues in bulk operations.

</details><br>

<details>
<summary>PostgreSQL-specific features</summary>

**JSONB:**
- Store, query, and index JSON data natively. `jsonb` (binary, indexable) over `json` (text, no index).
- Operators: `->` (get key as JSON), `->>` (get key as text), `@>` (contains), `?` (key exists).
- Index with GIN: `CREATE INDEX idx ON events USING gin (data)`.
- **Use when:** semi-structured data, flexible attributes, storing API responses. **Don't use as:** a replacement for proper relations.

**CTEs (Common Table Expressions):**
```sql
WITH active_users AS (
  SELECT * FROM users WHERE last_login > NOW() - INTERVAL '30 days'
)
SELECT * FROM active_users WHERE plan = 'premium';
```
- Readable, composable. Recursive CTEs for hierarchical data (org charts, tree structures).
- In PostgreSQL 12+, CTEs can be inlined (optimized like subqueries) unless marked `MATERIALIZED`.

**Window functions:**
```sql
SELECT name, department, salary,
  RANK() OVER (PARTITION BY department ORDER BY salary DESC) as rank,
  AVG(salary) OVER (PARTITION BY department) as dept_avg
FROM employees;
```
- Perform calculations across related rows without collapsing them (unlike GROUP BY).
- Common functions: `ROW_NUMBER()`, `RANK()`, `DENSE_RANK()`, `LAG()`, `LEAD()`, `SUM() OVER`, `AVG() OVER`.

**Materialized views:**
- Precomputed query results stored as a table. `REFRESH MATERIALIZED VIEW` to update.
- Use for: expensive aggregations, dashboards, reports. Trade freshness for speed.

**VACUUM and bloat:**
- PostgreSQL uses MVCC — updates create new row versions, deletes mark rows as dead.
- `VACUUM` reclaims dead row space. `AUTOVACUUM` runs automatically (tune, don't disable).
- Bloated tables/indexes slow down queries. Monitor with `pg_stat_user_tables` (n_dead_tup).

**Partitioning:**
- Split a large table into smaller physical partitions. Queries scan only relevant partitions.
- Types: **range** (by date — most common), **list** (by region/status), **hash** (even distribution).
- Use for: tables > 100 GB, time-series data, archiving old data (drop partition instead of DELETE).

</details><br>

<details>
<summary>Views and materialized views</summary>

**View — a saved query (virtual table):**
```sql
CREATE VIEW active_orders AS
  SELECT o.id, o.total, u.name
  FROM orders o JOIN users u ON o.user_id = u.id
  WHERE o.status = 'active';

SELECT * FROM active_orders WHERE total > 100;
```
- No data stored — the query runs every time you `SELECT` from the view.
- Use for: simplifying complex queries, encapsulating business logic, restricting access (expose view, hide underlying tables).
- Performance: same as running the underlying query directly. Indexes on base tables still apply.
- Updatable views: simple views (single table, no aggregates/joins) can support `INSERT`/`UPDATE`/`DELETE`. Complex views need `INSTEAD OF` triggers.

**Materialized view — a cached query result (physical table):**
```sql
CREATE MATERIALIZED VIEW monthly_revenue AS
  SELECT date_trunc('month', created_at) AS month, SUM(total) AS revenue
  FROM orders
  GROUP BY 1;

-- Data is stale until you refresh:
REFRESH MATERIALIZED VIEW monthly_revenue;
REFRESH MATERIALIZED VIEW CONCURRENTLY monthly_revenue;  -- no read lock, needs unique index
```
- Data is stored on disk — reads are fast (like a table), but data can be stale.
- Must be explicitly refreshed (`REFRESH MATERIALIZED VIEW`). Can be triggered by cron, app event, or trigger on base table.
- `CONCURRENTLY` — allows reads during refresh (requires a unique index on the materialized view).
- Can be indexed like a regular table for even faster reads.

**View vs Materialized view:**

| | View | Materialized View |
|---|---|---|
| **Data stored** | No (virtual) | Yes (on disk) |
| **Freshness** | Always current | Stale until refreshed |
| **Read speed** | Same as underlying query | Fast (precomputed) |
| **Write overhead** | None | Refresh cost |
| **Indexes** | No (uses base table indexes) | Yes (its own indexes) |
| **Use case** | Simplify queries, access control | Expensive aggregations, dashboards, reports |

**When to use materialized views:**
- Expensive queries (heavy joins, aggregations) that don't need real-time freshness.
- Dashboards, analytics, leaderboards — refresh on schedule (every 5 min, hourly, nightly).
- Replace denormalized cache tables — cleaner than maintaining them manually.

**When NOT to use:**
- Data must be real-time — use a regular view or query instead.
- Very frequent refreshes on large datasets — refresh itself can be expensive.

</details><br>

### Transactions & Concurrency

<details>
<summary>Transactions and locking strategies</summary>

**Transaction basics:**
```sql
BEGIN;
  UPDATE accounts SET balance = balance - 100 WHERE id = 1;
  UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;  -- or ROLLBACK on error
```

**Savepoints** — partial rollback within a transaction:
```sql
BEGIN;
  INSERT INTO orders (...);
  SAVEPOINT sp1;
  INSERT INTO order_items (...);  -- fails
  ROLLBACK TO sp1;  -- undo only order_items
  INSERT INTO order_items (...);  -- retry with different data
COMMIT;
```

**Locking strategies:**

**Pessimistic locking — lock the row before modifying:**
```sql
-- Lock the row until transaction ends
SELECT * FROM accounts WHERE id = 1 FOR UPDATE;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
```
- `FOR UPDATE` — exclusive lock. Other transactions wait.
- `FOR SHARE` — shared lock. Others can read but not modify.
- `FOR UPDATE SKIP LOCKED` — skip already locked rows. Good for job queues.
- `FOR UPDATE NOWAIT` — fail immediately if locked. Good for user-facing timeouts.

**Optimistic locking — no locks, check version on write:**
```sql
UPDATE orders SET status = 'shipped', version = version + 1
WHERE id = 1 AND version = 5;
-- If 0 rows affected → someone else updated → retry
```
- Also called optimistic concurrency control (OCC).
- Common in ORMs: Sequelize (`@Version`), TypeORM (`@VersionColumn`).

**Deadlocks:**
- Transaction A locks row 1, waits for row 2. Transaction B locks row 2, waits for row 1. Both stuck.
- PostgreSQL detects and kills one transaction with a deadlock error.
- **Prevent:** always lock rows in consistent order (by PK ascending). Keep transactions short.

**Advisory locks:**
- Application-level locks (not tied to rows/tables). `pg_advisory_lock(key)`.
- Use for: preventing duplicate cron jobs, distributed locking, singleton tasks.

</details><br>

### Data Patterns

<details>
<summary>Database migration strategies</summary>

**Schema migrations:**
- Version-controlled SQL scripts applied in order. Tools: Knex migrations, TypeORM migrations, Flyway, Liquibase.
- Each migration: `up()` (apply change) + `down()` (rollback). Run in CI/CD pipeline.
- **Never edit applied migrations** — always create a new one.

**Zero-downtime migrations (expand/contract):**
1. **Expand** — add the new column/table. Make it nullable or with a default. Deploy code that writes to both old and new.
2. **Migrate** — backfill existing data. Verify correctness.
3. **Contract** — switch reads to new column. Remove old column in a later migration.

**Dangerous operations:**
- Adding a NOT NULL column without a default → locks the table (PostgreSQL 11+ handles this better with defaults).
- Renaming a column → breaks old code during deploy. Use expand/contract instead.
- Adding an index on a large table → `CREATE INDEX CONCURRENTLY` to avoid locking.
- Dropping a column → ensure no code references it first. Deploy code removal first, then drop column.

**Tips:**
- Small, frequent migrations > large, infrequent ones.
- Test migrations on a staging copy of production data.
- Use `CREATE INDEX CONCURRENTLY` for production index additions.
- Keep migrations idempotent where possible (`IF NOT EXISTS`).

</details><br>

<details>
<summary>Caching patterns</summary>

**Cache-aside (lazy loading):**
- App checks cache first. On miss → query DB → store in cache → return.
- Cache can be stale (TTL controls staleness). Most common pattern.
- Invalidation: TTL expiry, or explicit delete on write.

**Write-through:**
- App writes to cache AND DB simultaneously on every write.
- Cache always fresh. But writes are slower (extra hop). Wastes cache space on rarely-read data.

**Write-behind (write-back):**
- App writes to cache. Async process writes to DB later (batched).
- Fastest writes. Risk of data loss if cache crashes before DB write.

**Read-through:**
- Cache itself fetches from DB on miss (cache handles the logic, not the app).
- Simpler app code. Supported by some cache providers.

**Cache invalidation strategies:**
- **TTL** — set expiration. Simple, eventual staleness. Balance freshness vs hit ratio.
- **Event-driven** — publish event on data change → subscriber invalidates cache. Consistent but complex.
- **Version key** — include version in cache key (`user:123:v5`). New version = new key, old one expires naturally.

**Common pitfalls:**
- **Cache stampede / thundering herd** — cache expires, many requests hit DB simultaneously. Fix: lock + single fetch, stagger TTLs, pre-warm.
- **Stale data** — cache returns outdated data. Fix: shorter TTL, event-driven invalidation.
- **Cold start** — empty cache after deploy/restart, all requests hit DB. Fix: pre-warm cache.

</details><br>

<details>
<summary>Replication and sharding</summary>

**Replication — copies of data across multiple nodes:**

- **Single-leader (primary-replica):** one primary handles writes, replicas handle reads. Most common (PostgreSQL, MySQL, MongoDB default).
  - **Synchronous** — primary waits for replica ACK. Strong consistency, higher latency.
  - **Asynchronous** — primary doesn't wait. Lower latency, risk of data loss on primary failure.
  - **Semi-synchronous** — wait for at least 1 replica. Compromise.

- **Multi-leader:** multiple nodes accept writes. Each replicates to others. Use for: multi-region writes. Complex conflict resolution.

- **Leaderless (quorum):** any node can accept reads/writes. Quorum: read from R nodes, write to W nodes, R + W > N ensures consistency. Cassandra, DynamoDB.

**Sharding (horizontal partitioning) — split data across multiple databases:**
- **Hash-based:** `shard = hash(user_id) % num_shards`. Even distribution, but re-sharding is hard (consistent hashing helps).
- **Range-based:** shard by range (users A-M on shard 1, N-Z on shard 2). Simple, but hot spots possible.
- **Geographic:** shard by region. Data locality for compliance or latency.

**When to shard:**
- Single DB can't handle the write throughput.
- Data is too large for one machine.
- Geographic data locality requirements.

**Challenges:**
- Cross-shard queries (joins across shards are expensive or impossible).
- Distributed transactions (2PC is slow, saga pattern adds complexity).
- Re-sharding / rebalancing when adding nodes.
- Operational complexity (N databases to manage instead of 1).

**Rule:** avoid sharding as long as possible. Vertical scaling, read replicas, caching, and query optimization solve most problems.

</details><br>

### NestJS + TypeORM

<details>
<summary>Working with PostgreSQL tables in NestJS (TypeORM)</summary>

**Setup:**
```typescript
// app.module.ts — global connection
TypeOrmModule.forRoot({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: 5432,
  database: process.env.DB_NAME,
  entities: [__dirname + '/**/*.entity{.ts,.js}'],
  synchronize: false, // NEVER true in production — use migrations
});

// orders.module.ts — register entities used in this module
TypeOrmModule.forFeature([Order, OrderItem])
```

**Entity definition:**
```typescript
@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  total: number;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status: OrderStatus;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => User, user => user.orders, { eager: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @OneToMany(() => OrderItem, item => item.order, { cascade: true })
  items: OrderItem[];
}
```

**Repository injection and usage:**
```typescript
@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private ordersRepo: Repository<Order>,
  ) {}

  findOne(id: string) {
    return this.ordersRepo.findOne({
      where: { id },
      relations: ['items', 'user'],
    });
  }

  async create(dto: CreateOrderDto) {
    const order = this.ordersRepo.create(dto);
    return this.ordersRepo.save(order);
  }

  // QueryBuilder for complex queries — avoids N+1, allows dynamic conditions
  findPendingByUser(userId: string) {
    return this.ordersRepo
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'item')
      .where('order.user_id = :userId', { userId })
      .andWhere('order.status = :status', { status: 'pending' })
      .orderBy('order.created_at', 'DESC')
      .getMany();
  }
}
```

**Transaction handling:**
```typescript
constructor(private dataSource: DataSource) {}

async transfer(fromId: string, toId: string, amount: number) {
  return this.dataSource.transaction(async manager => {
    const from = await manager.findOne(Account, {
      where: { id: fromId },
      lock: { mode: 'pessimistic_write' },
    });
    const to = await manager.findOne(Account, {
      where: { id: toId },
      lock: { mode: 'pessimistic_write' },
    });
    from.balance -= amount;
    to.balance += amount;
    await manager.save([from, to]);
  });
}
```

**Migrations:**
```bash
pnpm typeorm migration:generate src/migrations/AddOrderStatus -d src/data-source.ts
pnpm typeorm migration:run -d src/data-source.ts
```
- Always `synchronize: false` in production.
- Never edit a migration already applied to production — add a new one.

**Common pitfalls:**
- **N+1 with relations** — loading `relations: ['items']` inside a loop. Fix: fetch all at once with QueryBuilder + `leftJoinAndSelect`.
- **`synchronize: true` in prod** — TypeORM diffs entities and alters/drops columns. Data loss risk.
- **`eager: true` on relations** — loads relation on every query. Use explicit `relations` or QueryBuilder instead.
- **No pagination** — `find()` without `take`/`skip` loads the entire table. Always limit.

</details><br>

<details>
<summary>ORMs vs native SQL — when to use each</summary>

| | ORM (TypeORM, Prisma) | Native SQL / QueryBuilder (Knex, raw) |
|---|---|---|
| **Best for** | Standard CRUD, migrations, prototyping | Complex queries, bulk ops, perf-critical paths |
| **Type safety** | Strong — entities, generated types | Manual or partial (Knex) |
| **Query control** | Limited — ORM decides the SQL | Full control |
| **Performance** | Abstraction overhead, N+1 traps | Predictable and optimisable |
| **Migrations** | Built-in | Manual or separate tool |

**Use ORM when:**
- Standard CRUD with typed entities (user, order, product).
- You want migrations co-located with entity definitions.
- Team is mixed — not everyone writes SQL fluently.

**Use native SQL when:**
- Complex analytics: multiple CTEs, window functions, subqueries.
- Bulk operations: `INSERT ... SELECT`, `UPDATE ... FROM`, `COPY`.
- ORM-generated SQL is wrong or slow (verify with `EXPLAIN ANALYZE`).
- Raw ETL / data migration scripts.

**Pragmatic rule:** use ORM as the default, drop to raw SQL when the ORM fights you.

```typescript
// Raw SQL when needed — still callable from TypeORM
const rows = await this.dataSource.query<{ month: string; revenue: string }[]>(`
  SELECT date_trunc('month', created_at) AS month,
         SUM(total)::text AS revenue
  FROM orders
  WHERE status = 'completed'
  GROUP BY 1
  ORDER BY 1
`);
```

</details><br>

### Connection Pooling

<details>
<summary>Connection pooling — PgBouncer and TypeORM pool config</summary>

**Why it matters:** PostgreSQL forks a process per connection (~5–10 ms to open, ~5 MB RAM each). Without pooling, 500 concurrent app requests = 500 DB connections — PostgreSQL rejects them at default `max_connections = 100`.

**PgBouncer — pooler between app and DB:**

| Mode | Connection held for | Use case |
|---|---|---|
| **Session** | Entire client session | Legacy apps using session-level features (temp tables, `SET`) |
| **Transaction** | Duration of one transaction | **Standard choice** — high multiplexing, works with NestJS/TypeORM |
| **Statement** | Single statement | Rare — breaks multi-statement transactions |

**Transaction mode** lets 1,000 app connections share 50 DB connections because most time is spent outside transactions.

**Limitations of PgBouncer transaction mode:**
- `LISTEN`/`NOTIFY` won't work (session-scoped).
- Prepared statements need `server_reset_query` config.
- Advisory locks behave unexpectedly (session-scoped).

**TypeORM pool config:**
```typescript
TypeOrmModule.forRoot({
  type: 'postgres',
  // ...
  extra: {
    max: 20,                    // max connections in pool per app instance
    min: 5,                     // idle connections kept warm
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  },
});
```

**Typical production setup:**
```
N app pods (each with pool of 20)
        ↓
PgBouncer — transaction mode, poolSize=50
        ↓
PostgreSQL primary (max_connections=100)
        ↓ streaming replication
PostgreSQL replica ← read queries routed here
```

</details><br>

### Read Optimisation — Interview Answer

<details>
<summary>How to optimise PostgreSQL reads — layered answer</summary>

When asked *"What are PostgreSQL reading optimisations?"* — answer in layers, cheapest first:

**Layer 1 — Query (no infra changes):**
- Add missing indexes (`EXPLAIN ANALYZE` to confirm the problem first).
- Use covering indexes (`INCLUDE` columns) → index-only scans.
- Fix N+1 queries → JOIN or batch `WHERE id IN (...)`.
- Replace `OFFSET` pagination with keyset: `WHERE id > last_seen LIMIT N`.
- `SELECT` only needed columns — avoid `SELECT *`.

**Layer 2 — Schema:**
- Partial indexes for hot subsets (`WHERE status = 'active'`).
- Materialized views for expensive aggregations — refresh on schedule.
- Table partitioning (range by date) — queries scan only relevant partitions.
- Intentional denormalisation — store pre-joined data to skip joins at read time.

**Layer 3 — Infrastructure:**
- **Read replicas** — route all `SELECT` traffic to replicas, primary handles writes only.
- **Connection pooling** (PgBouncer) — reduce connection overhead, increase throughput.
- **Redis cache** — cache-aside for hot, rarely-changed data. TTL + invalidate on write.

**Layer 4 — Architecture:**
- CQRS — dedicated read model optimised for query patterns.
- Pre-compute results for read-heavy endpoints (product catalogue, leaderboards).
- CDN / edge caching for truly static or near-static data.

**In NestJS + TypeORM specifically:**
```typescript
// Project only needed fields
this.ordersRepo.find({ select: ['id', 'status', 'total'], where: { userId } });

// TypeORM query cache (in-memory or Redis)
this.ordersRepo.find({
  where: { status: 'active' },
  cache: { id: 'active_orders', milliseconds: 60_000 },
});

// Avoid eager-loading relations you don't need
// Bad:  @OneToMany(..., { eager: true })
// Good: explicit relations: ['items'] only when needed
```

</details><br>
