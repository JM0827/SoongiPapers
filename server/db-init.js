db.exec(
  "\nCREATE TABLE IF NOT EXISTS jobs(\n  id TEXT PRIMARY KEY, document_id TEXT, type TEXT, status TEXT,\n  created_at TEXT, started_at TEXT, finished_at TEXT, attempts INT, last_error TEXT\n);\nCREATE TABLE IF NOT EXISTS kv (\n  k TEXT PRIMARY KEY, v TEXT, updated_at TEXT\n);\nCREATE TABLE IF NOT EXISTS ratelimits (\n  key TEXT, ts TEXT\n);\n",
);

// This file is no longer used. See db-init.ts for PostgreSQL setup.
