const express = require('express');
const adminDatabaseController = require('../controllers/admin-database.controller');
const { requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

// All admin database configuration and switching endpoints require a platform
// admin JWT. Tenant API keys are deliberately rejected (they used to be
// accepted, which let any tenant switch the global database).
router.use(requireAdmin);

router.get('/config', (req, res, next) => adminDatabaseController.getConfig(req, res, next));
router.get('/status', (req, res, next) => adminDatabaseController.getStatus(req, res, next));
router.post('/test-connection', (req, res, next) => adminDatabaseController.testConnection(req, res, next));
router.post('/switch', (req, res, next) => adminDatabaseController.switchDatabase(req, res, next));
router.get('/switch-history', (req, res, next) => adminDatabaseController.getSwitchHistory(req, res, next));

module.exports = router;
