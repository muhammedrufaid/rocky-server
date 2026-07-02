const Factsheet = require('../models/Factsheet');
const { uploadFile, deleteFile } = require('../services/s3Service');
const { S3_FOLDERS } = require('../constants/s3');

async function uploadFactsheetPdf(file) {
  return uploadFile(file, S3_FOLDERS.PDFS);
}

async function removeFactsheetPdfFromS3(key) {
  if (!key) return;

  try {
    await deleteFile(key);
  } catch (error) {
    console.error('[S3] Failed to delete factsheet PDF:', error.message);
  }
}

const uploadFactsheet = async (req, res) => {
  let uploadedPdf;

  try {
    const fullName = (req.body?.fullName || '').trim();
    const uploaded = req.file;

    if (!fullName) {
      return res.status(400).json({
        success: false,
        message: 'Please provide fullName',
      });
    }

    if (!uploaded) {
      return res.status(400).json({
        success: false,
        message: "Please upload a PDF file using form-data key 'pdf'",
      });
    }

    uploadedPdf = await uploadFactsheetPdf(uploaded);

    if (!uploadedPdf.url) {
      throw new Error('PDF upload failed. Please try again.');
    }

    const factsheet = await Factsheet.create({
      fullName,
      fileUrl: uploadedPdf.url,
      fileName: uploaded.originalname || uploadedPdf.fileName,
    });

    return res.status(201).json({
      success: true,
      data: {
        id: factsheet._id,
        fullName: factsheet.fullName,
        fileUrl: factsheet.fileUrl,
        fileName: factsheet.fileName,
        createdAt: factsheet.createdAt,
      },
    });
  } catch (error) {
    if (uploadedPdf?.key) {
      await removeFactsheetPdfFromS3(uploadedPdf.key);
    }

    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

module.exports = {
  uploadFactsheet,
};
