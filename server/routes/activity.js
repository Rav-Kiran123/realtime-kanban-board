// /api/tenants/:tenantId/activity -> audit log for one branch (newest first)
const express = require('express');
const { listActivity } = require('../services/activity');
const { optionalId } = require('../utils/validate');

const router = express.Router({ mergeParams: true });

// ?boardId=1&taskId=2&beforeId=100&limit=50
router.get('/activity', (req, res) => {
  const q = req.query;
  const activity = listActivity(req.tenant.id, {
    boardId: optionalId(q.boardId, 'boardId'),
    taskId: optionalId(q.taskId, 'taskId'),
    beforeId: optionalId(q.beforeId, 'beforeId'),
    limit: Number(q.limit) || 50,
  });
  res.json({ activity });
});

module.exports = router;
