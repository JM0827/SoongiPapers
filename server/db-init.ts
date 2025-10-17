import { Pool } from "pg";
import { readFileSync } from "fs";

async function initDb() {
  const sql = readFileSync("db-schema.sql", "utf8");
  const pool = new Pool({ connectionString: process.env.PG_URI });
  await pool.query(sql);
  console.log("PostgreSQL tables initialized.");
  await pool.end();
}

initDb().catch((e) => {
  console.error(e);
  process.exit(1);
});
