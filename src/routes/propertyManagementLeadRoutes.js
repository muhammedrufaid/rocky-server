const express = require('express');
const router = express.Router();

const {
  createPropertyManagementLead,
  getAllPropertyManagementLeads,
  getPropertyManagementLeadById,
  updatePropertyManagementLead,
  deletePropertyManagementLead,
} = require('../controllers/propertyManagementLeadController');

// 1. Create property management lead - POST /api/property-management-lead
router.post('/', createPropertyManagementLead);

// 2. Get all property management leads - GET /api/property-management-lead
router.get('/', getAllPropertyManagementLeads);

// 3. Get property management lead by id - GET /api/property-management-lead/:id
router.get('/:id', getPropertyManagementLeadById);

// 4. Update property management lead - PUT /api/property-management-lead/:id
router.put('/:id', updatePropertyManagementLead);

// 5. Delete property management lead - DELETE /api/property-management-lead/:id
router.delete('/:id', deletePropertyManagementLead);

module.exports = router;
