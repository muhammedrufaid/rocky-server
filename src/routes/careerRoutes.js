const express = require('express');
const router = express.Router();
const { uploadCV } = require('../middleware/upload');

const {
  createCareer,
  getAllCareers,
  getCareerById,
  updateCareer,
  deleteCareer,
} = require('../controllers/careerController');
const { requireUserToken } = require('../middleware/authMiddleware');

// 1. Create career application - POST /api/career (public form; x-api-key only)
router.post('/', uploadCV, createCareer);

// Admin / sensitive enquiry data: x-api-key + Bearer user token
router.get('/', requireUserToken, getAllCareers);
router.get('/:id', requireUserToken, getCareerById);
router.put('/:id', requireUserToken, uploadCV, updateCareer);
router.delete('/:id', requireUserToken, deleteCareer);

module.exports = router;
