const express = require('express');
const router = express.Router();

const {
  createBinghattiLead,
  getAllBinghattiLeads,
  getBinghattiLeadById,
  updateBinghattiLead,
  deleteBinghattiLead,
} = require('../controllers/binghattiLeadController');
const { requireUserToken } = require('../middleware/authMiddleware');

router.post('/', createBinghattiLead);

router.get('/', requireUserToken, getAllBinghattiLeads);
router.get('/:id', requireUserToken, getBinghattiLeadById);
router.put('/:id', requireUserToken, updateBinghattiLead);
router.delete('/:id', requireUserToken, deleteBinghattiLead);

module.exports = router;
