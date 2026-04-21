# Monitor PostgreSQL And MongoDB with PMM Percona

This repository contains a Docker Compose setup for:

- PostgreSQL community server
- MongoDB server
- Percona PMM server (metrics storage and UI)
- Percona PMM client agent (collects metrics from PostgreSQL and MongoDB)
- pgAdmin — web UI for PostgreSQL
- mongo-express — web UI for MongoDB

## Services at a glance

| Service       | Container name          | Image                       | Host port         | Purpose                                                  |
| ------------- | ----------------------- | --------------------------- | ----------------- | -------------------------------------------------------- |
| PMM UI        | `postgresdb_pmm_server` | `percona/pmm-server:2.43.2` | `80`, `443`       | Metrics dashboard and query analytics                    |
| PMM client    | `postgresdb_pmm_client` | `percona/pmm-client:2`      | —                 | Scrapes PostgreSQL and MongoDB, sends data to PMM server |
| PostgreSQL    | `postgres`              | `postgres:15`               | — (internal only) | Relational database                                      |
| MongoDB       | `mongodb`               | `mongo:7`                   | — (internal only) | Document database                                        |
| pgAdmin       | `postgresdb_pgadmin`    | `dpage/pgadmin4:latest`     | `5050`            | Web-based PostgreSQL administration                      |
| mongo-express | `mongo_express`         | `mongo-express:latest`      | `8081`            | Web-based MongoDB administration                         |

## Endpoints and connectivity

| Service               | URL                      | Auth                           | Notes                                                |
| --------------------- | ------------------------ | ------------------------------ | ---------------------------------------------------- |
| PMM UI                | `http://localhost`       | `admin` / `admin`              | Percona PMM dashboards and query analytics           |
| pgAdmin               | `http://localhost:5050`  | `admin@admin.com` / `admin`    | PostgreSQL web admin tool                            |
| mongo-express         | `http://localhost:8081`  | `admin` / `admin123`           | MongoDB web admin tool (basic auth)                  |
| PostgreSQL (internal) | `postgres:5432`          | `postgresdb` / `postgresdb123` | Docker network hostname; use inside other containers |
| MongoDB (internal)    | `mongodb:27017`          | `mongoadmin` / `mongoadmin123` | Docker network hostname; use inside other containers |
| PMM server (internal) | `https://pmm-server:443` | `admin` / `admin`              | Used by `pmm-client` inside the network              |

## Credentials reference

| Service       | User type              | Username          | Password        |
| ------------- | ---------------------- | ----------------- | --------------- |
| PMM UI        | Admin                  | `admin`           | `admin`         |
| PostgreSQL    | App user               | `postgresdb`      | `postgresdb123` |
| PostgreSQL    | PMM monitoring user    | `pmm`             | `pmm`           |
| MongoDB       | Root user              | `mongoadmin`      | `mongoadmin123` |
| MongoDB       | PMM monitoring user    | `pmm`             | `pmm`           |
| pgAdmin       | Web login              | `admin@admin.com` | `admin`         |
| mongo-express | Web login (basic auth) | `admin`           | `admin123`      |

## Services

### postgres

- Image: `postgres:15`
- Container name: `postgres`
- Database: `testdb`
- Init script: `./init-postgres.sh` — creates the `pg_stat_statements` extension and a dedicated PMM monitoring user (`pmm`)
- Started with monitoring-friendly runtime flags:

  | Flag                         | Value                | Purpose                                                             |
  | ---------------------------- | -------------------- | ------------------------------------------------------------------- |
  | `shared_preload_libraries`   | `pg_stat_statements` | Enables query-level statistics collection                           |
  | `track_activity_query_size`  | `2048`               | Stores up to 2 KB of query text per entry                           |
  | `logging_collector`          | `on`                 | Writes log lines to files rather than stdout only                   |
  | `log_min_duration_statement` | `10`                 | Logs all queries taking longer than 10 ms                           |
  | `log_line_prefix`            | `%m [%p] %q%u@%d`    | Adds timestamp, PID, user, and database to each log line            |
  | `log_statement`              | `none`               | Avoids logging every statement (duration threshold is used instead) |

### mongodb

- Image: `mongo:7`
- Container name: `mongodb`
- Root user: `mongoadmin` / `mongoadmin123` (set via `.env`)
- Init script: `./init-mongo.js` — creates a dedicated `pmm` monitoring user with minimal permissions
- Started with profiling enabled for all queries slower than 10 ms:

  ```
  mongod --profile=1 --slowms=10 --auth
  ```

  This writes slow query data to `system.profile` in each database, which PMM reads for query analytics.

### pmm-server

- Image: `percona/pmm-server:2.43.2` (pinned — 2.44.1 has broken Python encodings)
- Container name: `postgresdb_pmm_server`
- Exposes ports `80` (HTTP) and `443` (HTTPS) on the host
- `PMM_DATA_RETENTION=48h` — metrics older than 48 hours are automatically purged to control disk usage
- A Docker healthcheck polls `/v1/readyz` every 15 s (up to 40 retries, 180 s start grace period) so dependent services wait until the server is genuinely ready

### pmm-client

- Image: `percona/pmm-client:2`
- Container name: `postgresdb_pmm_client`
- Depends on `pmm-server` being healthy, `postgres` started, and `mongodb` started
- Runs a multi-step shell entrypoint:

#### pmm-client entrypoint — step by step

```sh
# Step 1 — Clear stale agent config
# Removes any leftover pmm-agent.yml from a previous container run to prevent
# registration conflicts on restart.
rm -f /usr/local/percona/pmm2/config/pmm-agent.yml

# Step 2 — Wait for PMM server API
# Polls /v1/readyz up to 40 times (5 s apart) at the application level,
# complementing the Docker healthcheck.
for i in $(seq 1 40); do
  curl -kfsS https://pmm-server:443/v1/readyz >/dev/null 2>&1 && break
  sleep 5
done

# Step 3 — Register the agent
# Writes a config file that tells the agent where the PMM server is and
# how to authenticate. --server-insecure-tls skips cert validation for
# the internal Docker TLS endpoint.
pmm-agent setup \
  --server-insecure-tls \
  --server-address=pmm-server:443 \
  --server-username=admin \
  --server-password=admin \
  --config-file=/usr/local/percona/pmm2/config/pmm-agent.yml

# Step 4 — Start the agent daemon
# Runs in the background so the script can continue to add services.
pmm-agent --config-file=/usr/local/percona/pmm2/config/pmm-agent.yml &

# Step 5 — Wait for the agent to be ready
# pmm-admin status returns 0 only when the agent is connected and ready.
for i in $(seq 1 20); do
  pmm-admin status >/dev/null 2>&1 && break
  sleep 3
done

# Step 6 — Register PostgreSQL for monitoring
# Uses pg_stat_statements as the query source.
# || true makes a duplicate registration non-fatal.
pmm-admin add postgresql \
  --username="$PMM_CLIENT_USER" \
  --password="$PMM_CLIENT_PASSWORD" \
  --host=postgres \
  --port=5432 \
  --database="$POSTGRES_DB" \
  --service-name=postgres \
  --query-source=pgstatements || true

# Step 7 — Register MongoDB for monitoring
# Uses the profiler (system.profile) as the query source.
# The dedicated pmm user was created by init-mongo.js.
pmm-admin add mongodb \
  --username="pmm" \
  --password="pmm" \
  --authentication-database=admin \
  --host=mongodb \
  --port=27017 \
  --service-name=mongodb \
  --query-source=profiler || true
```

### pgadmin

- Image: `dpage/pgadmin4:latest`
- Container name: `postgresdb_pgadmin`
- Web-based PostgreSQL administration exposed on host port `5050`
- Connect to PostgreSQL using host `postgres`, port `5432`

### mongo-express

- Image: `mongo-express:latest`
- Container name: `mongo_express`
- Web-based MongoDB administration exposed on host port `8081`
- Protected by HTTP basic auth (`admin` / `admin123`)
- Connects to `mongodb:27017` as the root user

## Architecture and service connections

All containers share the fixed Docker bridge network `postgresdb_network`.

```
pgadmin       ──► postgres:5432
mongo-express ──► mongodb:27017
pmm-client    ──► pmm-server:443  (agent registration)
pmm-client    ──► postgres:5432   (pg_stat_statements scrape)
pmm-client    ──► mongodb:27017   (profiler scrape)
```

Service startup order:

1. `postgres` starts and runs `init-postgres.sh` (first deploy only — creates `pg_stat_statements` extension and `pmm` user).
2. `mongodb` starts and runs `init-mongo.js` (first deploy only — creates `pmm` monitoring user).
3. `pmm-server` starts; healthcheck waits until `/v1/readyz` returns 200.
4. `pmm-client` starts only after all three above are ready, then registers itself and adds both database services.
5. `pgadmin` and `mongo-express` start after their respective databases are up.

## Environment configuration

All credentials live in `.env`. Edit before first run:

```env
# PostgreSQL credentials
POSTGRES_USER=postgresdb
POSTGRES_PASSWORD=postgresdb123
POSTGRES_DB=testdb

# PMM monitoring user for PostgreSQL (created by init-postgres.sh)
PMM_CLIENT_USER=pmm
PMM_CLIENT_PASSWORD=pmm

# pgAdmin credentials
PGADMIN_DEFAULT_EMAIL=admin@admin.com
PGADMIN_DEFAULT_PASSWORD=admin

# MongoDB credentials
MONGO_ROOT_USER=mongoadmin
MONGO_ROOT_PASSWORD=mongoadmin123

# mongo-express credentials (HTTP basic auth)
MONGO_EXPRESS_USER=admin
MONGO_EXPRESS_PASSWORD=admin123
```

## Docker Compose commands

Start all services:

```bash
docker-compose up -d
```

Stop all services (data volumes are preserved):

```bash
docker-compose down
```

Stop and remove all data volumes (full reset):

```bash
docker-compose down -v
```

View logs for a specific service:

```bash
docker-compose logs -f pmm-client
docker-compose logs -f mongodb
```

## Initialization scripts

### init-postgres.sh

Runs automatically on first PostgreSQL container start. It:

1. Creates the `pg_stat_statements` extension — required for `--query-source=pgstatements`.
2. Creates the `pmm` user with the password from `PMM_CLIENT_PASSWORD`.
3. Grants the built-in `pg_monitor` role to `pmm` — covers `pg_stat_statements`, `pg_stat_activity`, and replication stats without needing superuser.

```bash
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
  CREATE USER ${PMM_CLIENT_USER} WITH ENCRYPTED PASSWORD '${PMM_CLIENT_PASSWORD}';
  GRANT pg_monitor TO ${PMM_CLIENT_USER};
EOSQL
```

### init-mongo.js

Runs automatically on first MongoDB container start. It creates a dedicated `pmm` monitoring user in the `admin` database with minimal required permissions:

```js
db = db.getSiblingDB("admin");

db.createUser({
  user: "pmm",
  pwd: "pmm",
  roles: [
    { role: "clusterMonitor", db: "admin" }, // server metrics: connections, CPU, memory
    { role: "read", db: "local" }, // oplog access for replication lag monitoring
    { role: "readAnyDatabase", db: "admin" }, // system.profile across all databases for QAN
  ],
});
```

Role reference:

| Role              | Database | Purpose                                                               |
| ----------------- | -------- | --------------------------------------------------------------------- |
| `clusterMonitor`  | `admin`  | `serverStatus`, `replSetGetStatus`, connection and operation counters |
| `read`            | `local`  | Read `local.oplog.rs` for replication lag calculation                 |
| `readAnyDatabase` | `admin`  | Read `system.profile` on every database for query analytics           |

The user must be created in `admin` because `clusterMonitor` and `readAnyDatabase` are admin-only roles.

## Adding a new service to monitor

### Add a PostgreSQL instance

**Step 1 — Create a monitoring user on the target database:**

```sql
CREATE USER pmm WITH ENCRYPTED PASSWORD 'pmm_password';
GRANT pg_monitor TO pmm;

-- Required for query analytics
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

**Step 2 — Register from inside the pmm-client container:**

```bash
docker exec -it postgresdb_pmm_client sh
```

```sh
# Local / Docker container
pmm-admin add postgresql \
  --username="pmm" \
  --password="pmm_password" \
  --host=<host> \
  --port=5432 \
  --database=<dbname> \
  --service-name=<unique-service-name> \
  --query-source=pgstatements

# RDS / Aurora — skip TLS verification (testing)
pmm-admin add postgresql \
  --username="pmm" \
  --password="pmm_password" \
  --host=<rds-endpoint>.rds.amazonaws.com \
  --port=5432 \
  --database=<dbname> \
  --service-name=<unique-service-name> \
  --query-source=pgstatements \
  --tls \
  --tls-skip-verify

# RDS / Aurora — with Amazon CA bundle (production)
curl -k -o /tmp/rds-ca.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

pmm-admin add postgresql \
  --username="pmm" \
  --password="pmm_password" \
  --host=<rds-endpoint>.rds.amazonaws.com \
  --port=5432 \
  --database=<dbname> \
  --service-name=<unique-service-name> \
  --query-source=pgstatements \
  --tls \
  --tls-ca-file=/tmp/rds-ca.pem
```

**Step 3 — Verify:**

```bash
pmm-admin list
```

### Add a MongoDB instance

**Step 1 — Create a monitoring user on the target MongoDB:**

```js
use admin

db.createUser({
  user: "pmm",
  pwd: "pmm_password",
  roles: [
    { role: "clusterMonitor",  db: "admin" },
    { role: "read",            db: "local"  },
    { role: "readAnyDatabase", db: "admin"  }
  ]
})
```

**Step 2 — Register from inside the pmm-client container:**

```bash
docker exec -it postgresdb_pmm_client sh
```

```sh
# Standalone or replica set
pmm-admin add mongodb \
  --username="pmm" \
  --password="pmm_password" \
  --authentication-database=admin \
  --host=<host> \
  --port=27017 \
  --service-name=<unique-service-name> \
  --query-source=profiler

# TLS-enabled (Atlas, self-managed TLS)
pmm-admin add mongodb \
  --username="pmm" \
  --password="pmm_password" \
  --authentication-database=admin \
  --host=<host> \
  --port=27017 \
  --service-name=<unique-service-name> \
  --query-source=profiler \
  --tls \
  --tls-skip-verify
```

**Step 3 — Verify:**

```bash
pmm-admin list
```

## Notes

- PMM data retention is set to `48h` via `PMM_DATA_RETENTION=48h` on `pmm-server`. Metrics older than 48 hours are automatically purged.
- The `pmm-server` image is pinned to `2.43.2` — version `2.44.1` has known broken Python encodings.
- Amazon DocumentDB is **not supported** by PMM MongoDB monitoring — it blocks the `getDiagnosticData` command that PMM requires. Use CloudWatch for DocumentDB metrics instead.
- All services share the `postgresdb_network` bridge network with a fixed name to prevent Docker Compose from prepending the project folder name.
- Persistent data is stored in named Docker volumes: `postgres_data`, `pmm_data`, `pgadmin_data`, and `mongo_data`.
- If you change PMM user credentials, update `.env` and re-run `docker-compose up -d` to recreate the affected containers.


