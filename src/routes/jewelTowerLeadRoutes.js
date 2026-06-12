const express = require('express');
const router = express.Router();

const {
  createJewelTowerLead,
  getAllJewelTowerLeads,
  getJewelTowerLeadById,
  updateJewelTowerLead,
  deleteJewelTowerLead,
} = require('../controllers/jewelTowerLeadController');

// 1. Create Jewel Tower lead - POST /api/jewel-tower-lead
router.post('/', createJewelTowerLead);

// 2. Get all Jewel Tower leads - GET /api/jewel-tower-lead
router.get('/', getAllJewelTowerLeads);

// 3. Get Jewel Tower lead by id - GET /api/jewel-tower-lead/:id
router.get('/:id', getJewelTowerLeadById);

// 4. Update Jewel Tower lead - PUT /api/jewel-tower-lead/:id
router.put('/:id', updateJewelTowerLead);

// 5. Delete Jewel Tower lead - DELETE /api/jewel-tower-lead/:id
router.delete('/:id', deleteJewelTowerLead);

module.exports = router;
