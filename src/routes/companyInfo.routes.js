const express = require('express');
const router = express.Router();

const {
  createCompanyInfo,
  listCompanyInfo,
  getCompanyInfoByTopic,
  getCompanyInfoById,
  updateCompanyInfo,
  deleteCompanyInfo,
} = require('../controllers/companyInfo.controller');

// Create - POST /api/company-info
router.post('/', createCompanyInfo);

// List (optional ?topic=&category=&isActive=) - GET /api/company-info
router.get('/', listCompanyInfo);

// Get by topic - GET /api/company-info/topic/:topic
router.get('/topic/:topic', getCompanyInfoByTopic);

// Get by id - GET /api/company-info/:id
router.get('/:id', getCompanyInfoById);

// Update - PUT /api/company-info/:id
router.put('/:id', updateCompanyInfo);

// Delete - DELETE /api/company-info/:id
router.delete('/:id', deleteCompanyInfo);

module.exports = router;
