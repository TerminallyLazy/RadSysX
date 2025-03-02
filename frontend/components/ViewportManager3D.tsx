"use client";

import React, { useState, useEffect } from 'react';
import { DicomViewer3D } from './DicomViewer3D';
import { Toggle } from '@/components/ui/Toggle';
import { Layers, Maximize, Minimize, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { UiToolType } from '@/lib/utils/cornerstone3DInit';

// Component to show when viewer has error
function ViewerFallback() {
  return (
    <div className="flex items-center justify-center h-full w-full bg-black/10 text-white p-4">
      <div className="flex flex-col items-center text-center max-w-md">
        <AlertCircle className="h-12 w-12 text-red-500 mb-4" />
        <h3 className="text-xl font-semibold mb-2">Viewport Error</h3>
        <p>There was a problem displaying this image. It may not be compatible with 3D viewing.</p>
      </div>
    </div>
  );
}

// Message when showing 2D image in non-axial view
function TwoDimensionalImageMessage() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white p-4 z-10">
      <div className="bg-gray-800 p-4 rounded-lg max-w-md text-center">
        <h3 className="font-medium mb-2">2D Image Notice</h3>
        <p className="text-sm">This is a 2D image which can only be viewed in axial plane.</p>
      </div>
    </div>
  );
}

// Match tools to the props expected by DicomViewer3D
type Tool = UiToolType;

interface ViewportManager3DProps {
  imageId?: string;
  imageIds?: string[];
  viewportType: 'AXIAL' | 'SAGITTAL' | 'CORONAL' | 'SERIES';
  className?: string;
  activeTool?: Tool;
  showTools?: boolean;
  onToolChange?: (tool: Tool) => void;
}

export function ViewportManager3D({
  imageId,
  imageIds = [],
  viewportType = 'AXIAL',
  className,
  activeTool = 'pan',
  showTools = true,
  onToolChange
}: ViewportManager3DProps) {
  // State for viewport configuration
  const [activeViewport, setActiveViewport] = useState<'AXIAL' | 'SAGITTAL' | 'CORONAL' | '3D'>('AXIAL');
  const [expandedViewport, setExpandedViewport] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);
  const [is2D, setIs2D] = useState(false);
  const [use3DViewer, setUse3DViewer] = useState(true);
  
  // Determine which image IDs to use
  const allImageIds = imageIds.length > 0 ? imageIds : imageId ? [imageId] : [];
  
  // Check if the viewport should be disabled
  const isDisabled = allImageIds.length === 0;

  // Effect to handle initial viewport type
  useEffect(() => {
    // Map SERIES to AXIAL as default view
    if (viewportType === 'SERIES') {
      setActiveViewport('AXIAL');
    } else {
      setActiveViewport(viewportType);
    }
  }, [viewportType]);
  
  // Check if we should show 2D image warning
  const showNonAxialWarning = is2D && activeViewport !== 'AXIAL';
  
  // Handle image load completion
  const handleImageLoaded = (success: boolean, is2DImage: boolean) => {
    setHasError(!success);
    setIs2D(is2DImage);
    
    // If this is a 2D image and we're not in AXIAL view, switch to AXIAL
    if (is2DImage && activeViewport !== 'AXIAL') {
      setActiveViewport('AXIAL');
    }
  };
  
  // Toggle 3D viewer
  const toggle3DViewer = () => {
    setUse3DViewer(!use3DViewer);
  };
  
  // Handle viewport activation
  const handleViewportActivate = (viewport: 'AXIAL' | 'SAGITTAL' | 'CORONAL' | '3D') => {
    setActiveViewport(viewport);
  };
  
  // Handle viewport expansion
  const handleToggleExpand = (viewport: 'AXIAL' | 'SAGITTAL' | 'CORONAL' | '3D') => {
    if (expandedViewport === viewport) {
      setExpandedViewport(null);
    } else {
      setExpandedViewport(viewport);
    }
  };
  
  // Determine if each viewport should be visible
  const isViewportVisible = (viewport: 'AXIAL' | 'SAGITTAL' | 'CORONAL' | '3D'): boolean => {
    if (expandedViewport) {
      return expandedViewport === viewport;
    }
    return true;
  };
  
  // Determine viewport size classes
  const getViewportClasses = (viewport: 'AXIAL' | 'SAGITTAL' | 'CORONAL' | '3D'): string => {
    if (expandedViewport) {
      return expandedViewport === viewport ? 'col-span-2 row-span-2' : 'hidden';
    }
    
    // Default layout (2x2 grid)
    return 'col-span-1 row-span-1';
  };
  
  return (
    <div className={cn("relative flex flex-col w-full h-full rounded-md overflow-hidden border", className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between p-2 bg-gray-900 text-white">
        <div className="flex items-center space-x-2">
          <Layers className="h-4 w-4" />
          <span className="text-sm font-medium">
            {expandedViewport ? `${expandedViewport} View` : '3D Viewer'}
          </span>
        </div>
        
        <div className="flex items-center space-x-2">
          {showTools && (
            <div className="flex items-center">
              <Toggle 
                checked={use3DViewer}
                onCheckedChange={setUse3DViewer}
                aria-label="Toggle 3D view"
                disabled={isDisabled}
              >
                <span className="text-xs mr-1">3D</span>
              </Toggle>
            </div>
          )}
          
          {expandedViewport && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpandedViewport(null)}
              className="p-1 h-7"
            >
              <Minimize className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      
      {/* ViewportContainer */}
      <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-1 p-1 bg-gray-800">
        {hasError ? (
          <ViewerFallback />
        ) : (
          <>
            {/* Axial Viewport */}
            {isViewportVisible('AXIAL') && (
              <div className={getViewportClasses('AXIAL')}>
                <DicomViewer3D
                  imageId={imageId}
                  imageIds={imageIds}
                  viewportType="AXIAL"
                  isActive={activeViewport === 'AXIAL'}
                  isExpanded={expandedViewport === 'AXIAL'}
                  onActivate={() => handleViewportActivate('AXIAL')}
                  onToggleExpand={() => handleToggleExpand('AXIAL')}
                  onImageLoaded={(success) => handleImageLoaded(success, false)}
                  activeTool={activeTool}
                />
              </div>
            )}
            
            {/* Sagittal Viewport */}
            {isViewportVisible('SAGITTAL') && (
              <div className={getViewportClasses('SAGITTAL')}>
                <DicomViewer3D
                  imageId={imageId}
                  imageIds={imageIds}
                  viewportType="SAGITTAL"
                  isActive={activeViewport === 'SAGITTAL'}
                  isExpanded={expandedViewport === 'SAGITTAL'}
                  onActivate={() => handleViewportActivate('SAGITTAL')}
                  onToggleExpand={() => handleToggleExpand('SAGITTAL')}
                  onImageLoaded={(success) => handleImageLoaded(success, false)}
                  activeTool={activeTool}
                  suppressErrors={is2D}
                />
                {showNonAxialWarning && activeViewport === 'SAGITTAL' && (
                  <TwoDimensionalImageMessage />
                )}
              </div>
            )}
            
            {/* Coronal Viewport */}
            {isViewportVisible('CORONAL') && (
              <div className={getViewportClasses('CORONAL')}>
                <DicomViewer3D
                  imageId={imageId}
                  imageIds={imageIds}
                  viewportType="CORONAL"
                  isActive={activeViewport === 'CORONAL'}
                  isExpanded={expandedViewport === 'CORONAL'}
                  onActivate={() => handleViewportActivate('CORONAL')}
                  onToggleExpand={() => handleToggleExpand('CORONAL')}
                  onImageLoaded={(success) => handleImageLoaded(success, false)}
                  activeTool={activeTool}
                  suppressErrors={is2D}
                />
                {showNonAxialWarning && activeViewport === 'CORONAL' && (
                  <TwoDimensionalImageMessage />
                )}
              </div>
            )}
            
            {/* 3D Viewport */}
            {isViewportVisible('3D') && use3DViewer && (
              <div className={getViewportClasses('3D')}>
                <DicomViewer3D
                  imageId={imageId}
                  imageIds={imageIds}
                  viewportType="3D"
                  isActive={activeViewport === '3D'}
                  isExpanded={expandedViewport === '3D'}
                  onActivate={() => handleViewportActivate('3D')}
                  onToggleExpand={() => handleToggleExpand('3D')}
                  onImageLoaded={(success) => handleImageLoaded(success, false)}
                  activeTool={activeTool}
                  suppressErrors={is2D}
                />
                {is2D && (
                  <TwoDimensionalImageMessage />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
} 