// Automated tests for the "scary" parts: tenant isolation, RBAC, conflicts, realtime scoping.
// Run with:  npm test
// Each run uses a fresh in-memory database with the demo data.
process.env.DB_FILE = ':memory:';
process.env.SEED_DEMO_DATA = 'true';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { startServer } = require('../server');

let srv;
let baseUrl;
const tokens = {};
const ids = {}; // tenant ids looked up by name

// ---- helpers ----
async function call(who, method, path, body) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tokens[who] ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function login(who, email) {
  const res = await call(null, 'POST', '/auth/login', { email, password: 'password123' });
  assert.equal(res.status, 200, `login failed for ${email}`);
  tokens[who] = res.body.token;
}

function connectSocket(who) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { auth: { token: tokens[who] }, transports: ['websocket'], forceNew: true });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

const join = (socket, tenantId) => new Promise((resolve) => socket.emit('tenant:join', { tenantId }, resolve));
const waitFor = (socket, event, ms = 1500) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), ms); // null = "didn't arrive"
  socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
});

before(async () => {
  srv = await startServer(0);
  baseUrl = `http://localhost:${srv.port}`;
  await login('alice', 'alice@acme.test');
  await login('bob', 'bob@acme.test');
  await login('carol', 'carol@acme.test');
  await login('dan', 'dan@acme.test');
  await login('omar', 'omar@globex.test');

  const me = await call('alice', 'GET', '/auth/me');
  for (const t of me.body.orgs[0].tenants) ids[t.name] = t.id;
  const gina = await call(null, 'POST', '/auth/login', { email: 'gina@globex.test', password: 'password123' });
  tokens.gina = gina.body.token;
  const ginaMe = await call('gina', 'GET', '/auth/me');
  for (const t of ginaMe.body.orgs[0].tenants) ids[t.name] = t.id;
});

after(() => {
  srv.io.close(); // also closes the http server
});

// small helper: first board + its data in a tenant
async function firstBoard(who, tenantId) {
  const boards = await call(who, 'GET', `/tenants/${tenantId}/boards`);
  const board = await call(who, 'GET', `/tenants/${tenantId}/boards/${boards.body.boards[0].id}`);
  return board.body;
}

describe('access tree (org selector + branch switcher)', () => {
  test('org admin sees every branch of their org only', async () => {
    const me = await call('alice', 'GET', '/auth/me');
    assert.equal(me.body.orgs.length, 1);
    assert.deepEqual(me.body.orgs[0].tenants.map((t) => t.name).sort(), ['Bangalore Branch', 'Hyderabad Branch']);
  });

  test('member sees only branches they belong to', async () => {
    const me = await call('dan', 'GET', '/auth/me');
    assert.deepEqual(me.body.orgs[0].tenants.map((t) => t.name), ['Bangalore Branch']);
  });
});

describe('isolation', () => {
  test('cross-organization: Globex member cannot read Acme branch', async () => {
    const res = await call('omar', 'GET', `/tenants/${ids['Hyderabad Branch']}/boards`);
    assert.equal(res.status, 404); // 404, not 403 -> no info leak
  });

  test('cross-tenant: Bangalore member cannot read Hyderabad branch', async () => {
    const res = await call('dan', 'GET', `/tenants/${ids['Hyderabad Branch']}/boards`);
    assert.equal(res.status, 404);
  });

  test('IDOR: using my own tenant id with another tenant\'s board id fails', async () => {
    const hydData = await firstBoard('bob', ids['Hyderabad Branch']);
    const res = await call('dan', 'GET', `/tenants/${ids['Bangalore Branch']}/boards/${hydData.board.id}`);
    assert.equal(res.status, 404);
  });

  test('cannot move a task into a column of another tenant', async () => {
    const hydData = await firstBoard('carol', ids['Hyderabad Branch']);
    const blrData = await firstBoard('carol', ids['Bangalore Branch']);
    const task = blrData.tasks[0];
    const res = await call('carol', 'POST', `/tenants/${ids['Bangalore Branch']}/tasks/${task.id}/move`, {
      version: task.version, columnId: hydData.columns[0].id,
    });
    assert.equal(res.status, 404);
  });

  test('cannot assign a user from another branch', async () => {
    const blrData = await firstBoard('dan', ids['Bangalore Branch']);
    const task = blrData.tasks[0];
    const bob = (await call('bob', 'GET', '/auth/me')).body.user;
    const res = await call('dan', 'PATCH', `/tenants/${ids['Bangalore Branch']}/tasks/${task.id}`, { version: task.version, assigneeId: bob.id });
    assert.equal(res.status, 400);
  });

  test('no token -> 401', async () => {
    const res = await call(null, 'GET', `/tenants/${ids['Hyderabad Branch']}/boards`);
    assert.equal(res.status, 401);
  });
});

describe('role based access', () => {
  test('MEMBER cannot create boards or columns', async () => {
    const t = ids['Hyderabad Branch'];
    assert.equal((await call('carol', 'POST', `/tenants/${t}/boards`, { name: 'Nope' })).status, 403);
    const data = await firstBoard('carol', t);
    assert.equal((await call('carol', 'POST', `/tenants/${t}/boards/${data.board.id}/columns`, { name: 'Nope' })).status, 403);
  });

  test('MEMBER can still create tasks (column router must not block task routes)', async () => {
    const t = ids['Hyderabad Branch'];
    const data = await firstBoard('carol', t);
    const res = await call('carol', 'POST', `/tenants/${t}/boards/${data.board.id}/tasks`, { columnId: data.columns[0].id, title: 'Member task' });
    assert.equal(res.status, 201);
  });

  test('TENANT_ADMIN can create boards but not branches', async () => {
    const t = ids['Hyderabad Branch'];
    assert.equal((await call('bob', 'POST', `/tenants/${t}/boards`, { name: 'Bob board' })).status, 201);
    const me = await call('bob', 'GET', '/auth/me');
    assert.equal((await call('bob', 'POST', `/orgs/${me.body.orgs[0].id}/tenants`, { name: 'Chennai' })).status, 403);
  });

  test('ORG_ADMIN can create a branch, and it comes with a board', async () => {
    const me = await call('alice', 'GET', '/auth/me');
    const res = await call('alice', 'POST', `/orgs/${me.body.orgs[0].id}/tenants`, { name: 'Chennai Branch' });
    assert.equal(res.status, 201);
    const boards = await call('alice', 'GET', `/tenants/${res.body.tenant.id}/boards`);
    assert.equal(boards.body.boards.length, 1);
  });
});

describe('concurrency', () => {
  test('two edits based on the same version -> second one gets 409 with latest copy', async () => {
    const t = ids['Hyderabad Branch'];
    const data = await firstBoard('bob', t);
    const task = data.tasks[0];

    const first = await call('bob', 'PATCH', `/tenants/${t}/tasks/${task.id}`, { version: task.version, title: 'Bob title' });
    const second = await call('carol', 'PATCH', `/tenants/${t}/tasks/${task.id}`, { version: task.version, description: 'Carol desc' });

    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'VERSION_CONFLICT');
    assert.equal(second.body.current.title, 'Bob title');
    assert.equal(second.body.current.version, task.version + 1);

    // client "auto-merge": retry with the new version, only my field -> both changes survive
    const retry = await call('carol', 'PATCH', `/tenants/${t}/tasks/${task.id}`, { version: second.body.current.version, description: 'Carol desc' });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.task.title, 'Bob title');
    assert.equal(retry.body.task.description, 'Carol desc');
  });

  test('update without version is rejected', async () => {
    const t = ids['Hyderabad Branch'];
    const data = await firstBoard('bob', t);
    const res = await call('bob', 'PATCH', `/tenants/${t}/tasks/${data.tasks[0].id}`, { title: 'x' });
    assert.equal(res.status, 400);
  });

  test('drag-drop: dropping next to a card that was moved away still works', async () => {
    const t = ids['Hyderabad Branch'];
    const data = await firstBoard('bob', t);
    const [colA, colB] = data.columns;
    const inA = data.tasks.filter((x) => x.columnId === colA.id);
    const mover = data.tasks.find((x) => x.columnId === colB.id);
    const neighbour = inA[0];

    // someone else moves the neighbour to column B first...
    await call('carol', 'POST', `/tenants/${t}/tasks/${neighbour.id}/move`, { version: neighbour.version, columnId: colB.id });
    // ...then bob drops his card "after neighbour" in column A (stale view)
    const res = await call('bob', 'POST', `/tenants/${t}/tasks/${mover.id}/move`, { version: mover.version, columnId: colA.id, prevTaskId: neighbour.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.task.columnId, colA.id); // landed in column A anyway (at the end)
  });

  test('many inserts in the same gap trigger a rebalance and keep order', async () => {
    const t = ids['Hyderabad Branch'];
    const board = (await call('bob', 'POST', `/tenants/${t}/boards`, { name: 'Gap test' })).body.board;
    const col = (await call('bob', 'GET', `/tenants/${t}/boards/${board.id}`)).body.columns[0];
    const a = (await call('bob', 'POST', `/tenants/${t}/boards/${board.id}/tasks`, { columnId: col.id, title: 'A' })).body.task;
    await call('bob', 'POST', `/tenants/${t}/boards/${board.id}/tasks`, { columnId: col.id, title: 'Z' });
    // always insert right after A -> gap halves each time
    for (let i = 0; i < 60; i++) {
      const r = await call('bob', 'POST', `/tenants/${t}/boards/${board.id}/tasks`, { columnId: col.id, title: `n${i}`, prevTaskId: a.id });
      assert.equal(r.status, 201);
    }
    const tasks = (await call('bob', 'GET', `/tenants/${t}/boards/${board.id}`)).body.tasks;
    const positions = tasks.map((x) => x.position);
    assert.equal(new Set(positions).size, positions.length, 'no duplicate positions');
    assert.equal(tasks[0].title, 'A');
    assert.equal(tasks[1].title, 'n59'); // newest insert is right after A
    assert.equal(tasks.at(-1).title, 'Z');
  });

  test('delete is soft and restore brings the card back', async () => {
    const t = ids['Hyderabad Branch'];
    const data = await firstBoard('carol', t);
    const task = data.tasks.at(-1);
    assert.equal((await call('carol', 'DELETE', `/tenants/${t}/tasks/${task.id}`, { version: task.version })).status, 200);
    assert.equal((await call('carol', 'GET', `/tenants/${t}/tasks/${task.id}`)).status, 404);
    const restored = await call('carol', 'POST', `/tenants/${t}/tasks/${task.id}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.task.id, task.id);
  });
});

describe('realtime channels', () => {
  test('socket without a valid token is refused', async () => {
    const err = await new Promise((resolve) => {
      const s = ioClient(baseUrl, { auth: { token: 'garbage' }, transports: ['websocket'], forceNew: true });
      s.on('connect_error', (e) => { s.close(); resolve(e); });
    });
    assert.equal(err.message, 'UNAUTHORIZED');
  });

  test('cannot join the room of a branch you do not belong to', async () => {
    const socket = await connectSocket('omar');
    const ack = await join(socket, ids['Hyderabad Branch']);
    assert.equal(ack.ok, false);
    socket.close();
  });

  test('events reach the same branch only', async () => {
    const hyd = ids['Hyderabad Branch'];
    const carolSocket = await connectSocket('carol');
    const danSocket = await connectSocket('dan');
    assert.equal((await join(carolSocket, hyd)).ok, true);
    assert.equal((await join(danSocket, ids['Bangalore Branch'])).ok, true);

    const data = await firstBoard('bob', hyd);
    const carolGets = waitFor(carolSocket, 'task:created');
    const danGets = waitFor(danSocket, 'task:created', 700);
    await call('bob', 'POST', `/tenants/${hyd}/boards/${data.board.id}/tasks`, { columnId: data.columns[0].id, title: 'Live!' });

    const received = await carolGets;
    assert.equal(received.task.title, 'Live!');
    assert.equal(received.tenantId, hyd);
    assert.equal(await danGets, null, 'Bangalore user must not see Hyderabad events');

    carolSocket.close();
    danSocket.close();
  });

  test('presence lists who is online in the branch', async () => {
    const hyd = ids['Hyderabad Branch'];
    const bobSocket = await connectSocket('bob');
    await join(bobSocket, hyd);
    const carolSocket = await connectSocket('carol');
    const update = waitFor(bobSocket, 'presence:update');
    await join(carolSocket, hyd);
    const names = (await update).users.map((u) => u.name).sort();
    assert.deepEqual(names, ['Bob Branchlead', 'Carol Coder']);
    bobSocket.close();
    carolSocket.close();
  });

  test('removing a member kicks their socket out of the branch room', async () => {
    const blr = ids['Bangalore Branch'];
    const danUser = (await call('dan', 'GET', '/auth/me')).body.user;
    const danSocket = await connectSocket('dan');
    await join(danSocket, blr);

    const kicked = waitFor(danSocket, 'tenant:kicked');
    const res = await call('alice', 'DELETE', `/tenants/${blr}/members/${danUser.id}`);
    assert.equal(res.status, 200);
    assert.ok(await kicked, 'dan should get tenant:kicked');
    assert.equal((await call('dan', 'GET', `/tenants/${blr}/boards`)).status, 404);
    danSocket.close();
  });
});
