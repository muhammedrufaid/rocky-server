const express = require('express');
const router = express.Router();

const {
  createPropertyType,
  getAllPropertyTypes,
  getPropertyTypeById,
  updatePropertyType,
  deletePropertyType,
} = require('../controllers/propertyTypeController');

// POST /api/property-types
router.post('/', createPropertyType);

// GET /api/property-types
router.get('/', getAllPropertyTypes);

// GET /api/property-types/:id
router.get('/:id', getPropertyTypeById);

// PUT /api/property-types/:id
router.put('/:id', updatePropertyType);

// DELETE /api/property-types/:id
router.delete('/:id', deletePropertyType);

module.exports = router;
