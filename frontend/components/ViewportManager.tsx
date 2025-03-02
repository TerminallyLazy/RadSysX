"use client";

import { useState, lazy, Suspense, useEffect } from 'react';
import { DicomViewer } from './DicomViewer';
import { LoadedImage } from '@/lib/types';
import { Toggle } from './ui/Toggle';
import { Box, ImageIcon, Loader2, AlertTriangle, Info } from 'lucide-react';

// Error boundary fallback component for AdvancedViewer
function AdvancedViewerFallback({ onReset }: { onReset: () => void }) {
  return (
    <div className="w-full h-full flex items-center justify-center">
      <div className="flex flex-col items-center gap-2 p-6 max-w-md text-center">
        <AlertTriangle className="h-12 w-12 text-amber-500 mb-2" />
        <h3 className="text-lg font-semibold">3D Viewer Error</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          The 3D viewer could not be loaded. This may be due to browser compatibility issues or missing modules.
        </p>
        <button 
          onClick={onReset}
          className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors"
        >
          Switch to 2D View
        </button>
      </div>
    </div>
  );
}

// Component to display message for 2D images in non-axial views
function TwoDimensionalImageMessage() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/20 text-white">
      <div className="flex flex-col items-center p-4 max-w-[80%] text-center">
        <Info className="h-8 w-8 text-[#4cedff] mb-2" />
        <p className="font-medium">2D Image - View In Axial Plane</p>
        <p className="text-sm mt-2">This 2D image can only be viewed in the axial plane. Click the expand button in the axial view for a larger display.</p>
      </div>
    </div>
  );
}

// Dynamically import the AdvancedViewer to avoid server-side import issues
const AdvancedViewer = lazy(() => 
  import('./AdvancedViewer')
    .then(mod => ({ default: mod.AdvancedViewer }))
    .catch(err => {
      console.error('Failed to load AdvancedViewer:', err);
      // Return a dummy component on error that will trigger the error handler
      return { 
        default: ({ localFiles, onError }: { localFiles?: File[], onError?: () => void }) => {
          // Call the error handler after render if provided
          useEffect(() => {
            if (onError) onError();
          }, [onError]);
          
          return <AdvancedViewerFallback onReset={() => {}} />;
        }
      };
    })
);

// Add Tool type that matches the one in AdvancedViewer
type Tool =
  | "pan"
  | "zoom"
  | "distance"
  | "area"
  | "angle"
  | "profile"
  | "window"
  | "level"
  | "diagnose"
  | "statistics"
  | "segment"
  | "compare"
  | null;

interface ViewportManagerProps {
  loadedImages?: LoadedImage[];
  currentImageIndex: number;
  onActivate?: () => void;
  onToggleExpand?: () => void;
  isActive?: boolean;
  isExpanded?: boolean;
  viewportType: 'AXIAL' | 'SAGITTAL' | 'CORONAL';
  activeTool?: Tool; // Add activeTool prop
}

export function ViewportManager({
  loadedImages,
  currentImageIndex,
  onActivate,
  onToggleExpand,
  isActive,
  isExpanded,
  viewportType,
  activeTool
}: ViewportManagerProps) {
  const [useAdvancedViewer, setUseAdvancedViewer] = useState(false);
  const [imageLoadSuccess, setImageLoadSuccess] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [advancedViewerError, setAdvancedViewerError] = useState(false);
  const [is2DImage, setIs2DImage] = useState(false);

  // Get the current image ID from the loaded images
  const currentImageId = loadedImages?.[currentImageIndex]?.imageId;
  
  // Get the current image details for the advanced viewer
  const currentImage = loadedImages?.[currentImageIndex];
  
  // Function to determine if an image is 2D based on file format
  const is2DImageFormat = (image?: LoadedImage) => {
    if (!image) return false;
    
    // Check if it's a standard 2D image format
    const fileName = image.file.name.toLowerCase();
    const is2DFormat = fileName.endsWith('.png') || 
                       fileName.endsWith('.jpg') || 
                       fileName.endsWith('.jpeg') || 
                       fileName.endsWith('.gif') || 
                       fileName.endsWith('.bmp') ||
                       image.format === 'png' ||
                       image.format === 'jpg' ||
                       image.format === 'jpeg';
                       
    return is2DFormat;
  };
  
  // Function to determine if a DICOM file is a single-slice (2D) DICOM
  const isSingleSliceDicom = (image?: LoadedImage) => {
    if (!image) return false;
    
    const fileName = image.file.name.toLowerCase();
    const isDicom = fileName.endsWith('.dcm') || image.format === 'dicom';
    
    // Check if we have metadata that indicates single slice
    if (isDicom && image.metadata) {
      // Look for specific metadata properties that would indicate this is a single slice
      // This can vary by implementation, but common properties include:
      const possibleSingleSlice = 
        // If it specifically has number of frames = 1
        (image.metadata.numberOfFrames === 1) ||
        // Or if these 3D-specific properties are missing
        (!image.metadata.sliceThickness && !image.metadata.spacingBetweenSlices) ||
        // Or if the file size is relatively small (typical for single-slice DICOMs)
        (image.file.size < 1000000); // Less than 1MB is likely a single slice
      
      return possibleSingleSlice;
    }
    
    // If we don't have good metadata, default to checking if it's the only file
    // and it's relatively small in size (a heuristic)
    return isDicom && loadedImages?.length === 1 && image.file.size < 2000000; // 2MB threshold
  };
  
  // Check if we have DICOMDIR file or multiple DICOM files (which would work better in 3D)
  useEffect(() => {
    if (loadedImages && loadedImages.length > 0) {
      console.log(`ViewportManager: Evaluating ${loadedImages.length} loaded images for 3D viewer compatibility`);
      
      // Log file details to help with debugging
      loadedImages.forEach((img, index) => {
        console.log(`Image ${index + 1}: ${img.file.name}, type: ${img.format}, size: ${img.file.size} bytes`);
      });
      
      // Check if current image is a 2D format like PNG/JPG
      const currentIs2D = is2DImageFormat(loadedImages[currentImageIndex]);
      
      // Check if it's a single-slice DICOM
      const currentIsSingleSliceDicom = isSingleSliceDicom(loadedImages[currentImageIndex]);
      
      // Set is2DImage if either condition is true
      setIs2DImage(currentIs2D || currentIsSingleSliceDicom);
      
      console.log(`ViewportManager: Current image analysis - 
        Standard 2D format: ${currentIs2D}, 
        Single-slice DICOM: ${currentIsSingleSliceDicom}, 
        Treatment as 2D: ${currentIs2D || currentIsSingleSliceDicom},
        viewportType: ${viewportType}`);
      
      // If we have DICOMDIR or multiple DICOM files, always use 3D viewer
      // BUT exclude cases where we have a single-slice DICOM
      if (loadedImages.some(img => img.format === 'dicomdir') || 
          (loadedImages.length > 1 && loadedImages.some(img => 
            (img.file.name.toLowerCase().endsWith('.dcm') || img.format === 'dicom') && 
            !isSingleSliceDicom(img)))) {
        console.log('Using 3D viewer for DICOMDIR or multiple DICOM files');
        setUseAdvancedViewer(true);
        return;
      }
      
      // Check for DICOMDIR file
      if (loadedImages.some(img => 
        img.file.name.toUpperCase() === 'DICOMDIR' || 
        img.file.name.toUpperCase().endsWith('.DICOMDIR')
      )) {
        console.log('DICOMDIR file detected, using 3D viewer');
        setUseAdvancedViewer(true);
        return;
      }
      
      // For single file, check if it's DICOM (but not a single-slice DICOM)
      if (loadedImages.length === 1) {
        const file = loadedImages[0].file;
        if ((file.name.toLowerCase().endsWith('.dcm') || loadedImages[0].format === 'dicom') && 
            !currentIsSingleSliceDicom) {
          // Suggest 3D viewer for DICOM files (except single-slice ones)
          console.log('Single multi-slice DICOM file detected, suggesting 3D viewer');
          setUseAdvancedViewer(true);
        } else {
          // For PNG/JPG images or single-slice DICOM, use 2D viewer
          console.log('Standard image file or single-slice DICOM detected, using 2D viewer');
          setUseAdvancedViewer(false);
        }
      }
    } else {
      console.log('No images loaded, defaulting to 2D viewer');
      setUseAdvancedViewer(false);
      setIs2DImage(false);
    }
  }, [loadedImages, currentImageIndex, viewportType]);
  
  const handleImageLoaded = (success: boolean) => {
    setImageLoadSuccess(success);
    if (!success) {
      setLoadError('Failed to load image');
    } else {
      setLoadError(null);
    }
  };

  const handleAdvancedViewerError = () => {
    console.error('Advanced viewer error occurred - falling back to 2D viewer');
    setAdvancedViewerError(true);
    setUseAdvancedViewer(false);
    setLoadError('3D Viewer initialization failed. Switched to 2D viewer.');
    
    // Clear the error message after 5 seconds
    setTimeout(() => {
      setLoadError(null);
    }, 5000);
  };

  const isDisabled = !loadedImages?.length;
  
  // Determine whether to show this view based on 2D/3D and viewport type
  const shouldShowImage = !is2DImage || viewportType === 'AXIAL' || useAdvancedViewer;
  
  // Determine if we should suppress error messages (when intentionally not displaying in non-axial views)
  const shouldSuppressErrors = is2DImage && viewportType !== 'AXIAL' && !useAdvancedViewer;

  return (
    <div className="w-full h-full flex flex-col">
      <div className="absolute top-2 right-16 z-10">
        <div className="bg-[#f0f2f5]/80 dark:bg-[#2a3349]/80 backdrop-blur-sm rounded-md p-1.5 
                       flex items-center gap-2 border border-[#e4e7ec] dark:border-[#4a5583] shadow-md">
          <div className="text-xs font-medium text-[#334155] dark:text-[#e2e8f0] flex items-center gap-1.5">
            {useAdvancedViewer ? (
              <Box className="h-3.5 w-3.5 text-[#4cedff]" />
            ) : (
              <ImageIcon className="h-3.5 w-3.5" />
            )}
            <span>{useAdvancedViewer ? '3D' : '2D'}</span>
          </div>
          <Toggle
            checked={useAdvancedViewer}
            onCheckedChange={(checked) => {
              console.log(`User toggled to ${checked ? '3D' : '2D'} viewer`);
              
              // If switching to 3D, give a warning for non-DICOM files
              if (checked && loadedImages && loadedImages.length > 0) {
                const hasDicom = loadedImages.some(img => 
                  img.format === 'dicom' || 
                  img.file.name.toLowerCase().endsWith('.dcm')
                );
                
                if (!hasDicom) {
                  console.warn('Switching to 3D viewer with non-DICOM files - this may not work correctly');
                  setLoadError('Note: 3D viewer works best with DICOM files, not standard images');
                  
                  // Clear the message after 5 seconds
                  setTimeout(() => {
                    setLoadError(null);
                  }, 5000);
                }
              }
              
              setUseAdvancedViewer(checked);
            }}
            size="sm"
            disabled={isDisabled || advancedViewerError}
          />
        </div>
      </div>

      {/* Show 2D message for non-axial viewports when a 2D image is loaded */}
      {is2DImage && !useAdvancedViewer && viewportType !== 'AXIAL' ? (
        <>
          <TwoDimensionalImageMessage />
          {/* Add inline style to hide any error messages in this viewport */}
          <style jsx global>{`
            /* Aggressive error suppression for the "Failed to load image" message */
            div[style*="background-color: rgb(244, 67, 54)"],
            div[style*="color: rgb(211, 34, 20)"],
            div[style*="background-color: rgb(211, 34, 20)"] {
              display: none !important;
              opacity: 0 !important;
              visibility: hidden !important;
            }
          `}</style>
        </>
      ) : useAdvancedViewer ? (
        <div className="w-full h-full relative">
          <Suspense fallback={
            <div className="w-full h-full flex items-center justify-center">
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-8 w-8 animate-spin text-[#4cedff]" />
                <p className="text-sm text-gray-500 dark:text-gray-400">Loading 3D Viewer...</p>
              </div>
            </div>
          }>
            {advancedViewerError ? (
              <AdvancedViewerFallback onReset={() => setUseAdvancedViewer(false)} />
            ) : (
              <AdvancedViewer 
                localFiles={loadedImages?.map(img => img.file)}
                onError={handleAdvancedViewerError}
                activeTool={activeTool} 
                enableSync={true}
              />
            )}
          </Suspense>
        </div>
      ) : (
        <DicomViewer
          imageId={shouldShowImage ? currentImageId : undefined}
          viewportType={viewportType}
          isActive={isActive}
          isExpanded={isExpanded}
          onActivate={onActivate}
          onToggleExpand={onToggleExpand}
          onImageLoaded={handleImageLoaded}
          activeTool={activeTool} // Also pass the activeTool to DicomViewer for consistency
          suppressErrors={shouldSuppressErrors} // Add this prop to suppress errors in non-axial views for 2D images
        />
      )}

      {/* Only show error messages if they shouldn't be suppressed */}
      {loadError && !shouldSuppressErrors && (
        <div className="absolute bottom-2 left-2 px-2 py-1 text-xs font-medium rounded bg-red-500/90 text-white backdrop-blur-sm shadow-sm">
          {loadError}
        </div>
      )}
    </div>
  );
} 