import axios from 'axios';

interface OpenISearchParams {
  query?: string;
  n?: number;
  m?: number;
  at?: string;
  coll?: string;
  favor?: string;
  fields?: string;
  hmp?: string;
  it?: string;
  lic?: string;
  sp?: string;
  sub?: string;
  vid?: string;
}

interface OpenISearchResponse {
  total: number;
  count: number;
  start: number;
  results: Array<{
    imgId: string;
    imgUrl: string;
    title: string;
    abstract?: string;
    articleType?: string;
    collection?: string;
    license?: string;
    specialties?: string[];
  }>;
}

interface ImageSeriesParams {
  imgId: string;
  type?: string;  // 'dicom' | 'image' | 'video'
  viewerId?: string;
  format?: string; // 'png' | 'jpg' | 'gif' | 'dicom'
}

interface ImageSeriesResponse {
  seriesId: string;
  modality: string;
  imageCount: number;
  thumbnailUrl: string;
  seriesUrls: string[];
  format: string;
  metadata: {
    patientId?: string;
    studyDate?: string;
    modality?: string;
    seriesDescription?: string;
    imageFormat?: string;
    dimensions?: {
      width: number;
      height: number;
    };
    formats?: string[];
  };
}

const BASE_URL = 'https://openi.nlm.nih.gov/api/search';
const SERIES_URL = 'https://openi.nlm.nih.gov/api/series';

export async function searchOpenI(params: OpenISearchParams): Promise<OpenISearchResponse> {
  try {
    const response = await axios.get(BASE_URL, {
      params: {
        query: params.query,
        m: params.m || 10,
        n: params.n || 1,
        at: params.at,
        coll: params.coll,
        favor: params.favor,
        fields: params.fields,
        hmp: params.hmp,
        it: params.it,
        lic: params.lic,
        sp: params.sp,
        sub: params.sub,
        vid: params.vid
      }
    });

    return response.data;
  } catch (error) {
    console.error('Error searching OpenI:', error);
    throw new Error('Failed to search OpenI database');
  }
}

// Enhanced format detection function
async function determineImageFormat(url: string): Promise<string> {
  try {
    // First check file extension
    const extension = url.split('.').pop()?.toLowerCase();
    if (extension === 'dcm') return 'dicom';
    if (extension === 'png') return 'png';
    
    // If no clear extension, check content type
    const response = await axios.head(url);
    const rawContentType = response.headers['content-type'];
    const contentType = Array.isArray(rawContentType)
      ? rawContentType.join(';').toLowerCase()
      : String(rawContentType ?? '').toLowerCase();
    
    if (contentType.includes('application/dicom')) return 'dicom';
    if (contentType.includes('image/png')) return 'png';
    if (contentType.includes('image/jpeg')) return 'jpg';
    if (contentType.includes('image/gif')) return 'gif';
    
    // Additional DICOM detection - check for common DICOM headers
    try {
      const headerResponse = await axios.get(url, { 
        headers: { Range: 'bytes=0-127' },
        responseType: 'arraybuffer'
      });
      const buffer = Buffer.from(headerResponse.data);
      // Check for DICOM magic number (DICM at offset 128)
      if (buffer.length >= 132 && buffer.toString('ascii', 128, 132) === 'DICM') {
        return 'dicom';
      }
    } catch (err) {
      console.error('Error checking DICOM header:', err);
    }
    
    return 'unknown';
  } catch (error) {
    console.error('Error determining image format:', error);
    return 'unknown';
  }
}

// Enhanced viewer type determination
function determineViewerType(modality: string, format: string): string {
  const dicomModalities = ['CT', 'MR', 'XR', 'US', 'MG', 'CR', 'DX'];
  const videoModalities = ['US', 'XA'];
  
  // Explicit DICOM handling
  if (format === 'dicom' || (dicomModalities.includes(modality) && format !== 'png')) {
    return 'dicom';
  }
  
  // Explicit PNG handling
  if (format === 'png') {
    return 'image';
  }
  
  // Video content
  if (videoModalities.includes(modality)) {
    return 'video';
  }
  
  // Default image handling
  return 'image';
}

export async function getImageSeries(params: ImageSeriesParams): Promise<ImageSeriesResponse> {
  try {
    const response = await axios.get(`${SERIES_URL}/${params.imgId}`);
    const seriesData = response.data;

    // Determine format for each image in the series
    const imagePromises = seriesData.images.map(async (img: any) => {
      const format = params.format || await determineImageFormat(img.url);
      return {
        ...img,
        format,
        url: img.url
      };
    });

    const processedImages = await Promise.all(imagePromises);
    
    // Use the format of the first image as the series format
    const primaryFormat = processedImages[0]?.format || 'unknown';
    
    // Determine viewer type based on primary format and modality
    const viewerType = params.type || determineViewerType(seriesData.modality, primaryFormat);
    
    return {
      seriesId: seriesData.seriesId,
      modality: seriesData.modality,
      imageCount: processedImages.length,
      thumbnailUrl: seriesData.thumbnailUrl,
      seriesUrls: processedImages.map(img => img.url),
      format: primaryFormat,
      metadata: {
        patientId: seriesData.patientId,
        studyDate: seriesData.studyDate,
        modality: seriesData.modality,
        seriesDescription: seriesData.description,
        imageFormat: primaryFormat,
        dimensions: seriesData.images[0]?.dimensions,
        formats: processedImages.map(img => img.format) // Track format of each image
      }
    };
  } catch (error) {
    console.error('Error getting image series:', error);
    throw new Error('Failed to retrieve image series');
  }
}

// Function to be called by Gemini for image series
export async function handleImageSeries(params: string): Promise<string> {
  try {
    const seriesParams = JSON.parse(params) as ImageSeriesParams;
    const results = await getImageSeries(seriesParams);
    
    // Return formatted results for the viewer
    return JSON.stringify({
      type: 'viewer_command',
      action: 'load_series',
      data: results
    }, null, 2);
  } catch (error) {
    console.error('Error in handleImageSeries:', error);
    return JSON.stringify({ error: 'Failed to load image series' });
  }
}

// Function to be called by Gemini
export async function handleOpenISearch(params: string): Promise<string> {
  try {
    // Parse the params string into an object
    const searchParams = JSON.parse(params) as OpenISearchParams;
    
    // Perform the search
    const results = await searchOpenI(searchParams);
    
    // Format the results into a readable string
    const formattedResults = results.results.map(result => ({
      title: result.title,
      url: result.imgUrl,
      type: result.articleType,
      collection: result.collection,
      abstract: result.abstract
    }));

    return JSON.stringify(formattedResults, null, 2);
  } catch (error) {
    console.error('Error in handleOpenISearch:', error);
    return JSON.stringify({ error: 'Failed to search OpenI database' });
  }
}
