import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

export type Db = NeonHttpDatabase<typeof schema>;

export function getDb(databaseUrl: string): Db {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema });
}
