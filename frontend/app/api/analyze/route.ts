import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { writeFile, unlink } from 'fs/promises';
import { mkdirSync } from 'fs';
import { join } from 'path';
import * as dicomParser from 'dicom-parser';
import { getAppMode, getGeminiApiKey, isExperimentalImagingEnabled } from '@/lib/env';

// Ensure temp directory exists
const tempDir = join(process.cwd(), 'tmp');
try {
  mkdirSync(tempDir, { recursive: true });
} catch (error: any) {
  if (error.code !== 'EEXIST') {
    console.error('Error creating temp directory:', error);
  }
}

export async function POST(req: NextRequest) {
  if (!isExperimentalImagingEnabled()) {
    return NextResponse.json(
      {
        error: `The analyze route is disabled in ${getAppMode()} mode. Use the backend AI job API instead.`,
      },
      { status: 403 },
    );
  }

  try {
    // Initialize Gemini API inside the function to ensure env vars are loaded
    const genAI = new GoogleGenerativeAI(getGeminiApiKey());
    
    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    // Save file temporarily
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const tempPath = join(tempDir, `temp_${Date.now()}_${file.name}`);
    await writeFile(tempPath, buffer);

    let imageData;
    let dicomMetadata = null;

    // Check if it's a DICOM file
    if (file.name.toLowerCase().endsWith('.dcm') || file.type === 'application/dicom') {
      try {
        // Parse DICOM data
        const byteArray = new Uint8Array(bytes);
        const dataSet = dicomParser.parseDicom(byteArray);
        
        // Extract basic DICOM metadata
        dicomMetadata = {
          modality: dataSet.string('x00080060'),
          studyDate: dataSet.string('x00080020'),
          seriesNumber: dataSet.string('x00200011'),
          instanceNumber: dataSet.string('x00200013'),
          rows: dataSet.uint16('x00280010'),
          columns: dataSet.uint16('x00280011'),
          bitsAllocated: dataSet.uint16('x00280100'),
          bitsStored: dataSet.uint16('x00280101')
        };

        // For DICOM files, we need to convert the pixel data to a viewable format
        // For now, we'll use the raw pixel data as base64
        imageData = {
          inlineData: {
            data: buffer.toString('base64'),
            mimeType: 'application/dicom'
          }
        };
      } catch (error) {
        console.error('Error parsing DICOM:', error);
        throw new Error('Failed to parse DICOM file');
      }
    } else {
      // For non-DICOM images, use as is
      imageData = {
        inlineData: {
          data: buffer.toString('base64'),
          mimeType: file.type || 'application/octet-stream'
        }
      };
    }

    // Configure Gemini model
    const generationConfig = {
      temperature: 1,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 8192,
    };

    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash-exp",
      generationConfig,
    });

    // Create analysis prompt based on file type
    let prompt = "Please analyze this medical image in detail. Include:\n";
    if (dicomMetadata) {
      prompt += `DICOM Metadata:\n${JSON.stringify(dicomMetadata, null, 2)}\n\n`;
    }
    prompt += "1. Description of what you see\n";
    prompt += "2. Any notable findings or abnormalities\n";
    prompt += "3. Measurements and technical details if visible\n";
    prompt += "4. Potential diagnoses or areas of concern\n";
    prompt += "5. Quality of the image and any limitations in the analysis";

    // Get analysis from Gemini
    const result = await model.generateContent([imageData, prompt]);
    const response = await result.response;
    const text = response.text();

    // Parse the response into structured data
    const analysis = {
      description: extractSection(text, "Description"),
      findings: extractFindings(text),
      measurements: {
        ...extractMeasurements(text),
        ...(dicomMetadata ? {
          rows: dicomMetadata.rows,
          columns: dicomMetadata.columns,
          bitsAllocated: dicomMetadata.bitsAllocated,
          bitsStored: dicomMetadata.bitsStored
        } : {})
      },
      abnormalities: extractAbnormalities(text),
      metadata: dicomMetadata
    };

    // Clean up temporary file
    await unlink(tempPath).catch(console.error);

    return NextResponse.json(analysis);
  } catch (error) {
    console.error('Analysis error:', error);
    return NextResponse.json(
      { error: 'Failed to analyze image' },
      { status: 500 }
    );
  }
}

function extractSection(text: string, sectionName: string): string {
  const regex = new RegExp(`${sectionName}:?([^\\n]*(?:\\n(?!\\d\\.|[A-Z][a-z]+:)[^\\n]*)*)`, 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : '';
}

function extractFindings(text: string): string[] {
  const findings: string[] = [];
  const findingsSection = extractSection(text, "Findings") || extractSection(text, "Notable findings");
  if (findingsSection) {
    const lines = findingsSection.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.endsWith(':')) {
        findings.push(trimmed);
      }
    }
  }
  return findings;
}

function extractMeasurements(text: string): Record<string, number> {
  const measurements: Record<string, number> = {};
  const measurementsSection = extractSection(text, "Measurements") || extractSection(text, "Technical details");
  
  if (measurementsSection) {
    // Extract dimensions
    const dimensionsMatch = measurementsSection.match(/(\d+)\s*x\s*(\d+)/);
    if (dimensionsMatch) {
      measurements.width = parseInt(dimensionsMatch[1]);
      measurements.height = parseInt(dimensionsMatch[2]);
    }
    
    // Extract other numeric measurements
    const numericMatches = measurementsSection.matchAll(/(\d+(?:\.\d+)?)\s*(mm|cm|px)/g);
    for (const match of numericMatches) {
      const value = parseFloat(match[1]);
      const unit = match[2];
      measurements[`${unit}`] = value;
    }
  }
  
  return measurements;
}

function extractAbnormalities(text: string): string[] {
  const abnormalities: string[] = [];
  const abnormalitiesSection = extractSection(text, "Abnormalities") || 
                              extractSection(text, "Areas of concern");
  
  if (abnormalitiesSection) {
    const lines = abnormalitiesSection.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.endsWith(':')) {
        abnormalities.push(trimmed);
      }
    }
  }
  return abnormalities;
} 
