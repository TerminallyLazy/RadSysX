import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight, ScanLine } from 'lucide-react';
import * as cornerstone from 'cornerstone-core';
import { createImageIdsFromLocalFiles } from '@/lib/utils/createImageIdsAndCacheMetaData';

// Type augmentation for cornerstone to suppress TypeScript errors
interface CornerstoneExtended {
  imageCache: {
    getImageLoadObject: (imageId: string) => { image: any };
  };
  loadAndCacheImage: (imageId: string) => Promise<any>;
  resize: (element: HTMLElement) => void;
}

// Cast cornerstone to include the extended properties
const cornerstoneExt = cornerstone as unknown as CornerstoneExtended;

// Define anatomical plane types
export type AnatomicalPlane = 'AXIAL' | 'SAGITTAL' | 'CORONAL';

interface DicomSeriesPlayerProps {
  files: File[];
  className?: string;
  onFrameChange?: (frameIndex: number, totalFrames: number) => void;
  onPlanesReady?: (planes: Record<AnatomicalPlane, boolean>) => void;
  preferredPlane?: AnatomicalPlane;
  isActive?: boolean;
  disableUIControls?: boolean;
}

export function DicomSeriesPlayer({ 
  files, 
  className, 
  onFrameChange, 
  onPlanesReady,
  preferredPlane = 'AXIAL',
  isActive = true,
  disableUIControls = false
}: DicomSeriesPlayerProps) {
  const [imageIds, setImageIds] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [fps, setFps] = useState(5); // Frames per second
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPlane, setCurrentPlane] = useState<AnatomicalPlane>(preferredPlane);
  const [availablePlanes, setAvailablePlanes] = useState<Record<AnatomicalPlane, boolean>>({
    AXIAL: true,
    SAGITTAL: false,
    CORONAL: false
  });
  
  // References for organizing DICOM images by plane
  const planeImagesRef = useRef<Record<AnatomicalPlane, string[]>>({
    AXIAL: [],
    SAGITTAL: [],
    CORONAL: []
  });
  
  const viewportRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const loadedImagesRef = useRef<Set<number>>(new Set());
  const imageMetadataRef = useRef<Record<string, any>>({});
  
  // Initialize the component with the provided files
  useEffect(() => {
    const initializeViewer = async () => {
      try {
        setIsLoading(true);
        setError(null);
        
        if (!files || files.length === 0) {
          setError('No files provided');
          setIsLoading(false);
          return;
        }
        
        console.log(`DicomSeriesPlayer: Initializing with ${files.length} files`);
        
        // Check if we have a DICOMDIR file
        const dicomdirFile = files.find(file => 
          file.name.toUpperCase() === 'DICOMDIR' || 
          file.name.toUpperCase().endsWith('.DICOMDIR')
        );
        
        // Generate image IDs from the files
        const ids = await createImageIdsFromLocalFiles(files);
        
        if (ids.length === 0) {
          setError('No valid DICOM images found');
          setIsLoading(false);
          return;
        }
        
        console.log(`DicomSeriesPlayer: Created ${ids.length} image IDs`);
        setImageIds(ids);
        
        // Enable the cornerstone element
        if (viewportRef.current) {
          cornerstone.enable(viewportRef.current);
          
          // Load and analyze all images to determine their anatomical planes
          await analyzeAndOrganizeByPlane(ids);
          
          // Load the first image
          await loadAndDisplayImage(ids[0], viewportRef.current);
          loadedImagesRef.current.add(0);
          
          // Preload the next few images
          preloadImages(ids, 0, 5);
        }
        
        setIsLoading(false);
        
        // Notify about the initial frame
        if (onFrameChange) {
          onFrameChange(0, ids.length);
        }
      } catch (err: unknown) {
        console.error('Error initializing DicomSeriesPlayer:', err);
        setError('Failed to initialize viewer');
        setIsLoading(false);
      }
    };
    
    initializeViewer();
    
    // Clean up on unmount
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      
      // Disable cornerstone element
      if (viewportRef.current) {
        try {
          cornerstone.disable(viewportRef.current);
        } catch (error) {
          console.warn('Error disabling cornerstone element:', error);
        }
      }
      
      // Clean up image URLs
      imageIds.forEach(imageId => {
        try {
          const urlMatch = imageId.match(/^wadouri:(.+)#/);
          if (urlMatch && urlMatch[1]) {
            URL.revokeObjectURL(urlMatch[1]);
          }
        } catch (e) {
          console.warn('Error revoking URL:', e);
        }
      });
    };
  }, [files]);
  
  // Analyze all DICOM images and organize them by anatomical plane
  const analyzeAndOrganizeByPlane = async (imageIds: string[]) => {
    const planeImages: Record<AnatomicalPlane, string[]> = {
      AXIAL: [],
      SAGITTAL: [],
      CORONAL: []
    };
    
    // We'll collect all images and their metadata for analysis
    const imageMetadata: Array<{ id: string; metadata: any; position?: number[] }> = [];
    
    try {
      // First, load all images and collect metadata
      for (let i = 0; i < imageIds.length; i++) {
        try {
          // Load the image to get its metadata
          const image = await cornerstoneExt.loadAndCacheImage(imageIds[i]);
          const metadata = image.data;
          
          // Store metadata for later use
          imageMetadataRef.current[imageIds[i]] = metadata;
          
          // Extract position information for sorting
          const imagePosition = metadata?.imagePositionPatient || 
                               metadata?.ImagePositionPatient;
          
          imageMetadata.push({
            id: imageIds[i],
            metadata,
            position: imagePosition
          });
        } catch (error) {
          console.warn(`Error loading metadata for image ${i}:`, error);
        }
      }
      
      // If we have enough images, try to determine planes
      if (imageIds.length >= 2) {
        // First, try to detect planes using orientation vectors
        let planesDetermined = false;
        
        // Group images by their orientations if available
        const orientationGroups: Record<string, string[]> = {};
        
        for (const { id, metadata } of imageMetadata) {
          if (!metadata) continue;
          
          const imageOrientation = metadata.imageOrientationPatient || 
                                 metadata.ImageOrientationPatient;
          
          if (imageOrientation && imageOrientation.length === 6) {
            // Create an orientation key (simplified for grouping)
            // We round to 1 decimal place to group similar orientations
            const orientKey = imageOrientation
              .map((v: number) => Math.round(v * 10) / 10)
              .join(',');
            
            if (!orientationGroups[orientKey]) {
              orientationGroups[orientKey] = [];
            }
            
            orientationGroups[orientKey].push(id);
          }
        }
        
        // Now analyze each orientation group to determine its plane
        for (const orientKey in orientationGroups) {
          const groupIds = orientationGroups[orientKey];
          if (groupIds.length === 0) continue;
          
          // Get orientation from the first image in this group
          const firstId = groupIds[0];
          const metadata = imageMetadataRef.current[firstId];
          
          if (!metadata) continue;
          
          const imageOrientation = metadata.imageOrientationPatient || 
                                 metadata.ImageOrientationPatient;
          
          if (imageOrientation && imageOrientation.length === 6) {
            // Extract orientation vectors
            const rowVector = imageOrientation.slice(0, 3);
            const colVector = imageOrientation.slice(3, 6);
            
            // Calculate the normal vector (cross product)
            const normalVector = [
              rowVector[1] * colVector[2] - rowVector[2] * colVector[1],
              rowVector[2] * colVector[0] - rowVector[0] * colVector[2],
              rowVector[0] * colVector[1] - rowVector[1] * colVector[0]
            ];
            
            // Find the largest component of the normal vector
            const absNormal = normalVector.map(Math.abs);
            const maxIndex = absNormal.indexOf(Math.max(...absNormal));
            
            // Determine plane based on the largest component
            let targetPlane: AnatomicalPlane = 'AXIAL';
            if (maxIndex === 0) {
              targetPlane = 'SAGITTAL';
            } else if (maxIndex === 1) {
              targetPlane = 'CORONAL';
            } else {
              targetPlane = 'AXIAL';
            }
            
            // Sort the images in this group by position if available
            if (targetPlane && groupIds.length > 1) {
              const groupWithPositions = groupIds.map(id => {
                const meta = imageMetadataRef.current[id];
                const position = meta?.imagePositionPatient || meta?.ImagePositionPatient;
                return { id, position };
              });
              
              // If we have position information, sort by position along the normal vector axis
              if (groupWithPositions.some(item => item.position)) {
                groupWithPositions.sort((a, b) => {
                  if (!a.position) return 1;
                  if (!b.position) return -1;
                  
                  // Compare positions along the primary axis for this plane
                  return a.position[maxIndex] - b.position[maxIndex];
                });
                
                // Add the sorted IDs to the appropriate plane
                planeImages[targetPlane] = groupWithPositions.map(item => item.id);
                planesDetermined = true;
              } else {
                // If no position info, just add unsorted
                planeImages[targetPlane] = [...planeImages[targetPlane], ...groupIds];
                planesDetermined = true;
              }
            } else {
              // Single image or couldn't sort - add to the plane
              planeImages[targetPlane] = [...planeImages[targetPlane], ...groupIds];
              planesDetermined = true;
            }
          }
        }
        
        // If we couldn't determine planes from orientation, try other methods
        if (!planesDetermined) {
          // Fallback 1: Try to detect from series description
          for (const { id, metadata } of imageMetadata) {
            if (!metadata) continue;
            
            const seriesDescription = metadata.seriesDescription || 
                                    metadata.SeriesDescription || '';
            
            const descLower = seriesDescription.toLowerCase();
            if (descLower.includes('sag') || descLower.includes('sagittal')) {
              planeImages.SAGITTAL.push(id);
              planesDetermined = true;
            } else if (descLower.includes('cor') || descLower.includes('coronal')) {
              planeImages.CORONAL.push(id);
              planesDetermined = true;
            } else if (descLower.includes('ax') || descLower.includes('axial') || 
                    descLower.includes('tra') || descLower.includes('transverse')) {
              planeImages.AXIAL.push(id);
              planesDetermined = true;
            }
          }
          
          // Fallback 2: If still no planes, try to make educated guesses
          if (!planesDetermined && imageIds.length >= 3) {
            // Assume the most common scenario: axial series
            planeImages.AXIAL = [...imageIds];
            
            // Try to construct approximate coronal and sagittal views
            // For simplicity, we'll just use the same images
            // In a real application, these would be reconstructed from the volume
            planeImages.SAGITTAL = [...imageIds];
            planeImages.CORONAL = [...imageIds];
            planesDetermined = true;
          }
        }
      }
      
      // If all attempts failed or we have too few images, put all in AXIAL
      if (planeImages.AXIAL.length === 0 && 
          planeImages.SAGITTAL.length === 0 && 
          planeImages.CORONAL.length === 0) {
        planeImages.AXIAL = [...imageIds];
      }
      
      // Set available planes based on whether we have images for each
      const available = {
        AXIAL: planeImages.AXIAL.length > 0,
        SAGITTAL: planeImages.SAGITTAL.length > 0,
        CORONAL: planeImages.CORONAL.length > 0
      };
      
      setAvailablePlanes(available);
      planeImagesRef.current = planeImages;
      
      // Notify parent about available planes
      if (onPlanesReady) {
        onPlanesReady(available);
      }
      
      console.log('DicomSeriesPlayer: Planes organized:', {
        AXIAL: planeImages.AXIAL.length,
        SAGITTAL: planeImages.SAGITTAL.length,
        CORONAL: planeImages.CORONAL.length
      });
      
      // Set the current images based on the preferred plane
      changePlane(preferredPlane, false);
    } catch (error) {
      console.error('Error organizing planes:', error);
      // Keep all images in AXIAL as fallback
      planeImages.AXIAL = [...imageIds];
      
      // Set available planes
      setAvailablePlanes({
        AXIAL: true,
        SAGITTAL: false,
        CORONAL: false
      });
      
      planeImagesRef.current = planeImages;
      changePlane('AXIAL', false);
    }
  };
  
  // Change the current anatomical plane
  const changePlane = (plane: AnatomicalPlane, resetPlayback = true) => {
    if (resetPlayback && isPlaying) {
      setIsPlaying(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    
    setCurrentPlane(plane);
    
    // Update image IDs to the selected plane
    const planeIds = planeImagesRef.current[plane];
    if (planeIds && planeIds.length > 0) {
      setImageIds(planeIds);
      setCurrentIndex(0);
      
      // Load and display the first image of this plane
      if (viewportRef.current) {
        loadAndDisplayImage(planeIds[0], viewportRef.current)
          .then(() => {
            loadedImagesRef.current = new Set([0]);
            preloadImages(planeIds, 0, 5);
            
            if (onFrameChange) {
              onFrameChange(0, planeIds.length);
            }
          })
          .catch(err => {
            console.error(`Error loading first image of ${plane} plane:`, err);
          });
      }
    } else {
      console.warn(`No images available for ${plane} plane`);
    }
  };
  
  // Handle play/pause
  useEffect(() => {
    if (isPlaying) {
      timerRef.current = setInterval(() => {
        setCurrentIndex(prev => {
          const nextIndex = (prev + 1) % imageIds.length;
          updateCurrentImage(nextIndex);
          return nextIndex;
        });
      }, 1000 / fps);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isPlaying, fps, imageIds.length]);
  
  // Update the displayed image when the current index changes
  const updateCurrentImage = (index: number) => {
    if (!viewportRef.current || imageIds.length === 0) return;
    
    // Ensure index is valid
    if (index < 0 || index >= imageIds.length) {
      console.error(`Invalid index ${index} - must be between 0 and ${imageIds.length - 1}`);
      return;
    }
    
    // Load and display the image at the current index
    if (!loadedImagesRef.current.has(index)) {
      loadAndDisplayImage(imageIds[index], viewportRef.current)
        .then(() => {
          loadedImagesRef.current.add(index);
        })
        .catch((err: unknown) => {
          console.error(`Error loading image at index ${index}:`, err);
          setError(`Failed to load image ${index + 1}/${imageIds.length}`);
        });
    } else {
      // If already loaded, just display it - with robust error handling
      try {
        const imageId = imageIds[index];
        if (!imageId) {
          console.error(`No imageId found at index ${index}`);
          return;
        }
        
        const imageLoadObject = cornerstoneExt.imageCache.getImageLoadObject(imageId);
        
        // Check both the imageLoadObject and the image inside it
        if (imageLoadObject && imageLoadObject.image) {
          try {
            cornerstone.displayImage(viewportRef.current, imageLoadObject.image);
          } catch (displayError) {
            console.error(`Error displaying image at index ${index}:`, displayError);
            throw displayError; // Rethrow to trigger the reload attempt
          }
        } else {
          console.warn(`Image not found in cache for index ${index}, imageId: ${imageId}`);
          throw new Error('Image not in cache'); // Trigger the reload attempt
        }
      } catch (error) {
        console.error(`Error displaying cached image at index ${index}:`, error);
        // Try reloading the image
        if (viewportRef.current) {
          loadAndDisplayImage(imageIds[index], viewportRef.current)
            .then(() => {
              loadedImagesRef.current.add(index);
              setError(null); // Clear any error message on successful reload
            })
            .catch((err: unknown) => {
              console.error(`Error reloading image at index ${index}:`, err);
              setError(`Failed to display image ${index + 1}/${imageIds.length}`);
            });
        }
      }
    }
    
    // Preload the next few images
    preloadImages(imageIds, index, 5);
    
    // Notify about the frame change
    if (onFrameChange) {
      onFrameChange(index, imageIds.length);
    }
  };
  
  // Load and display an image with improved error handling
  const loadAndDisplayImage = async (imageId: string, element: HTMLDivElement) => {
    try {
      // Validate input
      if (!imageId) {
        throw new Error('Invalid image ID');
      }
      
      if (!element) {
        throw new Error('Invalid viewport element');
      }
      
      const image = await cornerstoneExt.loadAndCacheImage(imageId);
      
      // Validate the loaded image
      if (!image) {
        throw new Error('Image failed to load');
      }
      
      // Safely display the image
      cornerstone.displayImage(element, image);
      cornerstoneExt.resize(element);
      return image;
    } catch (error) {
      console.error('Error loading image:', error);
      throw error;
    }
  };
  
  // Preload images for smoother playback
  const preloadImages = (ids: string[], currentIdx: number, count: number) => {
    for (let i = 1; i <= count; i++) {
      const idx = (currentIdx + i) % ids.length;
      if (!loadedImagesRef.current.has(idx)) {
        cornerstoneExt.loadAndCacheImage(ids[idx])
          .then(() => {
            loadedImagesRef.current.add(idx);
          })
          .catch((err: unknown) => {
            console.warn(`Error preloading image at index ${idx}:`, err);
          });
      }
    }
  };
  
  // Playback controls
  const togglePlayPause = () => {
    setIsPlaying(!isPlaying);
  };
  
  const goToNext = () => {
    setIsPlaying(false);
    setCurrentIndex(prev => {
      const next = (prev + 1) % imageIds.length;
      updateCurrentImage(next);
      return next;
    });
  };
  
  const goToPrevious = () => {
    setIsPlaying(false);
    setCurrentIndex(prev => {
      const next = (prev - 1 + imageIds.length) % imageIds.length;
      updateCurrentImage(next);
      return next;
    });
  };
  
  const goToFirst = () => {
    setIsPlaying(false);
    setCurrentIndex(0);
    updateCurrentImage(0);
  };
  
  const goToLast = () => {
    setIsPlaying(false);
    const lastIndex = imageIds.length - 1;
    setCurrentIndex(lastIndex);
    updateCurrentImage(lastIndex);
  };
  
  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newIndex = parseInt(e.target.value, 10);
    setCurrentIndex(newIndex);
    updateCurrentImage(newIndex);
  };
  
  const handleFpsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFps(parseInt(e.target.value, 10));
  };
  
  // Handle plane change
  const handlePlaneChange = (plane: AnatomicalPlane) => {
    if (availablePlanes[plane]) {
      changePlane(plane);
    }
  };
  
  return (
    <div className={`dicom-series-player ${className || ''}`}>
      <div 
        ref={viewportRef} 
        className="dicom-viewport" 
        style={{ width: '100%', height: 'calc(100% - 100px)', background: '#000' }}
      >
        {isLoading && (
          <div className="loading-overlay">
            <div className="spinner"></div>
            <div className="loading-text">Loading DICOM series...</div>
          </div>
        )}
        
        {error && (
          <div className="error-message">
            <div className="error-icon">⚠️</div>
            <div>{error}</div>
          </div>
        )}
        
        {!isLoading && !error && imageIds.length === 0 && (
          <div className="empty-message">
            <div className="info-icon">ℹ️</div>
            <div>No images available for this plane</div>
            <div className="empty-suggestion">Try selecting a different plane orientation</div>
          </div>
        )}
      </div>
      
      {/* Always show plane selection even if current plane is empty */}
      <div className="plane-selection">
        <button 
          onClick={() => handlePlaneChange('AXIAL')} 
          className={`plane-button ${currentPlane === 'AXIAL' ? 'active' : ''} ${!availablePlanes.AXIAL ? 'disabled' : ''}`}
          disabled={!availablePlanes.AXIAL}
        >
          <ScanLine size={14} />
          <span>Axial</span>
          {planeImagesRef.current.AXIAL.length > 0 && (
            <span className="plane-image-count">{planeImagesRef.current.AXIAL.length}</span>
          )}
        </button>
        <button 
          onClick={() => handlePlaneChange('SAGITTAL')} 
          className={`plane-button ${currentPlane === 'SAGITTAL' ? 'active' : ''} ${!availablePlanes.SAGITTAL ? 'disabled' : ''}`}
          disabled={!availablePlanes.SAGITTAL}
        >
          <ScanLine size={14} className="rotate-90" />
          <span>Sagittal</span>
          {planeImagesRef.current.SAGITTAL.length > 0 && (
            <span className="plane-image-count">{planeImagesRef.current.SAGITTAL.length}</span>
          )}
        </button>
        <button 
          onClick={() => handlePlaneChange('CORONAL')} 
          className={`plane-button ${currentPlane === 'CORONAL' ? 'active' : ''} ${!availablePlanes.CORONAL ? 'disabled' : ''}`}
          disabled={!availablePlanes.CORONAL}
        >
          <ScanLine size={14} className="rotate-90" />
          <span>Coronal</span>
          {planeImagesRef.current.CORONAL.length > 0 && (
            <span className="plane-image-count">{planeImagesRef.current.CORONAL.length}</span>
          )}
        </button>
      </div>
      
      {imageIds.length > 0 && (
        <div className="controls-panel">
          <div className="playback-controls">
            <button onClick={goToFirst} className="control-button" title="Go to first frame">
              <SkipBack size={16} />
            </button>
            <button onClick={goToPrevious} className="control-button" title="Previous frame">
              <ChevronLeft size={16} />
            </button>
            <button onClick={togglePlayPause} className="control-button play-pause" title={isPlaying ? "Pause" : "Play"}>
              {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button onClick={goToNext} className="control-button" title="Next frame">
              <ChevronRight size={16} />
            </button>
            <button onClick={goToLast} className="control-button" title="Go to last frame">
              <SkipForward size={16} />
            </button>
          </div>
          
          <div className="slider-container">
            <input
              type="range"
              min={0}
              max={imageIds.length - 1}
              value={currentIndex}
              onChange={handleSliderChange}
              className="frame-slider"
            />
            <div className="frame-info">
              {currentIndex + 1} / {imageIds.length}
            </div>
          </div>
          
          <div className="fps-control">
            <label htmlFor="fps-slider">Speed: {fps} fps</label>
            <input
              id="fps-slider"
              type="range"
              min={1}
              max={30}
              value={fps}
              onChange={handleFpsChange}
              className="fps-slider"
            />
          </div>
        </div>
      )}
      
      <style jsx>{`
        .dicom-series-player {
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100%;
          overflow: hidden;
          border-radius: 4px;
          background: #1a1a1a;
          color: white;
        }
        
        .loading-overlay,
        .error-message {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.8);
          color: white;
          text-align: center;
        }
        
        .spinner {
          border: 3px solid rgba(255, 255, 255, 0.2);
          border-radius: 50%;
          border-top: 3px solid white;
          width: 30px;
          height: 30px;
          animation: spin 1s linear infinite;
          margin-bottom: 10px;
        }
        
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        
        .plane-selection {
          display: flex;
          justify-content: center;
          gap: 8px;
          padding: 8px;
          background: #2a2a2a;
          border-top: 1px solid #3a3a3a;
        }
        
        .plane-button {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 4px 8px;
          border-radius: 4px;
          background: #3a3a3a;
          border: none;
          color: white;
          font-size: 12px;
          cursor: pointer;
        }
        
        .plane-button:hover {
          background: #4a4a4a;
        }
        
        .plane-button.active {
          background: #4cedff;
          color: #1a1a1a;
        }
        
        .plane-button.disabled {
          opacity: 0.5;
          cursor: not-allowed;
          background: #333;
        }
        
        .controls-panel {
          padding: 10px;
          background: #2a2a2a;
          border-top: 1px solid #3a3a3a;
        }
        
        .playback-controls {
          display: flex;
          justify-content: center;
          gap: 10px;
          margin-bottom: 10px;
        }
        
        .control-button {
          background: #3a3a3a;
          border: none;
          color: white;
          border-radius: 50%;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: background 0.2s;
        }
        
        .control-button:hover {
          background: #4a4a4a;
        }
        
        .play-pause {
          background: #4cedff;
          color: #1a1a1a;
        }
        
        .play-pause:hover {
          background: #3db5c7;
        }
        
        .slider-container {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 10px;
        }
        
        .frame-slider {
          flex-grow: 1;
          height: 6px;
          -webkit-appearance: none;
          appearance: none;
          background: #3a3a3a;
          outline: none;
          border-radius: 3px;
        }
        
        .frame-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: #4cedff;
          cursor: pointer;
        }
        
        .frame-slider::-moz-range-thumb {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: #4cedff;
          cursor: pointer;
          border: none;
        }
        
        .frame-info {
          font-size: 12px;
          min-width: 60px;
          text-align: center;
        }
        
        .fps-control {
          display: flex;
          flex-direction: column;
          font-size: 12px;
        }
        
        .fps-slider {
          -webkit-appearance: none;
          appearance: none;
          height: 4px;
          background: #3a3a3a;
          outline: none;
          border-radius: 2px;
          margin-top: 5px;
        }
        
        .fps-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #4cedff;
          cursor: pointer;
        }
        
        .fps-slider::-moz-range-thumb {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #4cedff;
          cursor: pointer;
          border: none;
        }
        
        .error-icon {
          font-size: 24px;
          margin-bottom: 10px;
        }
        
        .rotate-90 {
          transform: rotate(90deg);
        }
        
        .empty-message {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
          color: white;
          text-align: center;
          background: rgba(0, 0, 0, 0.7);
        }
        
        .info-icon {
          font-size: 24px;
          margin-bottom: 10px;
        }
        
        .empty-suggestion {
          font-size: 14px;
          opacity: 0.8;
          margin-top: 10px;
        }
        
        .plane-image-count {
          background: rgba(255, 255, 255, 0.2);
          border-radius: 10px;
          padding: 1px 6px;
          font-size: 10px;
          margin-left: 5px;
        }
      `}</style>
    </div>
  );
} 