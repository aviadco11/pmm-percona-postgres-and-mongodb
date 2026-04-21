// init-mongo.js
// Creates a dedicated PMM monitoring user with minimal required permissions.
// Runs once on first container start via /docker-entrypoint-initdb.d/

db = db.getSiblingDB("admin");

db.createUser({
  user: "pmm",
  pwd: "pmm",
  roles: [
    { role: "clusterMonitor", db: "admin" },
    { role: "read", db: "local" },
    { role: "readAnyDatabase", db: "admin" },
  ],
});


