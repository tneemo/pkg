import { getDb } from "../db";

export interface User {
  id: number;
  email: string;
  created_at: string;
}

interface UserRow extends User {
  password_hash: string;
}

export function findUserByEmail(email: string): UserRow | undefined {
  return getDb().prepare("SELECT id, email, password_hash, created_at FROM users WHERE email = ?").get(email) as UserRow | undefined;
}

export function findUserById(id: number): User | undefined {
  return getDb().prepare("SELECT id, email, created_at FROM users WHERE id = ?").get(id) as User | undefined;
}

export function insertUser(email: string, passwordHash: string): User {
  return getDb()
    .prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?) RETURNING id, email, created_at")
    .get(email, passwordHash, new Date().toISOString()) as unknown as User;
}
