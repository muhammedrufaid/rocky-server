const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const { sendToZapier, ZAPIER_SOURCES } = require('../services/zapierService');

// 1. Create contact - POST /api/contact
const createContact = async (req, res) => {
  try {
    const { fullName, email, phone, inquiryType, message } = req.body;

    if (!fullName || !email || !phone || !inquiryType || !message) {
      return res.status(400).json({
        success: false,
        message: 'Please provide fullName, email, phone, inquiryType and message',
      });
    }

    const contact = await Contact.create({
      fullName,
      email,
      phone,
      inquiryType,
      message,
    });

    // MongoDB is source of truth; Zapier is best-effort (never fails the request)
    try {
      await sendToZapier({
        fullName: contact.fullName,
        email: contact.email,
        phone: contact.phone,
        inquiryType: contact.inquiryType,
        message: contact.message,
        source: ZAPIER_SOURCES.CONTACT_US,
      });
    } catch (zapierError) {
      console.error('[Zapier] Unexpected error after contact save:', zapierError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Contact created successfully',
      data: {
        ...contact.toObject(),
        source: ZAPIER_SOURCES.CONTACT_US,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 2. Get all contacts - GET /api/contact
const getAllContacts = async (req, res) => {
  try {
    const contacts = await Contact.find().sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: contacts.length,
      data: contacts,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 3. Get contact by id - GET /api/contact/:id
const getContactById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid contact id',
      });
    }

    const contact = await Contact.findById(id);
    if (!contact) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: contact,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 4. Update contact - PUT /api/contact/:id
const updateContact = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid contact id',
      });
    }

    const updates = {};
    const allowedFields = ['fullName', 'email', 'phone', 'inquiryType', 'message'];
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const updated = await Contact.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Contact updated successfully',
      data: updated,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

// 5. Delete contact - DELETE /api/contact/:id
const deleteContact = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid contact id',
      });
    }

    const deleted = await Contact.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Contact deleted successfully',
      data: deleted,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

module.exports = {
  createContact,
  getAllContacts,
  getContactById,
  updateContact,
  deleteContact,
};

