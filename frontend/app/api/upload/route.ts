import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { getAppMode, isExperimentalImagingEnabled } from '@/lib/env';

export async function POST(req: NextRequest) {
  if (!isExperimentalImagingEnabled()) {
    return NextResponse.json(
      {
        error: `The upload route is disabled in ${getAppMode()} mode. Route imaging ingest through the clinical archive gateway.`,
      },
      { status: 403 },
    );
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const format = formData.get('format') as string;
    const seriesId = formData.get('seriesId') as string;
    const metadata = JSON.parse(formData.get('metadata') as string);

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    // Create directories if they don't exist
    const uploadDir = join(process.cwd(), 'public', 'uploads', seriesId);
    await createDirIfNotExists(uploadDir);

    // Generate a safe filename
    const filename = generateSafeFilename(file.name);
    const filePath = join(uploadDir, filename);

    // Convert the file to a Buffer and save it
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    await writeFile(filePath, buffer);

    // Save metadata
    const metadataPath = join(uploadDir, `${filename}.json`);
    await writeFile(
      metadataPath,
      JSON.stringify({
        format,
        originalName: file.name,
        size: file.size,
        type: file.type,
        metadata,
        uploadedAt: new Date().toISOString()
      }, null, 2)
    );

    return NextResponse.json({
      success: true,
      path: `/uploads/${seriesId}/${filename}`,
      metadata: metadataPath
    });
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: 'Failed to upload file' },
      { status: 500 }
    );
  }
}

async function createDirIfNotExists(dir: string) {
  await mkdir(dir, { recursive: true });
}

function generateSafeFilename(originalName: string): string {
  // Remove unsafe characters and spaces
  const safeName = originalName
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '_');
  
  // Add timestamp to ensure uniqueness
  const timestamp = Date.now();
  const ext = safeName.split('.').pop();
  const base = safeName.slice(0, -(ext?.length ?? 0) - 1);
  
  return `${base}_${timestamp}.${ext}`;
} 
