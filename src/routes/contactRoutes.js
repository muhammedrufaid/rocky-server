const express = require('express');
const router = express.Router();

const {
  createContact,
  getAllContacts,
  getContactById,
  updateContact,
  deleteContact,
} = require('../controllers/contactController');

// 1. Create contact - POST /api/contact
router.post('/', createContact);

// 2. Get all contacts - GET /api/contact
router.get('/', getAllContacts);

// 3. Get contact by id - GET /api/contact/:id
router.get('/:id', getContactById);

// 4. Update contact - PUT /api/contact/:id
router.put('/:id', updateContact);

// 5. Delete contact - DELETE /api/contact/:id
router.delete('/:id', deleteContact);

module.exports = router;