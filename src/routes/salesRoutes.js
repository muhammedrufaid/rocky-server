const express = require('express');
const router = express.Router();

const {
  createSales,
  getAllSales,
  getSalesById,
  updateSales,
  deleteSales,
} = require('../controllers/salesController');

// 1. Create sales inquiry - POST /api/sales
router.post('/', createSales);

// 2. Get all sales inquiries - GET /api/sales
router.get('/', getAllSales);

// 3. Get sales inquiry by id - GET /api/sales/:id
router.get('/:id', getSalesById);

// 4. Update sales inquiry - PUT /api/sales/:id
router.put('/:id', updateSales);

// 5. Delete sales inquiry - DELETE /api/sales/:id
router.delete('/:id', deleteSales);

module.exports = router;

