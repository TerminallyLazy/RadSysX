"use client";

import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, AlertCircle } from 'lucide-react';
import { 
  initializeCornerstone3D, 
  createRenderingEngine,
  createViewport,
  createToolGroup,
  setToolActive,
  mapUiToolToCornerstone3D,
  loadAndDisplayImageStack,
  loadAndDisplayVolume,
  is2DImage,
  cleanupCornerstone3D,
  canLoadAsVolume,
  type UiToolType
} from '@/lib/utils/cornerstone3DInit';
import { RenderingEngine, Enums } from '@cornerstonejs/core';

// Use the UI tool type from the cornerstone3D initialization
type Tool = UiToolType;

interface DicomViewer3DProps {
  imageId?: string;
  imageIds?: string[];
  viewportType: 'AXIAL' | 'SAGITTAL' | 'CORONAL' | '3D';
  isActive?: boolean;
  isExpanded?: boolean;
  onActivate?: () => void;
  onToggleExpand?: () => void;
  onImageLoaded?: (success: boolean) => void;
  activeTool?: Tool;
  suppressErrors?: boolean;
}

/**
 * New DicomViewer component that uses Cornerstone3D instead of legacy Cornerstone
 * This component supports both 2D and 3D viewing capabilities.
 */
export function DicomViewer3D({ 
  imageId, 
  imageIds = [],
  viewportType = 'AXIAL', 
  isActive = false,
  isExpanded = false,
  onActivate,
  onToggleExpand,
  onImageLoaded,
  activeTool = 'pan',
  suppressErrors = false
}: DicomViewer3DProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const [isEnabled, setIsEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentTool, setCurrentTool] = useState<Tool>(activeTool);
  const [didAttemptLoading, setDidAttemptLoading] = useState(false);
  
  // Keep track of IDs for cleanup
  const renderingEngineId = useRef(`engine-${Date.now()}`);
  const toolGroupId = useRef(`toolgroup-${Date.now()}`);
  const viewportId = useRef(`viewport-${Date.now()}`);
  
  // Track if this is a 2D or 3D image
  const [is3D, setIs3D] = useState(false);
  
  const cleanImageId = (id: string): string => {
    // Remove any hash fragment from the blob URL
    const hashIndex = id.indexOf('#');
    return hashIndex !== -1 ? id.substring(0, hashIndex) : id;
  };
  
  // Process image IDs to ensure they're in the right format
  const processImageIds = (ids: string[]): string[] => {
    return ids.map(id => {
      // Process each ID to ensure proper format
      const parts = id.split('#');
      const actualImageId = parts[0];
      const filename = parts[1] || '';
      
      // Clean the actualImageId
      const cleanedId = cleanImageId(actualImageId);
      
      // Determine the final image id to load
      if (filename && filename.toLowerCase().endsWith('.dcm')) {
        // For DICOM files, explicitly use the wadouri scheme
        return `wadouri:${cleanedId}`;
      } else if (
        filename && 
        (filename.toLowerCase().endsWith('.png') || 
         filename.toLowerCase().endsWith('.jpg') || 
         filename.toLowerCase().endsWith('.jpeg'))
      ) {
        // For standard image formats
        return `imageLoader:${cleanedId}`;
      }
      
      // Return the cleaned ID as is if no specific format detected
      return cleanedId;
    });
  };
  
  // Initialize cornerstone on mount
  useEffect(() => {
    const initialize = async () => {
      try {
        await initializeCornerstone3D();
      } catch (error) {
        console.error('Error initializing Cornerstone3D:', error);
        setError('Failed to initialize Cornerstone3D');
        if (onImageLoaded) {
          onImageLoaded(false);
        }
      }
    };
    
    initialize();
    
    // Cleanup on unmount
    return () => {
      try {
        cleanupCornerstone3D(renderingEngineId.current, [toolGroupId.current]);
      } catch (err) {
        console.error('Error cleaning up Cornerstone3D resources:', err);
      }
    };
  }, []);
  
  // Effect to handle tool changes
  useEffect(() => {
    if (!isEnabled || !elementRef.current) return;
    if (activeTool === currentTool) return;
    
    try {
      console.log(`DicomViewer3D: Tool change requested from ${currentTool} to ${activeTool}`);
      
      // Map UI tool to Cornerstone3D tool
      const toolName = mapUiToolToCornerstone3D(activeTool);
      
      console.log(`DicomViewer3D: Mapped UI tool ${activeTool} to Cornerstone3D tool ${toolName}`);
      
      if (toolName) {
        setToolActive(toolGroupId.current, toolName, { mouseButton: 1 });
        setCurrentTool(activeTool);
        console.log(`DicomViewer3D: Successfully activated tool ${toolName}`);
      } else {
        console.warn(`DicomViewer3D: No valid tool name mapped for ${activeTool}, keeping current tool ${currentTool}`);
      }
    } catch (error) {
      console.error('DicomViewer3D: Error setting active tool:', error);
      // Try to fall back to a default tool
      try {
        const fallbackTool = 'pan';
        const fallbackToolName = mapUiToolToCornerstone3D(fallbackTool);
        setToolActive(toolGroupId.current, fallbackToolName, { mouseButton: 1 });
        setCurrentTool(fallbackTool);
        console.log(`DicomViewer3D: Fallback to tool ${fallbackToolName} after error`);
      } catch (fallbackError) {
        console.error('DicomViewer3D: Error setting fallback tool:', fallbackError);
      }
    }
  }, [activeTool, isEnabled, currentTool]);
  
  // Set up viewport and load images when ready
  useEffect(() => {
    if (!elementRef.current) return;
    
    // If we're suppressing errors for non-relevant views, don't initialize
    if (suppressErrors) {
      console.log('DicomViewer3D: Skipping initialization for suppressed view');
      if (onImageLoaded) {
        onImageLoaded(false);
      }
      return;
    }
    
    // Gather all image IDs to show
    let allImageIds: string[] = [];
    
    // If imageIds array is provided, use it
    if (imageIds && imageIds.length > 0) {
      allImageIds = imageIds;
    } 
    // Otherwise, use single imageId if provided
    else if (imageId) {
      allImageIds = [imageId];
    }
    
    if (allImageIds.length === 0) {
      console.log('DicomViewer3D: No images to display');
      setDidAttemptLoading(false);
      return;
    }
    
    // Process the image IDs to ensure they're in the correct format
    const processedImageIds = processImageIds(allImageIds);

    const setupViewport = async () => {
      setLoading(true);
      setError(null);
      setDidAttemptLoading(true);
      
      try {
        // Create a cornerstone rendering engine
        const renderingEngine = createRenderingEngine(renderingEngineId.current);
        
        // Determine viewport type based on the requested orientation
        let csViewportType: Enums.ViewportType;
        let orientation: Enums.OrientationAxis | undefined;
        
        // Handle different viewport orientations
        switch (viewportType) {
          case 'AXIAL':
            csViewportType = Enums.ViewportType.ORTHOGRAPHIC;
            orientation = Enums.OrientationAxis.AXIAL;
            break;
          case 'SAGITTAL':
            csViewportType = Enums.ViewportType.ORTHOGRAPHIC;
            orientation = Enums.OrientationAxis.SAGITTAL;
            break;
          case 'CORONAL':
            csViewportType = Enums.ViewportType.ORTHOGRAPHIC;
            orientation = Enums.OrientationAxis.CORONAL;
            break;
          case '3D':
            csViewportType = Enums.ViewportType.VOLUME_3D;
            orientation = undefined;
            break;
          default:
            csViewportType = Enums.ViewportType.STACK;
            orientation = undefined;
        }
        
        // FIXED: Use the canLoadAsVolume utility to safely determine if we can load as a volume
        // This prevents infinite recursion for single slices or incompatible data
        const canUseVolumeLoading = processedImageIds.length >= 3 && 
                                  await canLoadAsVolume(processedImageIds);
        
        if (!canUseVolumeLoading) {
          // Force stack mode for non-volume data
          console.log('DicomViewer3D: Cannot load as volume, using STACK viewport');
          csViewportType = Enums.ViewportType.STACK;
          orientation = undefined;
          setIs3D(false);
        } else {
          // Can use volume loading for this dataset
          console.log('DicomViewer3D: Can load as volume, using 3D viewport');
          setIs3D(true);
        }
        
        // Create the viewport
        const elementId = elementRef.current?.id || `element-${viewportId.current}`;
        if (elementRef.current && !elementRef.current.id) {
          // If element doesn't have an ID, set one
          elementRef.current.id = elementId;
        }
        
        const viewport = createViewport(
          renderingEngine,
          elementId,
          viewportId.current,
          csViewportType,
          {
            orientation,
            background: [0, 0, 0],
          }
        );
        
        // Create a tool group and add the viewport to it
        const toolGroup = createToolGroup(toolGroupId.current, [viewportId.current]);
        
        // Set the default tool active
        const defaultTool = activeTool || 'pan';
        const toolName = mapUiToolToCornerstone3D(defaultTool);
        if (toolName) {
          setToolActive(toolGroupId.current, toolName, { mouseButton: 1 });
          setCurrentTool(defaultTool);
        }
        
        // Load the image(s)
        if (csViewportType === Enums.ViewportType.STACK) {
          // Load as stack for 2D images
          await loadAndDisplayImageStack(
            elementRef.current!,
            processedImageIds,
            viewportId.current,
            renderingEngineId.current
          );
        } else {
          // Load as volume for 3D images
          const volumeId = `volume-${Date.now()}`;
          await loadAndDisplayVolume(
            elementRef.current!,
            processedImageIds,
            viewportId.current,
            volumeId,
            csViewportType,
            renderingEngineId.current
          );
        }
        
        console.log('DicomViewer3D: Successfully loaded and displayed images');
        setIsEnabled(true);
        setLoading(false);
        
        if (onImageLoaded) {
          onImageLoaded(true);
        }
      } catch (error) {
        console.error('DicomViewer3D: Error setting up viewport:', error);
        setError('Failed to load image');
        setLoading(false);
        
        if (onImageLoaded) {
          onImageLoaded(false);
        }
      }
    };
    
    setupViewport();
    
    // Cleanup function
    return () => {
      try {
        cleanupCornerstone3D(renderingEngineId.current, [toolGroupId.current]);
      } catch (err) {
        console.error('Error cleaning up Cornerstone3D resources:', err);
      }
    };
  }, [imageId, imageIds, viewportType, suppressErrors, onImageLoaded]);
  
  // Handle click to activate
  const handleActivate = () => {
    if (onActivate) {
      onActivate();
    }
  };
  
  // Handle toggle expand
  const handleToggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onToggleExpand) {
      onToggleExpand();
    }
  };
  
  return (
    <div 
      className={`viewport-panel ${isActive ? 'active' : ''}`}
      onClick={handleActivate}
    >
      <div className="viewport-label">
        {viewportType}
        {is3D ? ' (3D)' : ''}
      </div>
      
      {onToggleExpand && (
        <button
          className="viewport-expand-button"
          onClick={handleToggleExpand}
          aria-label={isExpanded ? "Minimize viewport" : "Expand viewport"}
        >
          {isExpanded ? (
            <Minimize2 className="w-4 h-4" />
          ) : (
            <Maximize2 className="w-4 h-4" />
          )}
        </button>
      )}
      
      <div 
        id={`element-${viewportId.current}`}
        ref={elementRef}
        className={`w-full h-full dicom-viewport relative ${suppressErrors ? 'cornerstone-error-suppressed' : ''}`}
        style={{ minHeight: '400px' }}
      />
      
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
      
      {!(imageId || imageIds.length > 0) && !loading && !error && !suppressErrors && !didAttemptLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 text-white">
          <div className="flex flex-col items-center p-4 max-w-[80%] text-center">
            <p className="font-medium">No image selected</p>
            <p className="text-sm mt-2">Load a series to view images in this viewport.</p>
          </div>
        </div>
      )}
      
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