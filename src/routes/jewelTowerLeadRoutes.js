const express = require('express');
const router = express.Router();

const {
  createJewelTowerLead,
  getAllJewelTowerLeads,
  getJewelTowerLeadById,
  updateJewelTowerLead,
  deleteJewelTowerLead,
} = require('../controllers/jewelTowerLeadController');
const { requireUserToken } = require('../middleware/authMiddleware');

router.post('/', createJewelTowerLead);

router.get('/', requireUserToken, getAllJewelTowerLeads);
router.get('/:id', requireUserToken, getJewelTowerLeadById);
router.put('/:id', requireUserToken, updateJewelTowerLead);
router.delete('/:id', requireUserToken, deleteJewelTowerLead);

module.exports = router;
