const express = require('express');
const router = express.Router();

const {
  createPropertyManagementLead,
  getAllPropertyManagementLeads,
  getPropertyManagementLeadById,
  updatePropertyManagementLead,
  deletePropertyManagementLead,
} = require('../controllers/propertyManagementLeadController');
const { requireUserToken } = require('../middleware/authMiddleware');

// 1. Create property management lead - POST (public form; x-api-key only)
router.post('/', createPropertyManagementLead);

// Admin / sensitive enquiry data: x-api-key + Bearer user token
router.get('/', requireUserToken, getAllPropertyManagementLeads);
router.get('/:id', requireUserToken, getPropertyManagementLeadById);
router.put('/:id', requireUserToken, updatePropertyManagementLead);
router.delete('/:id', requireUserToken, deletePropertyManagementLead);

module.exports = router;
