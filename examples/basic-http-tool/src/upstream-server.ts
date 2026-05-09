import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.post('/tools/admin.searchUsers', async (request) => {
  const input = request.body as { readonly query?: string; readonly status?: string };
  return {
    users: [
      {
        id: 'usr_123',
        email: 'ada@example.com',
        status: input.status ?? 'active'
      }
    ],
    query: input.query ?? null
  };
});

app.post('/tools/admin.disableUser', async (request) => {
  const input = request.body as { readonly userId?: string };
  return {
    disabled: true,
    userId: input.userId ?? 'unknown'
  };
});

app.post('/tools/secrets.echo', async (request) => request.body);

app.post('/tools/slow', async () => {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  return { ok: true };
});

app.post('/tools/error', async (_request, reply) => {
  await reply.code(500).send({ error: 'fixture error' });
});

const port = Number(process.env.UPSTREAM_PORT ?? '4001');
await app.listen({ host: process.env.UPSTREAM_HOST ?? '127.0.0.1', port });
