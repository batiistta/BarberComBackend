import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('Configure DATABASE_URL no arquivo .env.');
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
pool.on('error', error => console.error('Conexao PostgreSQL interrompida:', error.code));
