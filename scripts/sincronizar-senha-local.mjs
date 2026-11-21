import pg from 'pg';

const url = new URL(process.env.DATABASE_URL);
const senha = decodeURIComponent(url.password);

const client = new pg.Client({
  host: '127.0.0.1',
  port: 55438,
  user: 'barbercom_owner',
  password: process.env.LOCAL_OWNER_PASSWORD,
  database: 'postgres'
});

await client.connect();

try {
  await client.query(
    `ALTER ROLE barbercom_app WITH LOGIN PASSWORD ${pg.escapeLiteral(senha)}`
  );

  console.log('Senha do BarberCom sincronizada com sucesso!');
} finally {
  await client.end();
}
