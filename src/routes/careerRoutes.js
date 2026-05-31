const express = require('express');
const router = express.Router();
const { upload } = require('../middleware/upload');

const {
  createCareer,
  getAllCareers,
  getCareerById,
  updateCareer,
  deleteCareer,
  viewCareerCv,
  downloadCareerCv,
} = require('../controllers/careerController');

// 1. Create career application - POST /api/career
router.post('/', upload.single('cv'), createCareer);

// 2. Get all career applications - GET /api/career
router.get('/', getAllCareers);

// 6. View CV inline - GET /api/career/:id/cv/view
router.get('/:id/cv/view', viewCareerCv);

// 7. Download CV - GET /api/career/:id/cv/download
router.get('/:id/cv/download', downloadCareerCv);

// 3. Get career application by id - GET /api/career/:id
router.get('/:id', getCareerById);

// 4. Update career application - PUT /api/career/:id
router.put('/:id', upload.single('cv'), updateCareer);

// 5. Delete career application - DELETE /api/career/:id
router.delete('/:id', deleteCareer);

module.exports = router;
