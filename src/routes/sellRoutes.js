const express = require('express');
const router = express.Router();

const {
  createSell,
  getAllSell,
  getSellById,
  updateSell,
  deleteSell,
} = require('../controllers/sellController');

// 1. Create sell inquiry - POST /api/sell
router.post('/', createSell);

// 2. Get all sell inquiries - GET /api/sell
router.get('/', getAllSell);

// 3. Get sell inquiry by id - GET /api/sell/:id
router.get('/:id', getSellById);

// 4. Update sell inquiry - PUT /api/sell/:id
router.put('/:id', updateSell);

// 5. Delete sell inquiry - DELETE /api/sell/:id
router.delete('/:id', deleteSell);

module.exports = router;

