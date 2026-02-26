const express = require('express');
const router = express.Router();
const {
    getAllProperties,
} = require('../controllers/frontendController');

router.get('/properties', getAllProperties);

module.exports = router;
