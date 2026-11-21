import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { hashPassword, verifyPassword } from '../src/password.js';

test('senha recebe salt e verifica sem salvar texto puro', async () => {
  const hash = await hashPassword('senha de teste');
  assert.notEqual(hash, await hashPassword('senha de teste'));
  assert.equal(await verifyPassword('senha de teste', hash), true);
  assert.equal(await verifyPassword('outra senha', hash), false);
  assert.equal(await verifyPassword('senha de teste', 'invalido'), false);
});

test('API gestor: unidades, serviços, profissionais e horários', async t => {
  const schema = `teste_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
    assert.match(schema, /^teste_[a-f0-9]{16}$/);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  for (const file of ['001_estrutura.sql', '002_acesso.sql', '003_conflitos.sql', '004_agendamentos.sql', '005_complementos.sql', '006_foto_referencia_agendamento.sql']) {
    await pool.query(await readFile(new URL(`../database/${file}`, import.meta.url), 'utf8'));
  }
  const password = 'SenhaDeTeste@2026';
  await pool.query(
    "INSERT INTO usuario (nome, telefone, senha_hash, perfil) VALUES ('Gestor teste', '71900000000', $1, 'GESTOR')",
    [await hashPassword(password)]
  );
  const app = createApp(pool, randomBytes(32).toString('hex'));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let csrf = '';
  const call = async (path, body) => {
    const response = await fetch(base + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await response.json();
    if (data.csrf) csrf = data.csrf;
    return { status: response.status, data };
  };

  assert.equal((await call('/unidades')).status, 401);
  assert.equal((await call('/login')).status, 200);
  assert.equal((await call('/login', { telefone: '71900000000', senha: 'errada' })).status, 401);
  assert.equal((await call('/login', { telefone: '(71) 90000-0000', senha: password })).status, 200);
  assert.equal((await call('/sessao')).data.usuario.perfil, 'GESTOR');

  let page = await call('/unidades');
  assert.equal(page.status, 200);
  assert.equal(page.data.unidades.length, 0);
  assert.equal((await call('/unidades', { nome: '   ', endereco: 'Endereco', ativa: 'true' })).status, 400);
  assert.equal((await call('/unidades', { nome: 'Unidade <script>alert(1)</script>', endereco: 'Endereco', ativa: 'true' })).status, 200);
  page = await call('/unidades');
  assert.equal(page.data.unidades.length, 1);
  assert.match(page.data.unidades[0].nome, /script/);

  const unitId = String(page.data.unidades[0].id);
  assert.equal((await call(`/unidades/${unitId}/situacao`, { ativa: 'false' })).status, 200);
  assert.equal((await call(`/unidades/${unitId}/situacao`, { ativa: 'true' })).data.ativo, true);

  assert.equal((await call('/servicos', {
    nome: 'Corte', ativo: 'true', unidades: [unitId], [`preco_${unitId}`]: '35,50', [`duracao_${unitId}`]: '30'
  })).status, 200);
  page = await call('/servicos');
  assert.equal(page.status, 200);
  assert.ok(page.data.servicos.some(s => s.nome === 'Corte'));

  const serviceId = String(page.data.servicos.find(s => s.nome === 'Corte').id);
  assert.equal((await call('/profissionais', {
    nome: 'Profissional', ativo: 'true', foto_url: '', unidades: [unitId], servicos: [serviceId]
  })).status, 201);
  page = await call('/profissionais');
  assert.ok(page.data.profissionais.some(p => p.nome === 'Profissional'));

  const vinculo = (await call('/horarios')).data.vinculos[0];
  assert.ok(vinculo);
  assert.equal((await call('/horarios', {
    vinculo: String(vinculo.id), tipo: 'turno', dias: ['1'], inicio: '09:00', fim: '18:00'
  })).status, 200);
  assert.equal((await call('/horarios', {
    vinculo: String(vinculo.id), tipo: 'pausa', turno: (await call(`/horarios?vinculo=${vinculo.id}`)).data.turnos[0].id,
    descricao: 'Almoço', inicio: '12:00', fim: '13:00'
  })).status, 200);

  await call('/sair', {});
  assert.equal((await call('/sessao')).data.usuario, null);
  assert.equal((await call('/unidades')).status, 401);
});
