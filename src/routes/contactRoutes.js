const express = require('express');
const router = express.Router();

const {
  createContact,
  getAllContacts,
  getContactById,
  updateContact,
  deleteContact,
} = require('../controllers/contactController');
const { requireUserToken } = require('../middleware/authMiddleware');

// 1. Create contact - POST /api/contact (public form; x-api-key only)
router.post('/', createContact);

// Admin / sensitive enquiry data: x-api-key + Bearer user token
// 2. Get all contacts - GET /api/contact
router.get('/', requireUserToken, getAllContacts);

// 3. Get contact by id - GET /api/contact/:id
router.get('/:id', requireUserToken, getContactById);

// 4. Update contact - PUT /api/contact/:id
router.put('/:id', requireUserToken, updateContact);

// 5. Delete contact - DELETE /api/contact/:id
router.delete('/:id', requireUserToken, deleteContact);

module.exports = router;
