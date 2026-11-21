# BarberCom Backend

API do BarberCom: agendamento de barbearias com perfis de **cliente** e **gestor**.

Stack: **Node.js 24**, **Express 5**, **PostgreSQL 18**.

O frontend fica em um repositório separado: [BarberComFront](https://github.com/batiistta/BarberComFront).

## Funcionalidades

- Login por telefone/senha (cliente e gestor), sessão com cookie e CSRF
- Cadastro de cliente (sem SMS)
- Google OAuth (opcional)
- Unidades, profissionais, serviços (preço/duração por unidade)
- Turnos, pausas e bloqueios de agenda
- Agendamento do cliente com disponibilidade real, resumo, cancelamento e histórico
- Gestão: histórico, atendimento avulso, fotos de profissionais
- Seed de demonstração no primeiro start (Docker)

## Subir com Docker (API + PostgreSQL)

```powershell
copy .env.example .env
docker compose up --build
```

- API: http://localhost:3000/api
- Postgres: `localhost:5432`

### Stack completa (API + front)

Clone o front ao lado deste repositório:

```text
pasta/
  BarberComBackend/
  BarberComFront/
```

Depois, dentro de `BarberComBackend`:

```powershell
docker compose -f docker-compose.yml -f docker-compose.front.yml up --build
```

- Front: http://localhost:5173
- API: http://localhost:3000

## Variáveis de ambiente

Copie `.env.example` para `.env`. Principais:

| Variável | Descrição |
| --- | --- |
| `DATABASE_URL` | Conexão PostgreSQL |
| `SESSION_SECRET` | Segredo da sessão (≥ 32 caracteres) |
| `ADMIN_PHONE` / `ADMIN_PASSWORD` | Gestor criado no seed |
| `FRONTEND_ORIGIN` | Origem do front (ex.: `http://localhost:5173`) |
| `DEMO_GESTOR` | `true` libera atalho de demo do gestor |
| `GOOGLE_*` | OAuth opcional |

**Não versione o arquivo `.env`.**

## Acessos de demonstração (seed Docker)

| Perfil | Telefone | Senha |
| --- | --- | --- |
| Gestor | `71999990000` | `SenhaGestor@2026` |
| Cliente | `71988880001` … `005` | `SenhaCliente@2026` |
| Demo gestor | `1` | `x` | (somente com `DEMO_GESTOR=true`) |

## Desenvolvimento local (sem Docker da API)

1. PostgreSQL disponível
2. Configure `.env`
3. Aplique os SQLs em `database/` (`001` … `006`)
4. Rode:

```powershell
npm ci
node --env-file=.env scripts/preparar-aplicacao.js
npm start
```

## Testes

```powershell
npm test
```

Os testes usam schemas temporários no PostgreSQL configurado em `DATABASE_URL`.

## Estrutura

```text
src/           regras e rotas da API
database/      migrações SQL e dados de demo
scripts/       entrypoint Docker e preparo/seed
test/          testes automatizados
Dockerfile     imagem da API
```

## Contrato da API

Rotas principais sob `/api` (JSON, cookies + `X-CSRF-Token` em POST).  
Fotos públicas em `/fotos/profissionais/:id`.  
Callback Google em `/auth/google/callback`.
