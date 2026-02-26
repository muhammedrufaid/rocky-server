const express = require('express');
const { signup, login } = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// public
router.post('/signup', signup);
router.post('/login', login);

// example protected route to test middleware
router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
