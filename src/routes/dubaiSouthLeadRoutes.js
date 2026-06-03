const express = require('express');
const router = express.Router();

const {
  createDubaiSouthLead,
  getAllDubaiSouthLeads,
  getDubaiSouthLeadById,
  updateDubaiSouthLead,
  deleteDubaiSouthLead,
} = require('../controllers/dubaiSouthLeadController');

// 1. Create Dubai South lead - POST /api/dubai-south-lead
router.post('/', createDubaiSouthLead);

// 2. Get all Dubai South leads - GET /api/dubai-south-lead
router.get('/', getAllDubaiSouthLeads);

// 3. Get Dubai South lead by id - GET /api/dubai-south-lead/:id
router.get('/:id', getDubaiSouthLeadById);

// 4. Update Dubai South lead - PUT /api/dubai-south-lead/:id
router.put('/:id', updateDubaiSouthLead);

// 5. Delete Dubai South lead - DELETE /api/dubai-south-lead/:id
router.delete('/:id', deleteDubaiSouthLead);

module.exports = router;
