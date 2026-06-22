const Factsheet = require('../models/Factsheet');

function getFactsheetFileMeta(uploaded, req) {
  const fileName =
    req.cvUploadMeta?.originalFileName || uploaded.originalname || 'factsheet.pdf';
  const fileUrl = uploaded.path;

  return { fileName, fileUrl };
}

const uploadFactsheet = async (req, res) => {
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

    const { fileName, fileUrl } = getFactsheetFileMeta(uploaded, req);

    if (!fileUrl) {
      return res.status(400).json({
        success: false,
        message: 'PDF upload failed. Please try again.',
      });
    }

    const factsheet = await Factsheet.create({
      fullName,
      fileUrl,
      fileName,
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
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error',
    });
  }
};

module.exports = {
  uploadFactsheet,
};
