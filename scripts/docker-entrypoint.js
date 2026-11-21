import { mkdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn, spawnSync } from 'node:child_process';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL é obrigatório.');
  process.exit(1);
}

mkdirSync('work', { recursive: true });

async function waitForDb() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (error) {
      try { await client.end(); } catch {}
      console.log('Aguardando PostgreSQL...', error.code || error.message);
      await sleep(2000);
    }
  }
  throw new Error('PostgreSQL não ficou disponível a tempo.');
}

async function migrate() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows: [row] } = await client.query("SELECT to_regclass('public.usuario') AS tabela");
    if (!row.tabela) await client.query(readFileSync(new URL('../database/001_estrutura.sql', import.meta.url), 'utf8'));
    for (const file of [
      '002_acesso.sql',
      '003_conflitos.sql',
      '004_agendamentos.sql',
      '005_complementos.sql',
      '006_foto_referencia_agendamento.sql'
    ]) {
      await client.query(readFileSync(new URL(`../database/${file}`, import.meta.url), 'utf8'));
    }
  } finally {
    await client.end();
  }
}

await waitForDb();
await migrate();

const prepare = spawnSync(process.execPath, ['scripts/preparar-aplicacao.js'], { stdio: 'inherit', env: process.env });
if (prepare.status !== 0) process.exit(prepare.status ?? 1);

const child = spawn(process.execPath, ['src/server.js'], {
  stdio: 'inherit',
  env: process.env
});
child.on('exit', code => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
