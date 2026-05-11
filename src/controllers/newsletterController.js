const Newsletter = require('../models/Newsletter');

// 1. Subscribe - POST /api/newsletter
const subscribe = async (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email',
      });
    }

    const existing = await Newsletter.findOne({ email });
    if (existing) {
      return res.status(200).json({
        success: true,
        message: 'Already subscribed',
        data: existing,
      });
    }

    const created = await Newsletter.create({ email });

    return res.status(201).json({
      success: true,
      message: 'Subscribed successfully',
      data: created,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

module.exports = {
  subscribe,
};

