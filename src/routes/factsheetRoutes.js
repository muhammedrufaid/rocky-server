const express = require('express');
const router = express.Router();
const { upload } = require('../middleware/upload');
const { uploadFactsheet } = require('../controllers/factsheetController');

router.post('/', upload.single('pdf'), uploadFactsheet);

module.exports = router;
