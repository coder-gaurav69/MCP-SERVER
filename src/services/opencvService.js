import cv from '@techstark/opencv-js';
import { Jimp } from 'jimp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createServiceLogger } from './loggerService.js';

const log = createServiceLogger("opencv-service");

/**
 * OpenCV Vision Service — Mandatory preprocessing layer for all AI vision tasks.
 * Handles image normalization, region detection, and visual-to-DOM mapping.
 */
class OpencvService {
  constructor() {
    this._initialized = false;
  }

  async _ensureInitialized() {
    if (this._initialized) return;
    
    // cv is already a proxy/object in @techstark/opencv-js
    // We wait for it to be ready if it's not.
    if (cv.Mat) {
        this._initialized = true;
        return;
    }

    return new Promise((resolve) => {
      cv.onRuntimeInitialized = () => {
        this._initialized = true;
        log.info("OpenCV.js WASM runtime initialized");
        resolve();
      };
    });
  }

  /**
   * Convert a Buffer (PNG/JPG) to an OpenCV Mat.
   * @param {Buffer} buffer 
   * @returns {Promise<cv.Mat>}
   */
  async bufferToMat(buffer) {
    const image = await Jimp.read(buffer);
    const { width, height, data } = image.bitmap;
    const mat = new cv.Mat(height, width, cv.CV_8UC4);
    mat.data.set(data);
    return mat;
  }

  /**
   * Convert an OpenCV Mat to a PNG Buffer.
   * @param {cv.Mat} mat 
   * @returns {Promise<Buffer>}
   */
  async matToBuffer(mat) {
    // Convert to RGBA if needed
    let rgbaMat = new cv.Mat();
    if (mat.channels() === 1) {
      cv.cvtColor(mat, rgbaMat, cv.COLOR_GRAY2RGBA);
    } else if (mat.channels() === 3) {
      cv.cvtColor(mat, rgbaMat, cv.COLOR_RGB2RGBA);
    } else {
      rgbaMat = mat.clone();
    }

    const image = new Jimp({
      data: Buffer.from(rgbaMat.data),
      width: rgbaMat.cols,
      height: rgbaMat.rows
    });
    
    const buffer = await image.getBuffer(Jimp.MIME_PNG);
    rgbaMat.delete();
    return buffer;
  }

  /**
   * Main vision pipeline: Grayscale -> Blur -> Threshold -> Detect -> Cluster -> Crop
   * @param {Buffer} buffer - Original screenshot buffer
   * @returns {Promise<{croppedBuffer: Buffer, regions: Array, debugPath?: string}>}
   */
  async processScreenshot(buffer, options = {}) {
    await this._ensureInitialized();
    const startTime = Date.now();
    
    let src = await this.bufferToMat(buffer);
    let gray = new cv.Mat();
    let blurred = new cv.Mat();
    let thresh = new cv.Mat();
    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();

    try {
      // 1. Grayscale
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      // 2. Blur
      const ksize = new cv.Size(config.opencvBlurKernel, config.opencvBlurKernel);
      cv.GaussianBlur(gray, blurred, ksize, 0, 0, cv.BORDER_DEFAULT);

      // 3. Threshold (Adaptive or Simple)
      cv.threshold(blurred, thresh, config.opencvThreshold, config.opencvMaxThreshold, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

      // 4. Detect Rectangular Regions
      cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      const regions = [];
      for (let i = 0; i < contours.size(); ++i) {
        const contour = contours.get(i);
        const rect = cv.boundingRect(contour);
        
        // Filter small noise
        if (rect.width * rect.height > config.opencvMinRegionArea) {
          regions.push({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            area: rect.width * rect.height
          });
        }
      }

      // 5. Cluster Regions to Identify Main Form Area
      // Simple logic: Find the bounding box that encompasses the most "meaningful" regions
      let minX = src.cols, minY = src.rows, maxX = 0, maxY = 0;
      let formRegions = [];

      if (regions.length > 0) {
        // Sort by area and pick top candidates or use spatial clustering
        // For now, let's just find the bounding box of all detected regions
        regions.forEach(r => {
          minX = Math.min(minX, r.x);
          minY = Math.min(minY, r.y);
          maxX = Math.max(maxX, r.x + r.width);
          maxY = Math.max(maxY, r.y + r.height);
        });

        // Add some padding
        const padding = 20;
        minX = Math.max(0, minX - padding);
        minY = Math.max(0, minY - padding);
        maxX = Math.min(src.cols, maxX + padding);
        maxY = Math.min(src.rows, maxY + padding);
      } else {
        // Fallback to full image if no regions detected
        minX = 0; minY = 0; maxX = src.cols; maxY = src.rows;
      }

      const mainArea = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

      // 6. Crop
      let roi = src.roi(new cv.Rect(mainArea.x, mainArea.y, mainArea.width, mainArea.height));
      const croppedBuffer = await this.matToBuffer(roi);

      // 7. Debug Output
      let debugPath = null;
      if (config.opencvDebugEnabled) {
        debugPath = await this.saveDebugImages(src, thresh, regions, mainArea);
      }

      log.info("Vision pipeline complete", { 
        duration: `${Date.now() - startTime}ms`, 
        regionsFound: regions.length,
        originalSize: `${src.cols}x${src.rows}`,
        croppedSize: `${mainArea.width}x${mainArea.height}`
      });

      return {
        croppedBuffer,
        regions,
        mainArea,
        debugPath
      };

    } catch (err) {
      log.error("OpenCV processing failed", { error: err.message });
      throw err;
    } finally {
      // Cleanup
      src.delete(); gray.delete(); blurred.delete(); thresh.delete();
      contours.delete(); hierarchy.delete();
    }
  }

  /**
   * Save debug images to .mcp_data/temp/
   */
  async saveDebugImages(originalMat, processedMat, regions, mainArea) {
    const tempDir = path.join(config.mcpDataDir, "temp", "opencv_debug");
    await fs.mkdir(tempDir, { recursive: true });
    
    const timestamp = Date.now();
    const prefix = `vision-${timestamp}`;

    // Draw detected regions on a copy of original
    let visualMat = originalMat.clone();
    regions.forEach(r => {
      let point1 = new cv.Point(r.x, r.y);
      let point2 = new cv.Point(r.x + r.width, r.y + r.height);
      cv.rectangle(visualMat, point1, point2, [0, 255, 0, 255], 2);
    });

    // Draw main area (form)
    cv.rectangle(visualMat, 
      new cv.Point(mainArea.x, mainArea.y), 
      new cv.Point(mainArea.x + mainArea.width, mainArea.y + mainArea.height), 
      [255, 0, 0, 255], 3);

    const origPath = path.join(tempDir, `${prefix}-regions.png`);
    const procPath = path.join(tempDir, `${prefix}-processed.png`);

    await fs.writeFile(origPath, await this.matToBuffer(visualMat));
    await fs.writeFile(procPath, await this.matToBuffer(processedMat));

    visualMat.delete();
    return tempDir;
  }

  /**
   * Map OpenCV regions to DOM elements based on coordinate overlap.
   */
  mapRegionsToDom(regions, domElements) {
    return domElements.map(el => {
      const elBox = el.boundingBox || { x: 0, y: 0, width: 0, height: 0 };
      let bestOverlap = 0;
      
      regions.forEach(reg => {
        const overlap = this._calculateOverlap(elBox, reg);
        bestOverlap = Math.max(bestOverlap, overlap);
      });

      return {
        ...el,
        visualConfidence: bestOverlap
      };
    });
  }

  _calculateOverlap(rect1, rect2) {
    const xOverlap = Math.max(0, Math.min(rect1.x + rect1.width, rect2.x + rect2.width) - Math.max(rect1.x, rect2.x));
    const yOverlap = Math.max(0, Math.min(rect1.y + rect1.height, rect2.y + rect2.height) - Math.max(rect1.y, rect2.y));
    const overlapArea = xOverlap * yOverlap;
    const rect1Area = rect1.width * rect1.height;
    return rect1Area > 0 ? overlapArea / rect1Area : 0;
  }
}

export const opencvService = new OpencvService();
