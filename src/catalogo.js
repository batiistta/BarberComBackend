import { Router } from 'express';

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function selectedIds(value) {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (values.some(id => typeof id !== 'string' || !/^[1-9]\d{0,17}$/.test(id))) return null;
  return [...new Set(values)];
}

async function transaction(db, operation) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export function createCatalogRouter(db) {
  const router = Router();
  const find = async (table, id, res) => {
    if (!/^[1-9]\d{0,17}$/.test(id)) {
      res.status(404).render('erro', { mensagem: 'Cadastro não encontrado.' });
      return null;
    }
    // Os nomes de tabela vêm somente das rotas abaixo, nunca do formulário.
    const { rows: [record] } = await db.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    if (!record) res.status(404).render('erro', { mensagem: 'Cadastro não encontrado.' });
    return record;
  };

  const renderServices = async (res, form = null, erro = '', status = 200) => {
    const { rows: servicos } = await db.query('SELECT * FROM servico ORDER BY id');
    const { rows: unidades } = await db.query('SELECT * FROM unidade ORDER BY id');
    const { rows: ofertas } = await db.query('SELECT o.*, u.nome AS unidade_nome, u.ativa AS unidade_ativa FROM oferta_servico o JOIN unidade u ON u.id = o.unidade_id WHERE o.ativa ORDER BY o.id');
    res.status(status).render('servicos', { servicos, unidades, ofertas, form, erro });
  };
  router.get('/servicos', (req, res) => renderServices(res));
  router.get('/servicos/novo', (req, res) => renderServices(res, { nome: '', ativo: true, unidades: [], precos: {}, duracoes: {} }));
  router.get('/servicos/:id/editar', async (req, res) => {
    const service = await find('servico', req.params.id, res);
    if (!service) return;
    const { rows } = await db.query('SELECT * FROM oferta_servico WHERE servico_id = $1 AND ativa', [service.id]);
    await renderServices(res, {
      ...service, unidades: rows.map(row => row.unidade_id),
      precos: Object.fromEntries(rows.map(row => [row.unidade_id, row.preco])),
      duracoes: Object.fromEntries(rows.map(row => [row.unidade_id, row.duracao_minutos]))
    });
  });
  const saveService = async (req, res) => {
    if (req.params.id && !await find('servico', req.params.id, res)) return;
    const units = selectedIds(req.body.unidades);
    const form = {
      id: req.params.id, nome: typeof req.body.nome === 'string' ? req.body.nome.trim() : '',
      ativo: req.body.ativo === 'true', unidades: units ?? [],
      precos: {}, duracoes: {}
    };
    for (const id of form.unidades) {
      form.precos[id] = typeof req.body[`preco_${id}`] === 'string' ? req.body[`preco_${id}`].trim() : '';
      form.duracoes[id] = typeof req.body[`duracao_${id}`] === 'string' ? req.body[`duracao_${id}`] : '';
    }
    try {
      if (!form.nome || form.nome.length > 120 || !['true', 'false'].includes(req.body.ativo)) invalid('Informe nome e situação válidos.');
      if (!units?.length) invalid('Escolha pelo menos uma unidade.');
      for (const id of units) {
        if (!/^\d{1,8}([.,]\d{1,2})?$/.test(form.precos[id])) invalid('Informe um preço válido para cada unidade selecionada.');
        if (!/^[1-9]\d{0,3}$/.test(form.duracoes[id]) || Number(form.duracoes[id]) > 1440) invalid('A duração deve ser de 1 a 1440 minutos em cada unidade.');
      }
      await transaction(db, async client => {
        const { rows: allowed } = await client.query('SELECT id, ativa FROM unidade WHERE id = ANY($1::bigint[]) ORDER BY id FOR SHARE', [units]);
        const { rows: previous } = await client.query('SELECT unidade_id FROM oferta_servico WHERE servico_id = $1 AND ativa', [form.id ?? null]);
        if (allowed.length !== units.length || allowed.some(u => !u.ativa && !previous.some(p => p.unidade_id === u.id))) invalid('Escolha unidades ativas; vínculos existentes com unidades inativas podem ser mantidos.');
        let id = form.id;
        if (id) await client.query('UPDATE servico SET nome = $1, ativo = $2 WHERE id = $3', [form.nome, form.ativo, id]);
        else id = (await client.query('INSERT INTO servico (nome, ativo) VALUES ($1, $2) RETURNING id', [form.nome, form.ativo])).rows[0].id;
        await client.query('UPDATE oferta_servico SET ativa = false WHERE servico_id = $1', [id]);
        for (const unitId of units) {
          await client.query(`INSERT INTO oferta_servico (unidade_id, servico_id, preco, duracao_minutos)
            VALUES ($1, $2, $3, $4) ON CONFLICT (unidade_id, servico_id)
            DO UPDATE SET preco = EXCLUDED.preco, duracao_minutos = EXCLUDED.duracao_minutos, ativa = true`,
          [unitId, id, form.precos[unitId].replace(',', '.'), form.duracoes[unitId]]);
        }
      });
      req.session.aviso = form.id ? 'Serviço atualizado.' : 'Serviço cadastrado.';
      res.redirect(303, '/servicos');
    } catch (error) {
      if (error.status !== 400) throw error;
      await renderServices(res, form, error.message, 400);
    }
  };
  router.post('/servicos', saveService);
  router.post('/servicos/:id', saveService);

  const renderProfessionals = async (res, form = null, erro = '', status = 200) => {
    const { rows: profissionais } = await db.query(`SELECT p.*,
      ARRAY(SELECT u.nome FROM vinculo_profissional_unidade v JOIN unidade u ON u.id = v.unidade_id WHERE v.profissional_id = p.id AND v.ativo ORDER BY u.id) AS unidades,
      ARRAY(SELECT s.nome FROM profissional_servico ps JOIN servico s ON s.id = ps.servico_id WHERE ps.profissional_id = p.id ORDER BY s.id) AS servicos
      FROM profissional p ORDER BY p.id`);
    const { rows: unidades } = await db.query('SELECT * FROM unidade ORDER BY id');
    const { rows: servicos } = await db.query('SELECT * FROM servico ORDER BY id');
    res.status(status).render('profissionais', { profissionais, unidades, servicos, form, erro });
  };
  router.get('/profissionais', (req, res) => renderProfessionals(res));
  router.get('/profissionais/:id/impacto', async (req, res) => {
    if (!await find('profissional', req.params.id, res)) return;
    const { rows: [summary] } = await db.query(`SELECT count(DISTINCT a.id)::int AS quantidade
      FROM agendamento a JOIN vinculo_profissional_unidade v ON v.id = a.vinculo_id
      WHERE a.status = 'CONFIRMADO' AND a.inicio > (now() AT TIME ZONE 'America/Bahia')
        AND (v.profissional_id = $1 OR EXISTS (
          SELECT 1 FROM item_agendamento i WHERE i.agendamento_id = a.id AND i.profissional_id = $1
        ))`, [req.params.id]);
    const { rows: proximos } = await db.query(`SELECT a.id::text AS id,
        to_char(a.inicio, 'YYYY-MM-DD"T"HH24:MI:SS') AS inicio,
        c.nome AS cliente, u.nome AS unidade, p.nome AS profissional
      FROM agendamento a
      JOIN vinculo_profissional_unidade v ON v.id = a.vinculo_id
      JOIN unidade u ON u.id = v.unidade_id
      JOIN profissional p ON p.id = v.profissional_id
      JOIN usuario c ON c.id = a.cliente_id
      WHERE a.status = 'CONFIRMADO' AND a.inicio > (now() AT TIME ZONE 'America/Bahia')
        AND (v.profissional_id = $1 OR EXISTS (
          SELECT 1 FROM item_agendamento i WHERE i.agendamento_id = a.id AND i.profissional_id = $1
        ))
      ORDER BY a.inicio LIMIT 5`, [req.params.id]);
    res.json({ quantidade: summary.quantidade, proximos, cancelamentoAutomaticoNotifica: false });
  });
  router.get('/profissionais/novo', (req, res) => renderProfessionals(res, { nome: '', foto_url: '', ativo: true, unidades: [], servicos: [] }));
  router.get('/profissionais/:id/editar', async (req, res) => {
    const professional = await find('profissional', req.params.id, res);
    if (!professional) return;
    const { rows: units } = await db.query('SELECT unidade_id FROM vinculo_profissional_unidade WHERE profissional_id = $1 AND ativo', [professional.id]);
    const { rows: services } = await db.query('SELECT servico_id FROM profissional_servico WHERE profissional_id = $1', [professional.id]);
    await renderProfessionals(res, { ...professional, unidades: units.map(u => u.unidade_id), servicos: services.map(s => s.servico_id) });
  });
  const saveProfessional = async (req, res) => {
    if (req.params.id && !await find('profissional', req.params.id, res)) return;
    const units = selectedIds(req.body.unidades);
    const services = selectedIds(req.body.servicos);
    const form = {
      id: req.params.id, nome: typeof req.body.nome === 'string' ? req.body.nome.trim() : '',
      foto_url: typeof req.body.foto_url === 'string' ? req.body.foto_url.trim() : '',
      ativo: req.body.ativo === 'true', unidades: units ?? [], servicos: services ?? []
    };
    try {
      if (!form.nome || form.nome.length > 120 || !['true', 'false'].includes(req.body.ativo)) invalid('Informe nome e situação válidos.');
      if (!units?.length || !services?.length) invalid('Escolha pelo menos uma unidade e um serviço.');
      if (req.body.foto_url !== undefined && typeof req.body.foto_url !== 'string') invalid('Informe somente um endereço para a foto.');
      if (form.foto_url && form.foto_url !== `/fotos/profissionais/${form.id}`) {
        let url;
        try { url = new URL(form.foto_url); } catch { invalid('Informe uma URL HTTPS válida para a foto ou deixe em branco.'); }
        if (url.protocol !== 'https:' || url.username || url.password || form.foto_url.length > 500) invalid('A foto deve ser uma URL HTTPS, sem credenciais, com até 500 caracteres.');
      }
      const savedId = await transaction(db, async client => {
        if (form.id) await client.query('SELECT id FROM profissional WHERE id = $1 FOR UPDATE', [form.id]);
        const { rows: allowedUnits } = await client.query('SELECT id, ativa FROM unidade WHERE id = ANY($1::bigint[]) ORDER BY id FOR SHARE', [units]);
        const { rows: previousUnits } = await client.query('SELECT unidade_id FROM vinculo_profissional_unidade WHERE profissional_id = $1 AND ativo', [form.id ?? null]);
        const { rows: allowedServices } = await client.query('SELECT id, ativo FROM servico WHERE id = ANY($1::bigint[]) ORDER BY id FOR SHARE', [services]);
        const { rows: previousServices } = await client.query('SELECT servico_id FROM profissional_servico WHERE profissional_id = $1', [form.id ?? null]);
        if (allowedUnits.length !== units.length || allowedUnits.some(u => !u.ativa && !previousUnits.some(p => p.unidade_id === u.id))) invalid('Escolha unidades ativas; vínculos anteriores podem ser mantidos.');
        if (allowedServices.length !== services.length || allowedServices.some(s => !s.ativo && !previousServices.some(p => p.servico_id === s.id))) invalid('Escolha serviços ativos; vínculos anteriores podem ser mantidos.');
        let id = form.id;
        if (id) await client.query('UPDATE profissional SET nome = $1, foto_url = $2, ativo = $3 WHERE id = $4', [form.nome, form.foto_url || null, form.ativo, id]);
        else id = (await client.query('INSERT INTO profissional (nome, foto_url, ativo) VALUES ($1, $2, $3) RETURNING id', [form.nome, form.foto_url || null, form.ativo])).rows[0].id;
        await client.query('UPDATE vinculo_profissional_unidade SET ativo = false WHERE profissional_id = $1', [id]);
        for (const unitId of units) {
          await client.query('INSERT INTO vinculo_profissional_unidade (profissional_id, unidade_id) VALUES ($1, $2) ON CONFLICT (profissional_id, unidade_id) DO UPDATE SET ativo = true', [id, unitId]);
        }
        await client.query('DELETE FROM profissional_servico WHERE profissional_id = $1', [id]);
        for (const serviceId of services) await client.query('INSERT INTO profissional_servico (profissional_id, servico_id) VALUES ($1, $2)', [id, serviceId]);
        return id;
      });
      const mensagem = form.id ? 'Profissional atualizado.' : 'Profissional cadastrado.';
      if (req.isApi) return res.status(form.id ? 200 : 201).json({ mensagem, profissional: { id: String(savedId) }, csrf: req.session?.csrf });
      req.session.aviso = mensagem;
      res.redirect(303, '/profissionais');
    } catch (error) {
      if (error.code === '23P01') return renderProfessionals(res, form, 'Os vínculos selecionados reativariam turnos conflitantes. Ajuste os turnos antes de salvar.', 409);
      if (error.status !== 400) throw error;
      await renderProfessionals(res, form, error.message, 400);
    }
  };
  router.post('/profissionais', saveProfessional);
  router.post('/profissionais/:id', saveProfessional);

  for (const [path, table] of [['servicos', 'servico'], ['profissionais', 'profissional']]) {
    router.post(`/${path}/:id/situacao`, async (req, res) => {
      if (!await find(table, req.params.id, res)) return;
      if (!['true', 'false'].includes(req.body.ativo)) return res.status(400).render('erro', { mensagem: 'Situação inválida.' });
      const ativar = req.body.ativo === 'true';
      let cancelados = 0;
      if (table === 'profissional' && !ativar) {
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          const { rowCount } = await client.query('SELECT id FROM profissional WHERE id = $1 FOR UPDATE', [req.params.id]);
          if (!rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ erro: 'Profissional não encontrado.' });
          }
          const { rows: [summary] } = await client.query(`SELECT count(DISTINCT a.id)::int AS quantidade
            FROM agendamento a JOIN vinculo_profissional_unidade v ON v.id = a.vinculo_id
            WHERE a.status = 'CONFIRMADO' AND a.inicio > (now() AT TIME ZONE 'America/Bahia')
              AND (v.profissional_id = $1 OR EXISTS (
                SELECT 1 FROM item_agendamento i WHERE i.agendamento_id = a.id AND i.profissional_id = $1
              ))`, [req.params.id]);
          cancelados = summary.quantidade;
          if (cancelados > 0 && req.body.cancelarAgendamentos !== true && req.body.cancelarAgendamentos !== 'true') {
            await client.query('COMMIT');
            return res.status(409).json({ erro: `Este profissional possui ${cancelados} agendamento(s) futuro(s) confirmado(s). Resolva essas reservas antes de desativá-lo.`, quantidade: cancelados });
          }
          if (cancelados > 0) {
            await client.query(`UPDATE agendamento a SET status = 'CANCELADO'
              WHERE a.status = 'CONFIRMADO' AND a.inicio > (now() AT TIME ZONE 'America/Bahia')
                AND (EXISTS (SELECT 1 FROM vinculo_profissional_unidade v WHERE v.id = a.vinculo_id AND v.profissional_id = $1)
                  OR EXISTS (SELECT 1 FROM item_agendamento i WHERE i.agendamento_id = a.id AND i.profissional_id = $1))`, [req.params.id]);
          }
          await client.query('UPDATE profissional SET ativo = false WHERE id = $1', [req.params.id]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { client.release(); }
      } else {
        await db.query(`UPDATE ${table} SET ativo = $1 WHERE id = $2`, [ativar, req.params.id]);
      }
      const mensagem = !ativar && cancelados > 0
        ? `Profissional desativado. ${cancelados} agendamento(s) futuro(s) foram cancelados.`
        : ativar ? 'Registro reativado.' : 'Registro desativado.';
      if (req.accepts(['html', 'json']) === 'json') return res.json({ ativo: ativar, mensagem, cancelados });
      req.session.aviso = mensagem;
      res.redirect(303, `/${path}`);
    });
  }
  return router;
}
