const express = require('express');
const router = express.Router();

const {
  createBinghattiLead,
  getAllBinghattiLeads,
  getBinghattiLeadById,
  updateBinghattiLead,
  deleteBinghattiLead,
} = require('../controllers/binghattiLeadController');

// 1. Create Binghatti lead - POST /api/binghatti-lead
router.post('/', createBinghattiLead);

// 2. Get all Binghatti leads - GET /api/binghatti-lead
router.get('/', getAllBinghattiLeads);

// 3. Get Binghatti lead by id - GET /api/binghatti-lead/:id
router.get('/:id', getBinghattiLeadById);

// 4. Update Binghatti lead - PUT /api/binghatti-lead/:id
router.put('/:id', updateBinghattiLead);

// 5. Delete Binghatti lead - DELETE /api/binghatti-lead/:id
router.delete('/:id', deleteBinghattiLead);

module.exports = router;
