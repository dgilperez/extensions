"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.modifyImage = exports.supportedImageContentTypeMap = exports.supportedContentTypes = exports.convertType = exports.resize = void 0;
const os = require("os");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const uuidv4_1 = require("uuidv4");
const config_1 = require("./config");
const logs = require("./logs");
function resize(file, size) {
    let height, width;
    if (size.indexOf(",") !== -1) {
        [width, height] = size.split(",");
    }
    else if (size.indexOf("x") !== -1) {
        [width, height] = size.split("x");
    }
    else {
        throw new Error("height and width are not delimited by a ',' or a 'x'");
    }
    return sharp(file, { failOnError: false, animated: config_1.default.animated })
        .rotate()
        .resize(parseInt(width, 10), parseInt(height, 10), {
        fit: "inside",
        withoutEnlargement: true,
    })
        .toBuffer();
}
exports.resize = resize;
function convertType(buffer, format) {
    if (format === "jpg" || format === "jpeg") {
        return sharp(buffer)
            .jpeg()
            .toBuffer();
    }
    if (format === "png") {
        return sharp(buffer)
            .png()
            .toBuffer();
    }
    if (format === "webp") {
        return sharp(buffer, { animated: config_1.default.animated })
            .webp()
            .toBuffer();
    }
    if (format === "tiff" || format === "tif") {
        return sharp(buffer)
            .tiff()
            .toBuffer();
    }
    if (format === "gif") {
        return sharp(buffer, { animated: config_1.default.animated })
            .gif()
            .toBuffer();
    }
    return buffer;
}
exports.convertType = convertType;
/**
 * Supported file types
 */
exports.supportedContentTypes = [
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/webp",
    "image/gif",
];
exports.supportedImageContentTypeMap = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    tif: "image/tif",
    tiff: "image/tiff",
    webp: "image/webp",
    gif: "image/gif",
};
const supportedExtensions = Object.keys(exports.supportedImageContentTypeMap).map((type) => `.${type}`);
exports.modifyImage = async ({ bucket, originalFile, fileDir, fileNameWithoutExtension, fileExtension, contentType, size, objectMetadata, format, }) => {
    const shouldFormatImage = format !== "false";
    const imageContentType = shouldFormatImage
        ? exports.supportedImageContentTypeMap[format]
        : contentType;
    const modifiedExtensionName = fileExtension && shouldFormatImage ? `.${format}` : fileExtension;
    let modifiedFileName;
    if (supportedExtensions.includes(fileExtension.toLowerCase())) {
        modifiedFileName = `${fileNameWithoutExtension}_${size}${modifiedExtensionName}`;
    }
    else {
        // Fixes https://github.com/firebase/extensions/issues/476
        modifiedFileName = `${fileNameWithoutExtension}${fileExtension}_${size}`;
    }
    // Path where modified image will be uploaded to in Storage.
    const modifiedFilePath = path.normalize(config_1.default.resizedImagesPath
        ? path.join(fileDir, config_1.default.resizedImagesPath, modifiedFileName)
        : path.join(fileDir, modifiedFileName));
    let modifiedFile;
    try {
        modifiedFile = path.join(os.tmpdir(), modifiedFileName);
        // filename\*=utf-8''  selects any string match the filename notation.
        // [^;\s]+ searches any following string until either a space or semi-colon.
        const contentDisposition = objectMetadata && objectMetadata.contentDisposition
            ? objectMetadata.contentDisposition.replace(/(filename\*=utf-8''[^;\s]+)/, `filename*=utf-8''${modifiedFileName}`)
            : "";
        // Cloud Storage files.
        const metadata = {
            contentDisposition,
            contentEncoding: objectMetadata.contentEncoding,
            contentLanguage: objectMetadata.contentLanguage,
            contentType: imageContentType,
            metadata: objectMetadata.metadata || {},
        };
        metadata.metadata.resizedImage = true;
        if (config_1.default.cacheControlHeader) {
            metadata.cacheControl = config_1.default.cacheControlHeader;
        }
        else {
            metadata.cacheControl = objectMetadata.cacheControl;
        }
        // If the original image has a download token, add a
        // new token to the image being resized #323
        if (metadata.metadata.firebaseStorageDownloadTokens) {
            metadata.metadata.firebaseStorageDownloadTokens = uuidv4_1.uuid();
        }
        // Generate a resized image buffer using Sharp.
        logs.imageResizing(modifiedFile, size);
        let modifiedImageBuffer = await resize(originalFile, size);
        logs.imageResized(modifiedFile);
        // Generate a converted image type buffer using Sharp.
        if (shouldFormatImage) {
            logs.imageConverting(fileExtension, format);
            modifiedImageBuffer = await convertType(modifiedImageBuffer, format);
            logs.imageConverted(format);
        }
        // Generate a image file using Sharp.
        await sharp(modifiedImageBuffer, { animated: config_1.default.animated }).toFile(modifiedFile);
        // Uploading the modified image.
        logs.imageUploading(modifiedFilePath);
        await bucket.upload(modifiedFile, {
            destination: modifiedFilePath,
            metadata,
        });
        logs.imageUploaded(modifiedFile);
        return { size, success: true };
    }
    catch (err) {
        logs.error(err);
        return { size, success: false };
    }
    finally {
        try {
            // Make sure the local resized file is cleaned up to free up disk space.
            if (modifiedFile) {
                logs.tempResizedFileDeleting(modifiedFilePath);
                fs.unlinkSync(modifiedFile);
                logs.tempResizedFileDeleted(modifiedFilePath);
            }
        }
        catch (err) {
            logs.errorDeleting(err);
        }
    }
};
