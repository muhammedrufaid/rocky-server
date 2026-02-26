const express = require('express');
const router = express.Router();
const {
    getAllProperties,
    getAllOffPlanProperties,
} = require('../controllers/frontendController');

router.get('/properties', getAllProperties);
router.get('/properties/off-plan', getAllOffPlanProperties);

module.exports = router;
