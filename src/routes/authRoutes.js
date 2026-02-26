const express = require('express');
const router = express.Router();
const {
  signup,
  login,
  getAllUsers,
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

// 1. Signup - POST /api/auth/signup
router.post('/signup', signup);

// 2. Login - POST /api/auth/login
router.post('/login', login);

// 3. Get all users - GET /api/auth/users (protected)
router.get('/users', protect, getAllUsers);

module.exports = router;
