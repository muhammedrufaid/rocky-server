const express = require('express');
const router = express.Router();
const {
    getAllProperties,
    getAllOffPlanProperties,
    getAllReadyProperties,
} = require('../controllers/frontendController');

router.get('/properties', getAllProperties);
router.get('/properties/off-plan', getAllOffPlanProperties);
router.get('/properties/ready', getAllReadyProperties);

module.exports = router;
