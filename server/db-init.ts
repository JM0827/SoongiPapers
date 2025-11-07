import { readFileSync } from "fs";
import path from "node:path";
import { Pool } from "pg";
import * as dotenv from "dotenv";

dotenv.config();

async function initDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set to initialize the database");
  }

  const sqlPath = path.resolve(__dirname, "db-schema.sql");
  const sql = readFileSync(sqlPath, "utf8");
  const pool = new Pool({ connectionString });
  await pool.query(sql);
  console.log("PostgreSQL tables initialized.");
  await pool.end();
}

initDb().catch((e) => {
  console.error(e);
  process.exit(1);
});
