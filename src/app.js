import { coordenadas } from './localizacao.js';
import { createPhotoRouter, sendPhoto } from './fotos.js';
import express from 'express';
import session from 'express-session';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword } from './password.js';
import { createCatalogRouter } from './catalogo.js';
import { createScheduleRouter } from './horarios.js';
import { apiAdapter } from './api.js';
import { PostgresSessionStore } from './session-store.js';
import { createGoogleRouter } from './google.js';
import { createCustomerRouter } from './cliente.js';
import { createHistoryRouter } from './historico.js';

export function createApp(db, secret, { allowAnyPassword = false, demoGestor = false, google = null, frontendOrigin = null } = {}) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET precisa de pelo menos 32 caracteres.');
  if (process.env.NODE_ENV === 'production') throw new Error('Esta versao e local. Configure HTTPS e sessoes persistentes antes de publicar.');
  const app = express();
  if (frontendOrigin && new URL(frontendOrigin).origin !== frontendOrigin) throw new Error('FRONTEND_ORIGIN deve conter apenas origem, sem caminho ou barra final.');
  app.locals.allowAnyPassword = allowAnyPassword;
  app.locals.demoGestor = demoGestor;
  app.locals.googleEnabled = Boolean(google);
  app.locals.frontendOrigin = frontendOrigin;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': `default-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-store'
    });
    next();
  });
  app.use((req, res, next) => {
    if (frontendOrigin && req.get('Origin') === frontendOrigin) {
      res.vary('Origin');
      res.set({ 'Access-Control-Allow-Origin': frontendOrigin, 'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));
  app.use(express.json({ limit: '3mb' }));
  app.use(session({
    store: new PostgresSessionStore(db),
    secret, name: 'barbercom.sid', resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 2 * 60 * 60 * 1000 }
  }));
  app.use(apiAdapter);
  app.use((req, res, next) => {
    req.session.csrf ??= randomBytes(32).toString('hex');
    res.locals.csrf = req.session.csrf;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const token = req.get('X-CSRF-Token') ?? req.body?._csrf;
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrf))) {
        return res.status(403).json({ erro: 'Formulário expirado. Volte e recarregue a página.', csrf: req.session.csrf });
      }
    }
    next();
  });
  app.get('/fotos/profissionais/:id', (req, res) => sendPhoto(db, req, res));
  app.use(createGoogleRouter(db, google, frontendOrigin));
  app.use(createCustomerRouter(db));
  app.get('/sessao', async (req, res) => {
    const { rows: [usuario] } = await db.query('SELECT id, nome, perfil FROM usuario WHERE id = $1 AND ativo', [req.session.userId ?? null]);
    res.json({ usuario: usuario ?? null, csrf: req.session.csrf });
  });

  const dummyHash = hashPassword(randomBytes(32).toString('hex'));
  const loginLimit = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 15, skipSuccessfulRequests: true,
    standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.', csrf: req.session?.csrf })
  });
  app.get('/', (req, res) => res.json({ ok: true, api: '/api', mensagem: 'BarberCom API. Use o frontend separado.' }));
  app.get('/login', (req, res) => {
    if (req.session.userId) return res.json({ csrf: req.session.csrf, googleDisponivel: app.locals.googleEnabled, modoTeste: allowAnyPassword, demoGestor });
    res.json({ csrf: req.session.csrf, googleDisponivel: app.locals.googleEnabled, modoTeste: allowAnyPassword, demoGestor });
  });
  app.post('/login', loginLimit, async (req, res) => {
    const telefone = typeof req.body.telefone === 'string' ? req.body.telefone.replace(/\D/g, '') : '';
    const senha = req.body.senha;
    const demonstration = demoGestor && req.body.acesso === 'gestor-demo';
    const acessoSolicitado = req.body.acesso;
    if (acessoSolicitado !== undefined && !['cliente', 'gestor', 'gestor-demo'].includes(acessoSolicitado)) {
      return res.status(400).json({ erro: 'Tipo de acesso inválido.', csrf: req.session.csrf });
    }
    if (!(demonstration ? /^\d{1,25}$/ : /^\d{10,15}$/).test(telefone) || typeof senha !== 'string' || senha.length < 1 || senha.length > 256) {
      return res.status(400).json({ erro: 'Informe um telefone válido e a senha.', csrf: req.session.csrf });
    }
    const { rows: [user] } = demonstration
      ? await db.query("SELECT id, ativo, perfil FROM usuario WHERE perfil='GESTOR' AND ativo ORDER BY id LIMIT 1")
      : await db.query('SELECT id, senha_hash, ativo, perfil FROM usuario WHERE telefone = $1', [telefone]);
    const valid = demonstration || allowAnyPassword || await verifyPassword(senha, user?.senha_hash ?? await dummyHash);
    if (!valid || !user?.ativo) {
      return res.status(401).json({ erro: 'Telefone ou senha incorretos.', csrf: req.session.csrf });
    }
    if (acessoSolicitado === 'gestor' && user.perfil !== 'GESTOR') {
      return res.status(403).json({ erro: 'Esta conta não possui acesso de administrador.', csrf: req.session.csrf });
    }
    if (acessoSolicitado === 'cliente' && user.perfil !== 'CLIENTE') {
      return res.status(403).json({ erro: 'Esta conta deve usar o acesso de administrador.', csrf: req.session.csrf });
    }
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.userId = user.id;
    req.session.csrf = randomBytes(32).toString('hex');
    await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    if (req.isApi) {
      return res.json({
        mensagem: 'Login realizado.',
        csrf: req.session.csrf,
        proximaRota: user.perfil === 'GESTOR' ? '/unidades' : '/cliente/agendamentos'
      });
    }
    res.redirect(303, user.perfil === 'GESTOR' ? '/unidades' : '/cliente/agendamentos');
  });

  const requireGestor = async (req, res, next) => {
    if (!req.session.userId) return res.redirect(303, '/login');
    const { rows: [user] } = await db.query('SELECT nome, perfil FROM usuario WHERE id = $1 AND ativo', [req.session.userId]);
    if (!user) {
      await new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
      res.clearCookie('barbercom.sid');
      return res.redirect(303, '/login');
    }
    if (user.perfil !== 'GESTOR') return res.status(403).json({ erro: 'Esta operação é exclusiva do gestor.', csrf: req.session.csrf });
    res.locals.usuario = user.nome;
    res.locals.aviso = req.session.aviso ?? '';
    delete req.session.aviso;
    next();
  };
  app.post('/sair', async (req, res) => {
    await new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
    res.clearCookie('barbercom.sid');
    if (req.isApi) return res.json({ mensagem: 'Sessão encerrada.' });
    res.redirect(303, '/login');
  });
  app.use('/unidades', requireGestor);
  app.use(['/profissionais', '/servicos'], requireGestor);
  app.use('/profissionais', createPhotoRouter(db));
  app.use(createCatalogRouter(db));
  app.use('/horarios', requireGestor, createScheduleRouter(db));
  app.use('/gestao', requireGestor, createHistoryRouter(db));

  const renderUnits = async (req, res, { form = null, erro = '', status = 200 } = {}) => {
    const { rows: unidades } = await db.query('SELECT id, nome, endereco, ativa, latitude, longitude FROM unidade ORDER BY id');
    res.status(status).json({ unidades, form, erro, aviso: res.locals.aviso, csrf: req.session.csrf });
  };
  const findUnit = async (id, res) => {
    if (!/^[1-9]\d{0,17}$/.test(id)) {
      res.status(404).json({ erro: 'Unidade não encontrada.' });
      return null;
    }
    const { rows: [unit] } = await db.query('SELECT id, nome, endereco, ativa, latitude, longitude FROM unidade WHERE id = $1', [id]);
    if (!unit) res.status(404).json({ erro: 'Unidade não encontrada.' });
    return unit;
  };
  app.get('/unidades/:id/impacto', async (req, res) => {
    if (!await findUnit(req.params.id, res)) return;
    const params = [req.params.id];
    const { rows: [summary] } = await db.query(`SELECT count(*)::int AS quantidade
      FROM agendamento a
      JOIN vinculo_profissional_unidade v ON v.id = a.vinculo_id
      WHERE v.unidade_id = $1 AND a.status = 'CONFIRMADO'
        AND a.inicio > (now() AT TIME ZONE 'America/Bahia')`, params);
    const { rows: proximos } = await db.query(`SELECT a.id::text AS id,
        to_char(a.inicio, 'YYYY-MM-DD"T"HH24:MI:SS') AS inicio,
        c.nome AS cliente, p.nome AS profissional
      FROM agendamento a
      JOIN vinculo_profissional_unidade v ON v.id = a.vinculo_id
      JOIN usuario c ON c.id = a.cliente_id
      JOIN profissional p ON p.id = v.profissional_id
      WHERE v.unidade_id = $1 AND a.status = 'CONFIRMADO'
        AND a.inicio > (now() AT TIME ZONE 'America/Bahia')
      ORDER BY a.inicio LIMIT 5`, params);
    res.json({ quantidade: summary.quantidade, proximos, cancelamentoAutomaticoNotifica: false });
  });
  app.get('/unidades', (req, res) => renderUnits(req, res));
  app.get('/unidades/nova', (req, res) => renderUnits(req, res, { form: { nome: '', endereco: '', ativa: true } }));
  app.get('/unidades/:id/editar', async (req, res) => {
    const unit = await findUnit(req.params.id, res);
    if (unit) await renderUnits(req, res, { form: unit });
  });

  const saveUnit = async (req, res) => {
    const previous = req.params.id ? await findUnit(req.params.id, res) : null;
    if (req.params.id && !previous) return;
    const form = {
      id: req.params.id,
      nome: typeof req.body.nome === 'string' ? req.body.nome.trim() : '',
      endereco: typeof req.body.endereco === 'string' ? req.body.endereco.trim() : '',
      ativa: req.body.ativa === 'true'
    };
    if (!form.nome || form.nome.length > 120 || !form.endereco || form.endereco.length > 255 || !['true', 'false'].includes(req.body.ativa)) {
      return renderUnits(req, res, { form, status: 400, erro: 'Informe nome (até 120 caracteres), endereço (até 255) e situação válida.' });
    }
    let coords;
    try {
      coords = req.body.latitude === undefined && req.body.longitude === undefined && previous?.endereco === form.endereco
        ? previous : coordenadas(req.body.latitude, req.body.longitude);
    } catch (error) { return renderUnits(req, res, { form: { ...form, latitude: req.body.latitude, longitude: req.body.longitude }, status: 400, erro: error.message }); }
    if (form.id) {
      await db.query('UPDATE unidade SET nome=$1,endereco=$2,ativa=$3,latitude=$4,longitude=$5 WHERE id=$6', [form.nome, form.endereco, form.ativa, coords?.latitude ?? null, coords?.longitude ?? null, form.id]);
    } else {
      await db.query('INSERT INTO unidade (nome,endereco,ativa,latitude,longitude) VALUES ($1,$2,$3,$4,$5)', [form.nome, form.endereco, form.ativa, coords?.latitude ?? null, coords?.longitude ?? null]);
    }
    req.session.aviso = form.id ? 'Unidade atualizada.' : 'Unidade cadastrada.';
    if (req.isApi) return res.json({ mensagem: req.session.aviso, csrf: req.session.csrf, proximaRota: '/unidades' });
    res.redirect(303, '/unidades');
  };
  app.post('/unidades', saveUnit);
  app.post('/unidades/:id', saveUnit);
  app.post('/unidades/:id/situacao', async (req, res) => {
    if (!['true', 'false'].includes(req.body.ativa)) return res.status(400).json({ erro: 'Situação inválida.' });
    if (req.body.ativa === 'true') {
      if (!await findUnit(req.params.id, res)) return;
      await db.query('UPDATE unidade SET ativa = true WHERE id = $1', [req.params.id]);
      const mensagem = 'Unidade reativada.';
      return res.json({ ativo: true, mensagem, csrf: req.session.csrf });
    }

    const client = await db.connect();
    let impact;
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query('SELECT id FROM unidade WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ erro: 'Unidade não encontrada.' });
      }
      const { rows: [summary] } = await client.query(`SELECT count(*)::int AS quantidade
        FROM agendamento a JOIN vinculo_profissional_unidade v ON v.id = a.vinculo_id
        WHERE v.unidade_id = $1 AND a.status = 'CONFIRMADO'
          AND a.inicio > (now() AT TIME ZONE 'America/Bahia')`, [req.params.id]);
      impact = summary.quantidade;
      if (impact > 0 && req.body.cancelarAgendamentos !== true && req.body.cancelarAgendamentos !== 'true') {
        await client.query('COMMIT');
        return res.status(409).json({ erro: `Esta unidade possui ${impact} agendamento(s) futuro(s) confirmado(s). Resolva essas reservas antes de desativá-la.`, quantidade: impact });
      }
      if (impact > 0) {
        await client.query(`UPDATE agendamento a SET status = 'CANCELADO'
          WHERE a.status = 'CONFIRMADO' AND a.inicio > (now() AT TIME ZONE 'America/Bahia')
            AND EXISTS (SELECT 1 FROM vinculo_profissional_unidade v WHERE v.id = a.vinculo_id AND v.unidade_id = $1)`, [req.params.id]);
      }
      await client.query('UPDATE unidade SET ativa = false WHERE id = $1', [req.params.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }

    const mensagem = impact > 0
      ? `Unidade desativada. ${impact} agendamento(s) futuro(s) foram cancelados.`
      : 'Unidade desativada.';
    return res.json({ ativo: false, mensagem, cancelados: impact, csrf: req.session.csrf });
  });
  app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));
  app.use((error, req, res, next) => {
    console.error('Falha na requisicao:', error.code ?? error.name);
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error.status) && ((error.status >= 400 && error.status < 500) || error.status === 503) ? error.status : 500;
    return res.status(status).json({ erro: status === 500 ? 'Não foi possível concluir. Tente novamente.' : error.message });
  });
  return app;
}
