const express = require('express');
const router = express.Router();

const {
  createPropertyEnquiry,
  getAllPropertyEnquiries,
  getPropertyEnquiryById,
  updatePropertyEnquiry,
  deletePropertyEnquiry,
} = require('../controllers/propertyEnquiryController');
const { requireUserToken } = require('../middleware/authMiddleware');

// 1. Create property enquiry - POST /api/property-enquiries (public form; x-api-key only)
router.post('/', createPropertyEnquiry);

// Admin / sensitive enquiry data: x-api-key + Bearer user token
// 2. List property enquiries - GET /api/property-enquiries
router.get('/', requireUserToken, getAllPropertyEnquiries);

// 3. Get property enquiry by id - GET /api/property-enquiries/:id
router.get('/:id', requireUserToken, getPropertyEnquiryById);

// 4. Update property enquiry - PATCH /api/property-enquiries/:id
router.patch('/:id', requireUserToken, updatePropertyEnquiry);

// 5. Delete property enquiry - DELETE /api/property-enquiries/:id
router.delete('/:id', requireUserToken, deletePropertyEnquiry);

module.exports = router;
