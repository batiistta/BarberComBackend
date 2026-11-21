import { pool } from '../src/db.js';
import { hashPassword } from '../src/password.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const telefone = process.env.ADMIN_PHONE;
const senha = process.env.ADMIN_PASSWORD;
if (!/^\d{10,15}$/.test(telefone) || !senha || senha.length < 12 || senha.length > 256) {
  throw new Error('Defina ADMIN_PHONE e ADMIN_PASSWORD (12 a 256 caracteres) no .env.');
}

const bahiaDate = async (client, offsetDays, time) => {
  const { rows: [row] } = await client.query(
    `SELECT to_char(((now() AT TIME ZONE 'America/Bahia')::date + $1::int) + $2::time, 'YYYY-MM-DD"T"HH24:MI:SS') AS ts,
            ((now() AT TIME ZONE 'America/Bahia')::date + $1::int) AS dia`,
    [offsetDays, time]
  );
  return row;
};

try {
  await mkdir('work', { recursive: true });
  const adminHash = await hashPassword(senha);
  await pool.query(
    `INSERT INTO usuario (nome, telefone, senha_hash, perfil)
     VALUES ($1, $2, $3, 'GESTOR')
     ON CONFLICT (telefone) DO NOTHING`,
    ['Gestor de demonstracao', telefone, adminHash]
  );
  await writeFile(
    'work/acesso-local.txt',
    `Acesso local BarberCom\nAPI: http://localhost:${process.env.PORT || 3000}\nFront: http://localhost:5173\nGestor: ${telefone} / ${senha}\nClientes demo: 71988880001..003 / SenhaCliente@2026\n`,
    { mode: 0o600 }
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Unidades
    if (!(await client.query('SELECT 1 FROM unidade LIMIT 1')).rowCount) {
      const unidades = JSON.parse(await readFile(new URL('../database/unidades-demonstracao.json', import.meta.url), 'utf8'));
      for (const u of unidades) {
        await client.query(
          'INSERT INTO unidade (nome,endereco,ativa,latitude,longitude) VALUES ($1,$2,$3,$4,$5)',
          [u.nome, u.endereco, u.ativa, u.latitude, u.longitude]
        );
      }
      await client.query(
        `INSERT INTO unidade (nome,endereco,ativa,latitude,longitude) VALUES
         ('Unidade Pituba','Av. Paulo VI, s/n — Pituba, Salvador/BA (barbearia fictícia)',true,-12.9868,-38.4582),
         ('Unidade Imbuí','Av. Luís Viana Filho, s/n — Imbuí, Salvador/BA (barbearia fictícia)',true,-12.9415,-38.4248)`
      );
    }

    // Serviços + ofertas
    if (!(await client.query('SELECT 1 FROM servico LIMIT 1')).rowCount) {
      const servicos = [
        ['Corte', 35, 30],
        ['Barba', 25, 30],
        ['Corte + Barba', 55, 50],
        ['Sobrancelha', 15, 15],
        ['Hidratação', 40, 40],
        ['Pigmentação', 60, 45]
      ];
      for (const [nome] of servicos) {
        await client.query('INSERT INTO servico (nome) VALUES ($1)', [nome]);
      }
      for (const [nome, preco, duracao] of servicos) {
        await client.query(
          `INSERT INTO oferta_servico (unidade_id, servico_id, preco, duracao_minutos, ativa)
           SELECT u.id, s.id, $2 + (u.id % 3), $3, u.ativa
           FROM unidade u CROSS JOIN servico s
           WHERE s.nome = $1
           ON CONFLICT (unidade_id, servico_id) DO NOTHING`,
          [nome, preco, duracao]
        );
      }
      await client.query(`UPDATE oferta_servico SET ativa=false
        WHERE servico_id = (SELECT id FROM servico WHERE nome='Pigmentação')
          AND unidade_id = (SELECT id FROM unidade WHERE nome='Unidade Imbuí')`);
    }

    // Usuários extras
    const clientes = [
      ['Ana Souza', '71988880001'],
      ['Bruno Lima', '71988880002'],
      ['Carla Dias', '71988880003'],
      ['Diego Rocha', '71988880004'],
      ['Elena Prado', '71988880005']
    ];
    const clienteHash = await hashPassword('SenhaCliente@2026');
    for (const [nome, tel] of clientes) {
      await client.query(
        `INSERT INTO usuario (nome, telefone, senha_hash, perfil)
         VALUES ($1,$2,$3,'CLIENTE') ON CONFLICT (telefone) DO NOTHING`,
        [nome, tel, clienteHash]
      );
    }
    await client.query(
      `INSERT INTO usuario (nome, telefone, senha_hash, perfil, ativo)
       VALUES ('Cliente inativo','71988880999',$1,'CLIENTE',false)
       ON CONFLICT (telefone) DO NOTHING`,
      [clienteHash]
    );
    const gestor2Hash = await hashPassword('SenhaGestor2@2026');
    await client.query(
      `INSERT INTO usuario (nome, telefone, senha_hash, perfil)
       VALUES ('Gestor auxiliar','71999990001',$1,'GESTOR')
       ON CONFLICT (telefone) DO NOTHING`,
      [gestor2Hash]
    );

    // Profissionais
    if (!(await client.query('SELECT 1 FROM profissional LIMIT 1')).rowCount) {
      const profs = [
        ['Pedro Sampaio', true, ['Unidade Barra', 'Unidade Federação'], ['Corte', 'Barba', 'Corte + Barba', 'Sobrancelha']],
        ['Jorge Matheus', true, ['Unidade Barra', 'Unidade Pituba'], ['Corte', 'Barba', 'Hidratação']],
        ['Marina Alves', true, ['Unidade Federação', 'Unidade Imbuí'], ['Corte', 'Sobrancelha', 'Pigmentação']],
        ['Rafael Nunes', true, ['Unidade Pituba'], ['Corte', 'Barba', 'Corte + Barba']],
        ['Tiago Reis', false, ['Unidade Imbuí'], ['Barba']]
      ];
      for (const [nome, ativo, unidades, servicos] of profs) {
        const { rows: [p] } = await client.query(
          'INSERT INTO profissional (nome, ativo) VALUES ($1,$2) RETURNING id',
          [nome, ativo]
        );
        for (const unidadeNome of unidades) {
          await client.query(
            `INSERT INTO vinculo_profissional_unidade (profissional_id, unidade_id, ativo)
             SELECT $1, id, $3 FROM unidade WHERE nome=$2
             ON CONFLICT (profissional_id, unidade_id) DO NOTHING`,
            [p.id, unidadeNome, ativo]
          );
        }
        for (const servicoNome of servicos) {
          await client.query(
            `INSERT INTO profissional_servico (profissional_id, servico_id)
             SELECT $1, id FROM servico WHERE nome=$2
             ON CONFLICT DO NOTHING`,
            [p.id, servicoNome]
          );
        }
      }
    }

    // Turnos / pausas / bloqueios (sem sobrepor o mesmo profissional em unidades diferentes)
    if (!(await client.query('SELECT 1 FROM turno_trabalho LIMIT 1')).rowCount) {
      const { rows: vinculos } = await client.query(
        `SELECT v.id, v.profissional_id, p.nome AS profissional, u.nome AS unidade,
                row_number() OVER (PARTITION BY v.profissional_id ORDER BY v.id) AS ordem
         FROM vinculo_profissional_unidade v
         JOIN profissional p ON p.id=v.profissional_id
         JOIN unidade u ON u.id=v.unidade_id
         WHERE v.ativo AND p.ativo AND u.ativa`
      );
      for (const v of vinculos) {
        const manha = Number(v.ordem) % 2 === 1;
        const dias = manha ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
        for (const dia of dias) {
          const inicio = manha ? (dia === 6 ? '09:00' : '08:00') : '14:00';
          const fim = manha ? (dia === 6 ? '13:00' : '13:00') : (dia === 5 ? '20:00' : '19:00');
          const { rows: [turno] } = await client.query(
            `INSERT INTO turno_trabalho (vinculo_id, dia_semana, hora_inicio, hora_fim)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [v.id, dia, inicio, fim]
          );
          if (turno && manha && dia <= 5) {
            await client.query(
              `INSERT INTO pausa_trabalho (turno_id, descricao, hora_inicio, hora_fim)
               VALUES ($1,'Café','10:30','10:45')`,
              [turno.id]
            );
          }
          if (turno && !manha && dia <= 5) {
            await client.query(
              `INSERT INTO pausa_trabalho (turno_id, descricao, hora_inicio, hora_fim)
               VALUES ($1,'Lanche','16:00','16:15')`,
              [turno.id]
            );
          }
        }
      }
      if (vinculos[0]) {
        await client.query(
          `INSERT INTO bloqueio_agenda (vinculo_id, data, descricao, tipo, hora_inicio, hora_fim)
           VALUES ($1, (now() AT TIME ZONE 'America/Bahia')::date + 10, 'Feriado municipal fictício', 'FERIADO', NULL, NULL)`,
          [vinculos[0].id]
        );
        await client.query(
          `INSERT INTO bloqueio_agenda (vinculo_id, data, descricao, tipo, hora_inicio, hora_fim)
           VALUES ($1, (now() AT TIME ZONE 'America/Bahia')::date + 3, 'Consulta médica', 'INDISPONIBILIDADE', '14:00', '16:00')`,
          [vinculos[Math.min(1, vinculos.length - 1)].id]
        );
      }
    }

    // Agendamentos de demonstração
    if (!(await client.query('SELECT 1 FROM agendamento LIMIT 1')).rowCount) {
      const { rows: [cliente1] } = await client.query("SELECT id FROM usuario WHERE telefone='71988880001'");
      const { rows: [cliente2] } = await client.query("SELECT id FROM usuario WHERE telefone='71988880002'");
      const { rows: [cliente3] } = await client.query("SELECT id FROM usuario WHERE telefone='71988880003'");
      const { rows: vinculos } = await client.query(
        `SELECT v.id, v.profissional_id, o.id AS oferta_id, o.preco, o.duracao_minutos, s.nome AS servico
         FROM vinculo_profissional_unidade v
         JOIN unidade u ON u.id=v.unidade_id
         JOIN profissional p ON p.id=v.profissional_id
         JOIN profissional_servico ps ON ps.profissional_id=p.id
         JOIN servico s ON s.id=ps.servico_id
         JOIN oferta_servico o ON o.unidade_id=u.id AND o.servico_id=s.id AND o.ativa
         WHERE v.ativo AND p.ativo AND u.ativa AND s.nome='Corte'
         ORDER BY v.id LIMIT 5`
      );
      if (cliente1 && vinculos[0]) {
        const passado = await bahiaDate(client, -2, '10:00');
        const passadoFim = await bahiaDate(client, -2, '10:30');
        const { rows: [a1] } = await client.query(
          `INSERT INTO agendamento (cliente_id, vinculo_id, inicio, fim, status, valor_total, origem)
           VALUES ($1,$2,$3,$4,'CONCLUIDO',$5,'AGENDAMENTO') RETURNING id`,
          [cliente1.id, vinculos[0].id, passado.ts, passadoFim.ts, vinculos[0].preco]
        );
        await client.query(
          `INSERT INTO item_agendamento (agendamento_id, oferta_id, nome, preco, duracao_minutos, tipo, profissional_id)
           VALUES ($1,$2,$3,$4,$5,'SERVICO',$6)`,
          [a1.id, vinculos[0].oferta_id, vinculos[0].servico, vinculos[0].preco, vinculos[0].duracao_minutos, vinculos[0].profissional_id]
        );
      }
      if (cliente2 && (vinculos[1] || vinculos[0])) {
        const v = vinculos[1] || vinculos[0];
        const futuro = await bahiaDate(client, 2, '11:00');
        const futuroFim = await bahiaDate(client, 2, '11:30');
        const { rows: [a2] } = await client.query(
          `INSERT INTO agendamento (cliente_id, vinculo_id, inicio, fim, status, valor_total, origem)
           VALUES ($1,$2,$3,$4,'CONFIRMADO',$5,'AGENDAMENTO') RETURNING id`,
          [cliente2.id, v.id, futuro.ts, futuroFim.ts, v.preco]
        );
        await client.query(
          `INSERT INTO item_agendamento (agendamento_id, oferta_id, nome, preco, duracao_minutos, tipo, profissional_id)
           VALUES ($1,$2,$3,$4,$5,'SERVICO',$6)`,
          [a2.id, v.oferta_id, v.servico, v.preco, v.duracao_minutos, v.profissional_id]
        );
      }
      if (cliente3 && vinculos[0]) {
        const cancelado = await bahiaDate(client, 5, '15:00');
        const canceladoFim = await bahiaDate(client, 5, '15:30');
        const { rows: [a3] } = await client.query(
          `INSERT INTO agendamento (cliente_id, vinculo_id, inicio, fim, status, valor_total, origem)
           VALUES ($1,$2,$3,$4,'CANCELADO',$5,'AGENDAMENTO') RETURNING id`,
          [cliente3.id, vinculos[0].id, cancelado.ts, canceladoFim.ts, vinculos[0].preco]
        );
        await client.query(
          `INSERT INTO item_agendamento (agendamento_id, oferta_id, nome, preco, duracao_minutos, tipo, profissional_id)
           VALUES ($1,$2,$3,$4,$5,'SERVICO',$6)`,
          [a3.id, vinculos[0].oferta_id, vinculos[0].servico, vinculos[0].preco, vinculos[0].duracao_minutos, vinculos[0].profissional_id]
        );
        const avulso = await bahiaDate(client, -1, '16:00');
        const avulsoFim = await bahiaDate(client, -1, '16:45');
        const { rows: [a4] } = await client.query(
          `INSERT INTO agendamento (cliente_id, vinculo_id, inicio, fim, status, valor_total, origem)
           VALUES ($1,$2,$3,$4,'CONCLUIDO',$5,'AVULSO') RETURNING id`,
          [cliente3.id, vinculos[0].id, avulso.ts, avulsoFim.ts, Number(vinculos[0].preco) + 10]
        );
        await client.query(
          `INSERT INTO item_agendamento (agendamento_id, oferta_id, nome, preco, duracao_minutos, tipo, profissional_id)
           VALUES ($1,$2,$3,$4,$5,'SERVICO',$6),
                  ($1,NULL,'Adicional gel',$7,0,'ADICIONAL',$6)`,
          [a4.id, vinculos[0].oferta_id, vinculos[0].servico, vinculos[0].preco, vinculos[0].duracao_minutos, vinculos[0].profissional_id, 10]
        );
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const counts = await pool.query(`
    SELECT 'usuario' AS t, count(*)::int AS n FROM usuario
    UNION ALL SELECT 'unidade', count(*) FROM unidade
    UNION ALL SELECT 'servico', count(*) FROM servico
    UNION ALL SELECT 'oferta_servico', count(*) FROM oferta_servico
    UNION ALL SELECT 'profissional', count(*) FROM profissional
    UNION ALL SELECT 'vinculo_profissional_unidade', count(*) FROM vinculo_profissional_unidade
    UNION ALL SELECT 'profissional_servico', count(*) FROM profissional_servico
    UNION ALL SELECT 'turno_trabalho', count(*) FROM turno_trabalho
    UNION ALL SELECT 'pausa_trabalho', count(*) FROM pausa_trabalho
    UNION ALL SELECT 'bloqueio_agenda', count(*) FROM bloqueio_agenda
    UNION ALL SELECT 'agendamento', count(*) FROM agendamento
    UNION ALL SELECT 'item_agendamento', count(*) FROM item_agendamento
    ORDER BY 1`);
  console.log('Seed BarberCom:');
  for (const row of counts.rows) console.log(`  ${row.t}: ${row.n}`);
  console.log('Gestor:', telefone, '/', senha);
  console.log('Clientes demo: 71988880001..005 / SenhaCliente@2026');
} finally {
  await pool.end();
}
