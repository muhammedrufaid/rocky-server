const mongoose = require('mongoose');
const { isHeadOfficeValue } = require('../utils/headOffice');

const PROPERTY_ENQUIRY_SUB_SOURCE = 'Listing Page';

const CONTACT_OPTIONS = ['WhatsApp', 'Callback'];
const CONTACT_TIMES = ['Morning', 'Afternoon', 'Evening'];
const MARKETING_CONSENT_VALUES = ['Yes', 'No'];

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;
const MESSAGE_PATTERN =
  /^Contact option: (WhatsApp|Callback); Preferred contact time: (Morning|Afternoon|Evening); Marketing consent: (Yes|No)\.$/;

const MESSAGE_FORMAT_EXAMPLE =
  'Contact option: WhatsApp; Preferred contact time: Morning; Marketing consent: Yes.';

const MESSAGE_VALIDATION_ERROR =
  `Message must match "${MESSAGE_FORMAT_EXAMPLE}". ` +
  'Contact option must be WhatsApp or Callback. ' +
  'Preferred contact time must be Morning, Afternoon, or Evening. ' +
  'Marketing consent must be Yes or No.';

/**
 * @param {unknown} message
 * @returns {boolean}
 */
const isValidPropertyEnquiryMessage = (message) => {
  return typeof message === 'string' && MESSAGE_PATTERN.test(message.trim());
};

/**
 * @param {unknown} email
 * @returns {boolean}
 */
const isValidPropertyEnquiryEmail = (email) => {
  return typeof email === 'string' && EMAIL_PATTERN.test(email.trim());
};

const propertyEnquirySchema = new mongoose.Schema(
  {
    subSource: {
      type: String,
      required: [true, 'Sub source is required'],
      trim: true,
      default: PROPERTY_ENQUIRY_SUB_SOURCE,
    },
    propertyRefNo: {
      type: String,
      required: [true, 'Property reference number is required'],
      trim: true,
      index: true,
    },
    fullName: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true,
    },
    phone: {
      type: String,
      required: [true, 'Phone is required'],
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
      sparse: true,
      validate: {
        validator(value) {
          if (value == null || value === '') return true;
          return EMAIL_PATTERN.test(value);
        },
        message: 'Please provide a valid email address',
      },
    },
    message: {
      type: String,
      required: [true, 'Message is required'],
      trim: true,
      validate: {
        validator: isValidPropertyEnquiryMessage,
        message: MESSAGE_VALIDATION_ERROR,
      },
    },
    listingAgent: {
      type: String,
      trim: true,
      default: '',
    },
    isHeadOffice: {
      type: String,
      required: [true, 'isHeadOffice is required'],
      enum: {
        values: ['yes', 'no'],
        message: 'isHeadOffice must be yes or no',
      },
      lowercase: true,
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PropertyEnquiry', propertyEnquirySchema);
module.exports.PROPERTY_ENQUIRY_SUB_SOURCE = PROPERTY_ENQUIRY_SUB_SOURCE;
module.exports.CONTACT_OPTIONS = CONTACT_OPTIONS;
module.exports.CONTACT_TIMES = CONTACT_TIMES;
module.exports.MARKETING_CONSENT_VALUES = MARKETING_CONSENT_VALUES;
module.exports.MESSAGE_FORMAT_EXAMPLE = MESSAGE_FORMAT_EXAMPLE;
module.exports.MESSAGE_VALIDATION_ERROR = MESSAGE_VALIDATION_ERROR;
module.exports.isValidPropertyEnquiryMessage = isValidPropertyEnquiryMessage;
module.exports.isValidPropertyEnquiryEmail = isValidPropertyEnquiryEmail;
module.exports.isHeadOfficeValue = isHeadOfficeValue;
