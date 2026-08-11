const express = require('express');
const router = express.Router();

const {
  createSell,
  getAllSell,
  getSellById,
  updateSell,
  deleteSell,
} = require('../controllers/sellController');
const { requireUserToken } = require('../middleware/authMiddleware');

// 1. Create sell inquiry - POST /api/sell (public form; x-api-key only)
router.post('/', createSell);

// Admin / sensitive enquiry data: x-api-key + Bearer user token
router.get('/', requireUserToken, getAllSell);
router.get('/:id', requireUserToken, getSellById);
router.put('/:id', requireUserToken, updateSell);
router.delete('/:id', requireUserToken, deleteSell);

module.exports = router;
