const express = require('express');
const router = express.Router();

const {
  createService,
  getServices,
  getServiceById,
  getServiceBySlug,
  updateService,
  deleteService,
} = require('../controllers/serviceController');

// 1. Create Service - POST /api/services
router.post('/', createService);

// 2. Get all Services - GET /api/services
router.get('/', getServices);

// 3. Get Service by slug - GET /api/services/slug/:slug
// Must be registered before /:id to avoid treating "slug" as an ObjectId
router.get('/slug/:slug', getServiceBySlug);

// 4. Get Service by id - GET /api/services/:id
router.get('/:id', getServiceById);

// 5. Update Service - PUT /api/services/:id
router.put('/:id', updateService);

// 6. Delete Service - DELETE /api/services/:id
router.delete('/:id', deleteService);

module.exports = router;
