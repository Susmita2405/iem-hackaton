// src/config/database.js
import pg from 'pg';
import logger from '../utils/logger.js';

const { Pool } = pg;

let pool;

export async function connectDB() {
  pool = new Pool({
    host:     process.env.DB_HOST || 'localhost',
    port:     Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'soumyaops',
    user:     process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    max:      20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
  });

  // Test connection
  const client = await pool.connect();
  await client.query('SELECT NOW()');
  client.release();
  return pool;
}

export function getDB() {
  if (!pool) throw new Error('Database not initialized. Call connectDB() first.');
  return pool;
}

// Convenience query wrapper
export async function query(sql, params) {
  const db = getDB();
  try {
    return await db.query(sql, params);
  } catch (err) {
    logger.error('DB Query Error:', { sql: sql.slice(0, 100), err: err.message });
    throw err;
  }
}

// Transaction helper
export async function withTransaction(fn) {
  const client = await getDB().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}