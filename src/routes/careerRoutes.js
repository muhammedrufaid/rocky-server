const express = require('express');
const router = express.Router();

const {
  createCareer,
  getAllCareers,
  getCareerById,
  updateCareer,
  deleteCareer,
} = require('../controllers/careerController');

// 1. Create career application - POST /api/career
router.post('/', createCareer);

// 2. Get all career applications - GET /api/career
router.get('/', getAllCareers);

// 3. Get career application by id - GET /api/career/:id
router.get('/:id', getCareerById);

// 4. Update career application - PUT /api/career/:id
router.put('/:id', updateCareer);

// 5. Delete career application - DELETE /api/career/:id
router.delete('/:id', deleteCareer);

module.exports = router;
