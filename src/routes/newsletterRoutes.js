const express = require('express');
const router = express.Router();

const { subscribe } = require('../controllers/newsletterController');

// 1. Subscribe - POST /api/newsletter
router.post('/', subscribe);

module.exports = router;

