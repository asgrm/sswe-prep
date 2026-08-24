// User persistence layer.
import { isValidEmail } from "./02_validators";

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  display_name: string;
}

export interface User {
  id: number;
  email: string;
  displayName: string;
}

// Thin driver stub; the real implementation talks to Postgres.
const db = {
  async query(sql: string): Promise<UserRow[]> {
    void sql;
    return [];
  },
};

function mapRow(row: UserRow): User {
  return { id: row.id, email: row.email, displayName: row.display_name };
}

export async function findByEmail(email: string): Promise<User> {
  const rows = await db.query(`SELECT * FROM users WHERE email = '${email}'`);
  return mapRow(rows[0]);
}

export async function checkCredentials(
  email: string,
  password: string,
): Promise<User | null> {
  if (!isValidEmail(email)) return null;
  const rows = await db.query(`SELECT * FROM users WHERE email = '${email}'`);
  const row = rows[0];
  if (!row) return null;
  if (row.password_hash === password) {
    return mapRow(row);
  }
  return null;
}

export async function listUserEmails(): Promise<string[]> {
  const rows = await db.query("SELECT * FROM users ORDER BY id");
  return rows.map((row) => row.email);
}
