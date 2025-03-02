"use client";

import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, AlertCircle } from 'lucide-react';
import { 
  initializeCornerstone, 
  loadAndCacheImage, 
  displayImage, 
  enableElement, 
  disableElement,
  setActiveTools,
  mapUiToolToCornerstone,
  type UiToolType
} from '@/lib/utils/cornerstoneInit';
import { setupImageStack } from '@/lib/utils/createImageIdsAndCacheMetaData';

// Update Tool type to use UiToolType
type Tool = UiToolType;

interface DicomViewerProps {
  imageId?: string;
  viewportType: 'AXIAL' | 'SAGITTAL' | 'CORONAL';
  isActive?: boolean;
  isExpanded?: boolean;
  onActivate?: () => void;
  onToggleExpand?: () => void;
  onImageLoaded?: (success: boolean) => void;
  activeTool?: Tool; // Add activeTool prop
  suppressErrors?: boolean; // Add suppressErrors prop
}

const cleanImageId = (imageId: string): string => {
  // Remove any hash fragment from the blob URL
  const hashIndex = imageId.indexOf('#');
  return hashIndex !== -1 ? imageId.substring(0, hashIndex) : imageId;
};

export function DicomViewer({ 
  imageId, 
  viewportType, 
  isActive,
  isExpanded,
  onActivate,
  onToggleExpand,
  onImageLoaded,
  activeTool = null,
  suppressErrors = false
}: DicomViewerProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const [isEnabled, setIsEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentTool, setCurrentTool] = useState<Tool>(null);
  const [didAttemptLoading, setDidAttemptLoading] = useState(false);

  // Initialize cornerstone on mount
  useEffect(() => {
    initializeCornerstone();
  }, []);

  // Effect to handle tool changes
  useEffect(() => {
    if (!isEnabled || !elementRef.current) return;
    if (activeTool === currentTool) return;
    
    try {
      console.log(`DicomViewer: Tool change requested from ${currentTool} to ${activeTool}`);
      
      // Use our mapping function to get the appropriate tool name
      const toolNames = mapUiToolToCornerstone(activeTool);
      const toolName = toolNames.cornerstone2D; // Use the 2D version for this viewer
      
      console.log(`DicomViewer: Mapped UI tool ${activeTool} to Cornerstone tool ${toolName}`);
      
      if (toolName) {
        setActiveTools(toolName, { mouseButtonMask: 1 });
        setCurrentTool(activeTool);
        console.log(`DicomViewer: Successfully activated tool ${toolName}`);
      } else {
        console.warn(`DicomViewer: No valid tool name mapped for ${activeTool}, keeping current tool ${currentTool}`);
      }
    } catch (error) {
      console.error('DicomViewer: Error setting active tool:', error);
      // Keep the current tool in case of error
      if (currentTool) {
        try {
          const fallbackToolNames = mapUiToolToCornerstone(currentTool);
          setActiveTools(fallbackToolNames.cornerstone2D, { mouseButtonMask: 1 });
          console.log(`DicomViewer: Fallback to previous tool ${currentTool} after error`);
        } catch (fallbackError) {
          console.error('DicomViewer: Error setting fallback tool, defaulting to Pan', fallbackError);
          setActiveTools('Pan', { mouseButtonMask: 1 });
        }
      } else {
        // If no current tool, default to Pan
        setActiveTools('Pan', { mouseButtonMask: 1 });
      }
    }
  }, [activeTool, isEnabled, currentTool]);

  useEffect(() => {
    if (!elementRef.current) return;

    // If we're suppressing errors (non-axial 2D content), don't initialize cornerstone 
    if (suppressErrors) {
      console.log('DicomViewer: Skipping cornerstone initialization for suppressed view');
      if (onImageLoaded) {
        onImageLoaded(false);
      }
      return;
    }

    try {
      // Enable the element for cornerstone
      enableElement(elementRef.current);
      setIsEnabled(true);
      setError(null);
      
      // Set default tool
      setActiveTools('Pan', { mouseButtonMask: 1 });
      
      // If we have an initialTool, set it
      if (activeTool) {
        setCurrentTool(activeTool);
      }

      // Return cleanup function
      return () => {
        try {
          disableElement(elementRef.current!);
          setIsEnabled(false);
        } catch (err) {
          console.error('Error disabling cornerstone element:', err);
        }
      };
    } catch (err) {
      console.error('Error enabling cornerstone element:', err);
      setError('Failed to initialize viewer');
      setIsEnabled(false);
      if (onImageLoaded) {
        onImageLoaded(false);
      }
    }
  }, [activeTool, onImageLoaded, suppressErrors]);

  useEffect(() => {
    if (!elementRef.current || !isEnabled || !imageId) {
      if (!imageId) {
        console.log('DicomViewer: No imageId provided');
      }
      setDidAttemptLoading(false);
      return;
    }

    // Skip loading attempt if suppressErrors is true (for 2D images in non-axial views)
    if (suppressErrors) {
      console.log('DicomViewer: Suppressing image loading attempt for non-axial 2D content');
      setDidAttemptLoading(false);
      return;
    }

    const loadAndDisplayImage = async () => {
      setLoading(true);
      setError(null);
      setDidAttemptLoading(true);
      
      try {
        console.log('DicomViewer: Attempting to load image with ID:', imageId);
        
        const parts = imageId.split('#');
        const actualImageId = parts[0];
        const filename = parts[1] || '';
        
        // Clean the actualImageId
        const cleanedId = cleanImageId(actualImageId);
        
        // Determine the final image id to load
        let finalImageId = cleanedId;
        if (filename && filename.toLowerCase().endsWith('.dcm')) {
          // For DICOM files, explicitly use the wadouri scheme
          finalImageId = `wadouri:${cleanedId}`;
        }
        
        // Log the final image id
        console.log('DicomViewer: Final imageId after cleaning and prefixing if needed:', finalImageId);
        
        // Determine if this is a PNG or other standard image format
        const isPngOrJpg = filename && 
          (filename.toLowerCase().endsWith('.png') || 
           filename.toLowerCase().endsWith('.jpg') || 
           filename.toLowerCase().endsWith('.jpeg'));
        
        // Add more detailed logging about the format
        if (filename) {
          const ext = filename.split('.').pop()?.toLowerCase();
          console.log(`DicomViewer: File appears to be a ${ext} file`);
        }
        
        // First try directly loading with the full imageId (which has format information)
        console.log('DicomViewer: Calling loadAndCacheImage with:', finalImageId);
        try {
          const image = await loadAndCacheImage(finalImageId);
          console.log('DicomViewer: Image loaded successfully:', image);
          
          if (elementRef.current) {
            displayImage(elementRef.current, image);
            
            // Set the default tool
            setActiveTools('Pan');
            
            // Set up stack for segmentation tools
            await setupImageStack(elementRef.current, [finalImageId]);
            
            console.log('DicomViewer: Image displayed');
            onImageLoaded?.(true);
          } else {
            console.error('DicomViewer: Element reference lost during image loading');
            setError('Viewer element not available');
            onImageLoaded?.(false);
          }
        } catch (loadError) {
          console.error('DicomViewer: First load attempt failed, trying with URL only:', loadError);
          
          // For PNG/JPG files, try with pngimage: prefix explicitly
          if (isPngOrJpg) {
            try {
              const pngImageId = `pngimage:${actualImageId}`;
              console.log('DicomViewer: Trying with explicit pngimage prefix:', pngImageId);
              
              const image = await loadAndCacheImage(pngImageId);
              if (elementRef.current) {
                displayImage(elementRef.current, image);
                setActiveTools('Pan');
                
                // Set up stack for segmentation tools
                await setupImageStack(elementRef.current, [pngImageId]);
                
                console.log('DicomViewer: PNG image displayed successfully with explicit prefix');
                onImageLoaded?.(true);
                return;
              }
            } catch (pngError) {
              console.error('DicomViewer: PNG-specific load attempt failed:', pngError);
            }
          }
          
          // If PNG-specific approach failed or this isn't a PNG, try with just the URL
          try {
            const image = await loadAndCacheImage(actualImageId);
            console.log('DicomViewer: Second attempt successful:', image);
            
            if (elementRef.current) {
              displayImage(elementRef.current, image);
              
              // Set the default tool
              setActiveTools('Pan');
              
              // Set up stack for segmentation tools
              await setupImageStack(elementRef.current, [actualImageId]);
              
              console.log('DicomViewer: Image displayed');
              onImageLoaded?.(true);
            }
          } catch (finalError) {
            console.error('DicomViewer: Both load attempts failed:', finalError);
            throw finalError;
          }
        }
      } catch (error) {
        console.error('DicomViewer: Error loading image:', error);
        setError('Failed to load image');
        onImageLoaded?.(false);
      } finally {
        setLoading(false);
      }
    };

    loadAndDisplayImage();
  }, [imageId, isEnabled, onImageLoaded, suppressErrors]);

  return (
    <div 
      className={`viewport-panel ${isActive ? 'active' : ''}`}
      onClick={onActivate}
    >
      <div className="viewport-label">
        {viewportType}
      </div>
      <button
        className="viewport-expand-button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleExpand?.();
        }}
        aria-label={isExpanded ? "Minimize viewport" : "Expand viewport"}
      >
        {isExpanded ? (
          <Minimize2 className="w-4 h-4" />
        ) : (
          <Maximize2 className="w-4 h-4" />
        )}
      </button>
      
      <div 
        ref={elementRef}
        className={`w-full h-full dicom-viewport relative ${suppressErrors ? 'cornerstone-error-suppressed' : ''}`}
        style={{ minHeight: '400px' }}
      >
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-white">
            <div className="flex flex-col items-center">
              <div className="animate-spin h-8 w-8 border-4 border-t-transparent border-[#4cedff] rounded-full mb-2"></div>
              <p>Loading image...</p>
            </div>
          </div>
        )}
        
        {error && !loading && !suppressErrors && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white">
            <div className="flex flex-col items-center p-4 max-w-[80%] text-center">
              <AlertCircle className="h-8 w-8 text-red-500 mb-2" />
              <p className="font-medium">{error}</p>
              <p className="text-sm mt-2">Try uploading the image again or check file format compatibility.</p>
            </div>
          </div>
        )}

        {!imageId && !loading && !error && !suppressErrors && !didAttemptLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 text-white">
            <div className="flex flex-col items-center p-4 max-w-[80%] text-center">
              <p className="font-medium">No image selected</p>
              <p className="text-sm mt-2">Load a series to view images in this viewport.</p>
            </div>
          </div>
        )}
      </div>
      <div className="viewport-gradient" />
      
      {suppressErrors && (
        <style jsx>{`
          .cornerstone-error-suppressed .cornerstone-canvas-error,
          .cornerstone-error-suppressed .cornerstone-errored,
          .cornerstone-error-suppressed [class*='error'] {
            display: none !important;
          }
        `}</style>
      )}
    </div>
  );
} 