const express = require('express');
const router = express.Router();

const {
  createFaq,
  getAllFaqs,
  getFaqById,
  updateFaq,
  deleteFaq,
} = require('../controllers/faqController');

// 1. Create FAQ - POST /api/faqs
router.post('/', createFaq);

// 2. Get all FAQs - GET /api/faqs
router.get('/', getAllFaqs);

// 3. Get FAQ by id - GET /api/faqs/:id
router.get('/:id', getFaqById);

// 4. Update FAQ - PUT /api/faqs/:id
router.put('/:id', updateFaq);

// 5. Delete FAQ - DELETE /api/faqs/:id
router.delete('/:id', deleteFaq);

module.exports = router;
