const express = require('express');
const router = express.Router();

const {
  createDubaiSouthLead,
  getAllDubaiSouthLeads,
  getDubaiSouthLeadById,
  updateDubaiSouthLead,
  deleteDubaiSouthLead,
} = require('../controllers/dubaiSouthLeadController');
const { requireUserToken } = require('../middleware/authMiddleware');

router.post('/', createDubaiSouthLead);

router.get('/', requireUserToken, getAllDubaiSouthLeads);
router.get('/:id', requireUserToken, getDubaiSouthLeadById);
router.put('/:id', requireUserToken, updateDubaiSouthLead);
router.delete('/:id', requireUserToken, deleteDubaiSouthLead);

module.exports = router;
