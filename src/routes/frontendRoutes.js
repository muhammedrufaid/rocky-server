const express = require('express');
const router = express.Router();
const {
    getAllProperties,
    getAllOffPlanProperties,
    getAllReadyProperties,
    getBuyProperties,
    getRentProperties,
} = require('../controllers/frontendController');

router.get('/properties', getAllProperties);
router.get('/properties/off-plan', getAllOffPlanProperties);
router.get('/properties/ready', getAllReadyProperties);
router.get('/properties/buy', getBuyProperties);
router.get('/properties/rent', getRentProperties);

module.exports = router;
