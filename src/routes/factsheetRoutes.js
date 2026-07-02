const express = require('express');
const router = express.Router();
const { uploadPDF } = require('../middleware/upload');
const { uploadFactsheet } = require('../controllers/factsheetController');

router.post('/', uploadPDF, uploadFactsheet);

module.exports = router;
