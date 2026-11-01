// Demo data so the app is fun to try right away.
// Two organizations, each with branches, users in different roles, and a few tasks.
const bcrypt = require('bcryptjs');
const { getDb, transaction } = require('./database');
const { createBoard, listColumns } = require('../services/boards');
const { GAP } = require('../services/ordering');

function seedIfEmpty() {
  const db = getDb();
  if (db.prepare('SELECT COUNT(*) AS n FROM organizations').get().n > 0) return false;

  transaction(() => {
    // hash once (cost 8 to keep startup fast - it's only demo data)
    const hash = bcrypt.hashSync('password123', 8);

    const addUser = (name, email, color) =>
      db.prepare('INSERT INTO users (name, email, password_hash, avatar_color) VALUES (?, ?, ?, ?)').run(name, email, hash, color).lastInsertRowid;
    const addOrg = (name) => db.prepare('INSERT INTO organizations (name) VALUES (?)').run(name).lastInsertRowid;
    const addTenant = (orgId, name) => db.prepare('INSERT INTO tenants (org_id, name) VALUES (?, ?)').run(orgId, name).lastInsertRowid;
    const addMember = (userId, orgId, tenantId, role) =>
      db.prepare('INSERT INTO memberships (user_id, org_id, tenant_id, role) VALUES (?, ?, ?, ?)').run(userId, orgId, tenantId, role);

    // ---- users ----
    const alice = addUser('Alice Admin', 'alice@acme.test', '#e76f51');
    const bob = addUser('Bob Branchlead', 'bob@acme.test', '#2a9d8f');
    const carol = addUser('Carol Coder', 'carol@acme.test', '#8338ec');
    const dan = addUser('Dan Designer', 'dan@acme.test', '#3a86ff');
    const gina = addUser('Gina Globex', 'gina@globex.test', '#ff006e');
    const omar = addUser('Omar Ops', 'omar@globex.test', '#fb8500');

    // ---- organization 1: Acme ----
    const acme = addOrg('Acme Corp');
    const hyd = addTenant(acme, 'Hyderabad Branch');
    const blr = addTenant(acme, 'Bangalore Branch');
    addMember(alice, acme, null, 'ORG_ADMIN');
    addMember(bob, acme, hyd, 'TENANT_ADMIN');
    addMember(carol, acme, hyd, 'MEMBER');
    addMember(carol, acme, blr, 'MEMBER');
    addMember(dan, acme, blr, 'MEMBER');

    // ---- organization 2: Globex (completely separate world) ----
    const globex = addOrg('Globex Inc');
    const london = addTenant(globex, 'London Office');
    const ny = addTenant(globex, 'New York Office');
    addMember(gina, globex, null, 'ORG_ADMIN');
    addMember(omar, globex, london, 'MEMBER');

    // ---- boards + sample tasks ----
    const addTasks = (tenantId, boardId, byColumn, userId) => {
      const cols = listColumns(tenantId, boardId);
      const insert = db.prepare(`
        INSERT INTO tasks (tenant_id, board_id, column_id, title, description, priority, assignee_id, position, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      byColumn.forEach((tasks, colIndex) => {
        tasks.forEach(([title, priority, assignee, description = ''], i) => {
          insert.run(tenantId, boardId, cols[colIndex].id, title, description, priority, assignee, (i + 1) * GAP, userId, userId);
        });
      });
    };

    const hydBoard = createBoard({ tenantId: hyd, name: 'Product Sprint', description: 'Sprint 14 work', userId: bob });
    addTasks(hyd, hydBoard.id, [
      [['Set up CI pipeline', 'high', carol, 'GitHub Actions: lint + test on every PR'], ['Write onboarding docs', 'low', null]],
      [['Login page redesign', 'medium', carol, 'Follow the new Figma file'], ['Fix timezone bug in reports', 'urgent', bob]],
      [['Add dark mode', 'low', carol]],
      [['Upgrade Node to v24', 'medium', bob]],
    ], bob);
    createBoard({ tenantId: hyd, name: 'Hiring', userId: bob });

    const blrBoard = createBoard({ tenantId: blr, name: 'Design Board', userId: alice });
    addTasks(blr, blrBoard.id, [
      [['New icon set', 'medium', dan], ['Mobile wireframes', 'high', dan]],
      [['Brand colour review', 'low', carol]],
      [], [],
    ], alice);

    const lonBoard = createBoard({ tenantId: london, name: 'Operations', userId: gina });
    addTasks(london, lonBoard.id, [
      [['Renew office lease', 'high', gina], ['Order new laptops', 'medium', omar]],
      [['Server migration', 'urgent', omar]],
      [], [['Quarterly audit', 'low', gina]],
    ], gina);

    createBoard({ tenantId: ny, name: 'Sales Pipeline', userId: gina });
  });
  return true;
}

module.exports = { seedIfEmpty };
