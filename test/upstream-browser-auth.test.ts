import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  assertStandaloneUpstreamSupported,
  exchangeUpstreamBrowserCookie,
  supportsUpstreamBrowserAuthentication,
} from '../src/upstream-browser-auth.js';

async function listeningServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, origin: `http://127.0.0.1:${String(port)}` };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('Host browser authentication feature detection preserves older connection services', () => {
  assert.equal(supportsUpstreamBrowserAuthentication({}), false);
  assert.equal(supportsUpstreamBrowserAuthentication(null), false);
  assert.equal(supportsUpstreamBrowserAuthentication({ authenticatedUrl: 'not-a-function' }), false);
  assert.equal(supportsUpstreamBrowserAuthentication({ authenticatedUrl: () => 'http://127.0.0.1/' }), true);
});

test('Host launch URL exchange retries a transient response and retains only one Cookie pair', async () => {
  let requests = 0;
  const { server, origin } = await listeningServer((req, res) => {
    requests += 1;
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/?token=process-secret');
    if (requests === 1) {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(303, {
      location: '/',
      'set-cookie': 'dsh-auth-authority=signed-value; Max-Age=60; Path=/; HttpOnly',
    }).end();
  });
  try {
    const cookie = await exchangeUpstreamBrowserCookie(
      `${origin}/?token=process-secret`,
      origin,
      { attempts: 3, requestTimeoutMs: 200, retryDelayMs: 1 },
    );
    assert.equal(cookie, 'dsh-auth-authority=signed-value');
    assert.equal(requests, 2);
  } finally {
    await closeServer(server);
  }
});

test('Host launch URL exchange rejects untrusted URL forms before network access', async () => {
  let requests = 0;
  const { server, origin } = await listeningServer((_req, res) => {
    requests += 1;
    res.writeHead(500).end();
  });
  const port = new URL(origin).port;
  const secret = 'never-echo-this-token';
  const invalid = [
    `https://127.0.0.1:${port}/?token=${secret}`,
    `http://user@127.0.0.1:${port}/?token=${secret}`,
    `http://127.0.0.1:${port}/nested?token=${secret}`,
    `http://127.0.0.1:${port}/?token=${secret}&extra=1`,
    `http://127.0.0.1:${port}/?token=${secret}&token=second`,
    `http://127.0.0.1.nip.io:${port}/?token=${secret}`,
  ];
  try {
    for (const value of invalid) {
      await assert.rejects(
        exchangeUpstreamBrowserCookie(value, origin, { attempts: 1 }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message.includes(secret), false);
          return true;
        },
      );
    }
    await assert.rejects(
      exchangeUpstreamBrowserCookie(`${origin}/?token=${secret}`, 'http://127.0.0.1:1'),
      /URL is invalid/u,
    );
    assert.equal(requests, 0);
  } finally {
    await closeServer(server);
  }
});

test('Host launch URL exchange accepts every Host loopback spelling', async () => {
  for (const hostname of ['localhost', '[::1]', '127.42.0.9']) {
    const origin = `http://${hostname}:1`;
    await assert.rejects(
      exchangeUpstreamBrowserCookie(
        `${origin}/?token=process-secret`,
        origin,
        { attempts: 1, requestTimeoutMs: 1, retryDelayMs: 1 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes('URL is invalid'), false);
        return true;
      },
    );
  }
});

test('standalone startup refuses a running Host that requires browser authentication', async () => {
  let status = 401;
  const { server, origin } = await listeningServer((_req, res) => {
    res.writeHead(status).end();
  });
  try {
    await assert.rejects(
      assertStandaloneUpstreamSupported(origin, 200),
      /requires the dsh-managed gateway process/u,
    );
    status = 200;
    await assert.doesNotReject(assertStandaloneUpstreamSupported(origin, 200));
  } finally {
    await closeServer(server);
  }
});

test('standalone startup refuses to race an unreachable Host', async () => {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await closeServer(server);
  await assert.rejects(
    assertStandaloneUpstreamSupported(`http://127.0.0.1:${String(port)}`, 50),
    /requires a reachable Host/u,
  );
});

test('Host launch URL exchange rejects deterministic response failures without leaking secrets', async () => {
  const responses: Array<{ status: number; location?: string; cookies?: string[] }> = [
    { status: 401 },
    { status: 303, location: '/wrong', cookies: ['dsh-auth-a=secret-cookie'] },
    { status: 303, location: '/' },
    { status: 303, location: '/', cookies: ['dsh-auth-a=one', 'dsh-auth-b=two'] },
  ];
  let selected = 0;
  const { server, origin } = await listeningServer((_req, res) => {
    const response = responses[selected];
    res.writeHead(response.status, {
      ...(response.location === undefined ? {} : { location: response.location }),
      ...(response.cookies === undefined ? {} : { 'set-cookie': response.cookies }),
    }).end();
  });
  try {
    for (selected = 0; selected < responses.length; selected += 1) {
      await assert.rejects(
        exchangeUpstreamBrowserCookie(
          `${origin}/?token=process-secret`,
          origin,
          { attempts: 1, requestTimeoutMs: 200, retryDelayMs: 1 },
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message.includes('process-secret'), false);
          assert.equal(error.message.includes('secret-cookie'), false);
          return true;
        },
      );
    }
  } finally {
    await closeServer(server);
  }
});
