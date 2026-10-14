const mongoose = require('mongoose');
const Property = require('../models/Property');
const PropertyEnquiry = require('../models/PropertyEnquiry');
const {
  MESSAGE_VALIDATION_ERROR,
  isValidPropertyEnquiryEmail,
  isValidPropertyEnquiryMessage,
} = PropertyEnquiry;
const { isHeadOfficeValue } = require('../utils/headOffice');
const { parsePaginationParams } = require('../utils/paginationUtils');
const { sendToZapier, ZAPIER_SOURCES } = require('../services/zapierService');

const UPDATABLE_FIELDS = ['propertyRefNo', 'fullName', 'phone', 'email', 'message', 'isHeadOffice'];
const HEAD_OFFICE_VALUES = ['yes', 'no'];

const formatList = (items) => {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
};

const validationError = (res, message) => {
  return res.status(400).json({
    success: false,
    message,
  });
};

const asTrimmedString = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).trim();
  if (typeof value !== 'string') return '';
  return value.trim();
};

const respondWithError = (res, error) => {
  if (error.name === 'ValidationError') {
    const message = Object.values(error.errors)
      .map((item) => item.message)
      .join('. ');
    return res.status(400).json({
      success: false,
      message: message || 'Validation failed',
    });
  }

  return res.status(500).json({
    success: false,
    message: error.message || 'Server error',
  });
};

const invalidIdResponse = (res) => {
  return validationError(res, 'Invalid property enquiry id');
};

const validateEnquiryFields = (fields, { partial = false } = {}) => {
  if (!partial) {
    const missing = [];
    if (!fields.propertyRefNo) missing.push('propertyRefNo');
    if (!fields.fullName) missing.push('fullName');
    if (!fields.phone) missing.push('phone');
    if (!fields.message) missing.push('message');

    if (missing.length) {
      return `Please provide ${formatList(missing)}`;
    }
  } else {
    if (fields.propertyRefNo !== undefined && !fields.propertyRefNo) {
      return 'Property reference number is required';
    }
    if (fields.fullName !== undefined && !fields.fullName) {
      return 'Full name is required';
    }
    if (fields.phone !== undefined && !fields.phone) {
      return 'Phone is required';
    }
    if (fields.message !== undefined && !fields.message) {
      return 'Message is required';
    }
    if (
      fields.isHeadOffice !== undefined &&
      !HEAD_OFFICE_VALUES.includes(fields.isHeadOffice)
    ) {
      return 'isHeadOffice must be yes or no';
    }
  }

  if (fields.email) {
    if (!isValidPropertyEnquiryEmail(fields.email)) {
      return 'Please provide a valid email address';
    }
  }

  if (fields.message && !isValidPropertyEnquiryMessage(fields.message)) {
    return MESSAGE_VALIDATION_ERROR;
  }

  return null;
};

const zapierPayload = (enquiry) => ({
  propertyRefNo: enquiry.propertyRefNo,
  fullName: enquiry.fullName,
  phone: enquiry.phone,
  email: enquiry.email || '',
  message: enquiry.message,
  isHeadOffice: enquiry.isHeadOffice,
  source: ZAPIER_SOURCES.PROPERTY_ENQUIRY,
});

const resolveIsHeadOffice = async (propertyRefNo) => {
  const property = await Property.findOne({ propertyRefNo }).select('listingAgent').lean();
  return isHeadOfficeValue(property?.listingAgent);
};

// 1. Create property enquiry - POST /api/property-enquiries
const createPropertyEnquiry = async (req, res) => {
  try {
    const body = req.body || {};
    const propertyRefNo = asTrimmedString(body.propertyRefNo);
    const fullName = asTrimmedString(body.fullName);
    const phone = asTrimmedString(body.phone);
    const email = asTrimmedString(body.email).toLowerCase();
    const message = asTrimmedString(body.message);

    const errorMessage = validateEnquiryFields({
      propertyRefNo,
      fullName,
      phone,
      email,
      message,
    });
    if (errorMessage) return validationError(res, errorMessage);

    const isHeadOffice = await resolveIsHeadOffice(propertyRefNo);

    const enquiry = await PropertyEnquiry.create({
      propertyRefNo,
      fullName,
      phone,
      ...(email ? { email } : {}),
      message,
      isHeadOffice,
    });

    // MongoDB is source of truth. Zapier runs once after save and never rolls the record back.
    try {
      await sendToZapier(zapierPayload(enquiry));
    } catch (zapierError) {
      console.error('[Zapier] Unexpected error after property enquiry save:', zapierError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Property enquiry created successfully',
      data: enquiry,
    });
  } catch (error) {
    return respondWithError(res, error);
  }
};

// 2. List property enquiries - GET /api/property-enquiries
const getAllPropertyEnquiries = async (req, res) => {
  try {
    const { page, limit } = parsePaginationParams(req);
    const skip = (page - 1) * limit;

    const [enquiries, total] = await Promise.all([
      PropertyEnquiry.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
      PropertyEnquiry.countDocuments(),
    ]);

    const totalPages = total > 0 ? Math.ceil(total / limit) : 0;

    return res.status(200).json({
      success: true,
      count: enquiries.length,
      total,
      data: enquiries,
      pagination: {
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    });
  } catch (error) {
    return respondWithError(res, error);
  }
};

// 3. Get property enquiry by id - GET /api/property-enquiries/:id
const getPropertyEnquiryById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return invalidIdResponse(res);
    }

    const enquiry = await PropertyEnquiry.findById(id);
    if (!enquiry) {
      return res.status(404).json({
        success: false,
        message: 'Property enquiry not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: enquiry,
    });
  } catch (error) {
    return respondWithError(res, error);
  }
};

// 4. Update property enquiry - PATCH /api/property-enquiries/:id
const updatePropertyEnquiry = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return invalidIdResponse(res);
    }

    const body = req.body || {};
    const updates = {};
    const unset = {};

    UPDATABLE_FIELDS.forEach((field) => {
      if (!Object.prototype.hasOwnProperty.call(body, field)) return;

      if (field === 'email') {
        const email = asTrimmedString(body.email).toLowerCase();
        if (!email) {
          unset.email = 1;
          return;
        }
        updates.email = email;
        return;
      }

      updates[field] = field === 'isHeadOffice'
        ? asTrimmedString(body[field]).toLowerCase()
        : asTrimmedString(body[field]);
    });

    if (!Object.keys(updates).length && !Object.keys(unset).length) {
      return validationError(
        res,
        'Please provide at least one of propertyRefNo, fullName, phone, email, message or isHeadOffice'
      );
    }

    const errorMessage = validateEnquiryFields(
      {
        propertyRefNo: updates.propertyRefNo,
        fullName: updates.fullName,
        phone: updates.phone,
        email: updates.email,
        message: updates.message,
        isHeadOffice: updates.isHeadOffice,
      },
      { partial: true }
    );
    if (errorMessage) return validationError(res, errorMessage);

    const updateDoc = {};
    if (Object.keys(updates).length) updateDoc.$set = updates;
    if (Object.keys(unset).length) updateDoc.$unset = unset;

    const updated = await PropertyEnquiry.findByIdAndUpdate(id, updateDoc, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Property enquiry not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Property enquiry updated successfully',
      data: updated,
    });
  } catch (error) {
    return respondWithError(res, error);
  }
};

// 5. Delete property enquiry - DELETE /api/property-enquiries/:id
const deletePropertyEnquiry = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return invalidIdResponse(res);
    }

    const deleted = await PropertyEnquiry.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Property enquiry not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Property enquiry deleted successfully',
      data: deleted,
    });
  } catch (error) {
    return respondWithError(res, error);
  }
};

module.exports = {
  createPropertyEnquiry,
  getAllPropertyEnquiries,
  getPropertyEnquiryById,
  updatePropertyEnquiry,
  deletePropertyEnquiry,
};
