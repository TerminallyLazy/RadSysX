// Cornerstone3D Initialization Module

// Core functionality
import * as cornerstone3D from '@cornerstonejs/core';
import {
  RenderingEngine,
  Enums,
  volumeLoader,
  setVolumesForViewports,
  cache,
  imageLoader,
  utilities,
  metaData,
  eventTarget,
} from '@cornerstonejs/core';

// Tools
import {
  init as csToolsInit,
  addTool,
  ToolGroupManager,
  Enums as ToolEnums,
  segmentation,
  BrushTool,
  PanTool,
  ZoomTool,
  WindowLevelTool,
  LengthTool,
  RectangleROITool,
  EllipticalROITool,
  AngleTool,
  ProbeTool,
  StackScrollTool,
  MagnifyTool,
  SegmentationDisplayTool,
  CrosshairsTool,
  StackScrollMouseWheelTool,
  annotation,
  VolumeRotateMouseWheelTool,
} from '@cornerstonejs/tools';

// DICOM Image Loaders
import dicomImageLoaderLib from '@cornerstonejs/dicom-image-loader';
import * as dicomParser from 'dicom-parser';

// Import wadouri directly from dicom-image-loader
import { wadouri } from '@cornerstonejs/dicom-image-loader';

// Helper libraries
import { vec3 } from 'gl-matrix';

let initialized = false;

const { ViewportType } = Enums;
const { MouseBindings } = ToolEnums;

// Create a compatibility layer to handle API differences between versions
const compat = {
  // Safe method to initialize DICOM image loader
  initializeDicomImageLoader: async (): Promise<void> => {
    try {
      // Try to set up cornerstone reference if needed (older versions)
      if (dicomImageLoaderLib.hasOwnProperty('external')) {
        // @ts-ignore - handle potential API mismatch
        dicomImageLoaderLib.external.cornerstone = cornerstone3D;
        // @ts-ignore - handle potential API mismatch
        dicomImageLoaderLib.external.dicomParser = dicomParser;
      }

      // Initialize web workers if the method exists
      if (dicomImageLoaderLib.hasOwnProperty('initializeWebWorkers')) {
        // @ts-ignore - handle potential API mismatch
        dicomImageLoaderLib.initializeWebWorkers({
          maxWebWorkers: navigator.hardwareConcurrency || 4,
          startWebWorkersOnDemand: true,
        });
      }

      // Configure WADO URI loader
      if (dicomImageLoaderLib.hasOwnProperty('wadouri') && 
          // @ts-ignore - handle potential API mismatch
          dicomImageLoaderLib.wadouri && 
          // @ts-ignore - handle potential API mismatch
          typeof dicomImageLoaderLib.wadouri.configure === 'function') {
        // @ts-ignore - handle potential API mismatch
        dicomImageLoaderLib.wadouri.configure({
          useWebWorkers: true,
          decodeConfig: {
            convertFloatPixelDataToInt: false,
          },
        });
      }

      // Register image loaders
      if (imageLoader && typeof imageLoader.registerImageLoader === 'function') {
        // Register WADO URI loader
        if (dicomImageLoaderLib.hasOwnProperty('wadouri')) {
          // @ts-ignore - handle potential API mismatch
          const wadoUriLoader = dicomImageLoaderLib.wadouri.loadImageFromUri || 
                              // @ts-ignore - handle potential API mismatch
                              dicomImageLoaderLib.wadouri.loadImage;
          
          if (wadoUriLoader) {
            const wrappedLoader = (imageId: string) => {
              const promise = wadoUriLoader(imageId);
              return { promise };
            };
            
            imageLoader.registerImageLoader('wadouri', wrappedLoader);
            imageLoader.registerImageLoader('dicomweb', wrappedLoader);
          }
        }

        // Register WADO RS loader
        if (dicomImageLoaderLib.hasOwnProperty('wadors')) {
          // @ts-ignore - handle potential API mismatch
          const wadoRsLoader = dicomImageLoaderLib.wadors.loadImageFromUri || 
                             // @ts-ignore - handle potential API mismatch
                             dicomImageLoaderLib.wadors.loadImage;
          
          if (wadoRsLoader) {
            const wrappedLoader = (imageId: string) => {
              const promise = wadoRsLoader(imageId);
              return { promise };
            };
            
            imageLoader.registerImageLoader('wadors', wrappedLoader);
          }
        }
      }
      
      console.log('DICOM image loader initialized successfully');
    } catch (error) {
      console.error('Failed to initialize DICOM image loader:', error);
    }
  },
  
  // Safe method to register volume loader
  registerVolumeLoader: (): void => {
    try {
      if (volumeLoader && typeof volumeLoader.registerVolumeLoader === 'function') {
        // Try different possible methods for streaming volume loading
        // @ts-ignore - handle potential API mismatch
        const streamingLoader = cornerstone3D.volumeLoader?.createAndCacheVolumeFromImageIdsStreaming || 
                              // @ts-ignore - handle potential API mismatch  
                              cornerstone3D.volumeLoader?.createAndCacheVolume;
        
        if (streamingLoader) {
          volumeLoader.registerVolumeLoader('cornerstoneStreamingImageVolume', streamingLoader);
        } else {
          console.log('Streaming volume loader not available');
        }
      }
    } catch (error) {
      console.warn('Error registering volume loader:', error);
    }
  },
  
  // Safe method to configure rendering settings
  configureRendering: (): void => {
    try {
      const renderingConfig = {
        preferSizeOverAccuracy: true,
        useNorm16Texture: true,
        useCPURendering: false,
        strictZSpacingForVolumeViewport: false
      };

      // Try different possible methods for setting configuration
      // @ts-ignore - handle potential API mismatch
      if (typeof cornerstone3D.setUseCPURendering === 'function') {
        // @ts-ignore - handle potential API mismatch
        cornerstone3D.setUseCPURendering(renderingConfig.useCPURendering);
      }
      
      // @ts-ignore - handle potential API mismatch
      if (cornerstone3D.Settings && typeof cornerstone3D.Settings.setConfiguration === 'function') {
        // @ts-ignore - handle potential API mismatch
        cornerstone3D.Settings.setConfiguration({
          rendering: renderingConfig
        });
      // @ts-ignore - handle potential API mismatch
      } else if (typeof cornerstone3D.setConfiguration === 'function') {
        // @ts-ignore - handle potential API mismatch
        cornerstone3D.setConfiguration({
          rendering: renderingConfig
        });
      }
    } catch (error) {
      console.warn('Error configuring rendering:', error);
    }
  }
};

// Create a global rendering engine for utility functions
let defaultRenderingEngine: RenderingEngine | null = null;

/**
 * Get or create the default rendering engine
 */
export function getDefaultRenderingEngine(): RenderingEngine {
  if (!defaultRenderingEngine || !cornerstone3D.getRenderingEngine('default')) {
    defaultRenderingEngine = new RenderingEngine('default');
  }
  return defaultRenderingEngine;
}

/**
 * Initialize the Cornerstone3D libraries
 */
export async function initializeCornerstone3D(): Promise<void> {
  if (initialized) {
    console.log('Cornerstone3D already initialized');
    return;
  }

  try {
    // Initialize Cornerstone3D if not already initialized
    await cornerstone3D.init();
    
    // Initialize the DICOM image loader
    await compat.initializeDicomImageLoader();
    
    // Register volume loader
    compat.registerVolumeLoader();
    
    // Configure rendering
    compat.configureRendering();
    
    // Initialize tools if not already initialized
    await csToolsInit();

    // Add all tools that will be used
    addTools();

    // Set up the cache
    setupCache();

    // Register custom loaders for standard image formats
    registerCustomImageLoaders();

    console.log('✅ Cornerstone3D initialized successfully');
    initialized = true;
  } catch (error) {
    console.error('❌ Error initializing Cornerstone3D:', error);
    throw error;
  }
}

/**
 * Add all tools that we'll use in the application
 */
function addTools(): void {
  // Add all the tools we plan to use
  addTool(PanTool);
  addTool(ZoomTool);
  addTool(WindowLevelTool);
  addTool(LengthTool);
  addTool(RectangleROITool);
  addTool(EllipticalROITool);
  addTool(AngleTool);
  addTool(ProbeTool);
  addTool(BrushTool);
  addTool(StackScrollTool);
  addTool(StackScrollMouseWheelTool);
  addTool(MagnifyTool);
  addTool(CrosshairsTool);
  addTool(VolumeRotateMouseWheelTool);
  addTool(SegmentationDisplayTool);
}

/**
 * Set up the cache for optimal performance
 */
function setupCache(): void {
  // Set cache size for images and volumes
  cache.setMaxCacheSize(3000);
}

/**
 * Create a rendering engine
 * @param id The unique ID for the rendering engine
 * @returns The newly created rendering engine
 */
export function createRenderingEngine(id: string): RenderingEngine {
  // Clean up any existing rendering engine with the same ID
  const existingEngine = cornerstone3D.getRenderingEngine(id);
  if (existingEngine) {
    console.log(`Destroying existing rendering engine with ID ${id}`);
    existingEngine.destroy();
  }

  // Create a new rendering engine
  return new RenderingEngine(id);
}

/**
 * Create a viewport on the specified HTML element
 * @param renderingEngine The rendering engine to use
 * @param elementId The ID of the HTML element to render into
 * @param viewportId The unique ID for this viewport
 * @param viewportType The type of viewport to create
 * @param options Additional viewport options
 * @returns The created viewport
 */
export function createViewport(
  renderingEngine: RenderingEngine,
  elementId: string,
  viewportId: string,
  viewportType: Enums.ViewportType,
  options: any = {}
): any {
  // Get the element
  const element = document.getElementById(elementId);
  if (!element) {
    throw new Error(`Element with ID ${elementId} not found`);
  }

  // Create the viewport with required properties
  const viewport = renderingEngine.enableElement({
    viewportId,
    type: viewportType,
    element: element as HTMLDivElement,
    defaultOptions: {
      background: [0, 0, 0],
      ...options
    }
  });

  return viewport;
}

/**
 * Get the default orientation for a viewport type
 */
function getDefaultOrientationForViewportType(
  viewportType: Enums.ViewportType
): any {
  if (viewportType === ViewportType.STACK) {
    return Enums.OrientationAxis.AXIAL;
  }
  return Enums.OrientationAxis.AXIAL;
}

/**
 * Create a tool group for a set of viewports
 * @param toolGroupId The unique ID for this tool group
 * @param viewportIds The IDs of viewports to include in this tool group
 * @returns The created tool group
 */
export function createToolGroup(
  toolGroupId: string,
  viewportIds: string[]
): any {
  // Clean up existing tool group with the same ID
  const existingToolGroup = ToolGroupManager.getToolGroup(toolGroupId);
  if (existingToolGroup) {
    ToolGroupManager.destroyToolGroup(toolGroupId);
  }

  // Create a new tool group
  const toolGroup = ToolGroupManager.createToolGroup(toolGroupId);
  
  if (toolGroup) {
    // Add tools to the tool group with default configurations
    toolGroup.addTool(PanTool.toolName);
    toolGroup.addTool(ZoomTool.toolName);
    toolGroup.addTool(WindowLevelTool.toolName);
    toolGroup.addTool(LengthTool.toolName);
    toolGroup.addTool(RectangleROITool.toolName);
    toolGroup.addTool(EllipticalROITool.toolName);
    toolGroup.addTool(AngleTool.toolName);
    toolGroup.addTool(ProbeTool.toolName);
    toolGroup.addTool(BrushTool.toolName);
    toolGroup.addTool(StackScrollTool.toolName);
    toolGroup.addTool(StackScrollMouseWheelTool.toolName);
    toolGroup.addTool(MagnifyTool.toolName);
    
    // Add viewports to the tool group
    viewportIds.forEach(viewportId => {
      toolGroup.addViewport(viewportId);
    });
  }

  return toolGroup;
}

/**
 * Set the active tool for a tool group
 * @param toolGroupId The ID of the tool group
 * @param toolName The name of the tool to activate
 * @param bindings Mouse button bindings for the tool
 */
export function setToolActive(
  toolGroupId: string,
  toolName: string,
  bindings: { mouseButton?: number } = {}
): void {
  // Get the tool group
  const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
  
  if (!toolGroup) {
    console.warn(`Tool group with ID ${toolGroupId} not found`);
    return;
  }

  // Set mouse button binding (default to left mouse button)
  const mouseButton = bindings.mouseButton ?? MouseBindings.Primary;
  
  // Deactivate all tools first
  const toolNames = [
    PanTool.toolName,
    ZoomTool.toolName,
    WindowLevelTool.toolName,
    LengthTool.toolName,
    RectangleROITool.toolName,
    EllipticalROITool.toolName,
    AngleTool.toolName,
    ProbeTool.toolName,
    BrushTool.toolName,
    StackScrollTool.toolName,
    MagnifyTool.toolName,
  ];

  toolNames.forEach(tool => {
    if (tool !== toolName) {
      toolGroup.setToolPassive(tool);
    }
  });

  // Activate the requested tool
  toolGroup.setToolActive(toolName, { bindings: [{ mouseButton }] });
  console.log(`Activated tool: ${toolName} with mouse button: ${mouseButton}`);
}

// UI Tool type that matches the application's existing tool types
export type UiToolType =
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

/**
 * Map UI tool types to Cornerstone3D tool names
 * @param tool The UI tool type
 * @returns The corresponding Cornerstone3D tool name
 */
export function mapUiToolToCornerstone3D(tool: UiToolType): string {
  switch (tool) {
    case "pan":
      return PanTool.toolName;
    case "zoom":
      return ZoomTool.toolName;
    case "window":
    case "level":
      return WindowLevelTool.toolName;
    case "distance":
      return LengthTool.toolName;
    case "area":
      return RectangleROITool.toolName;
    case "angle":
      return AngleTool.toolName;
    case "profile":
      return ProbeTool.toolName;
    case "segment":
      return BrushTool.toolName;
    // For tools we don't have an equivalent, fall back to Pan
    case "diagnose":
    case "statistics":
    case "compare":
    case null:
      return PanTool.toolName;
    default:
      console.warn(`Unknown tool type: ${tool} - defaulting to Pan`);
      return PanTool.toolName;
  }
}

/**
 * Load and display an image stack for 2D viewing
 * @param element DOM element for the viewport
 * @param imageIds Array of image IDs to load
 * @param viewportId Viewport ID
 * @param renderingEngineId Optional rendering engine ID
 */
export async function loadAndDisplayImageStack(
  element: HTMLDivElement,
  imageIds: string[],
  viewportId: string,
  renderingEngineId = 'default'
): Promise<void> {
  try {
    // Get or create the rendering engine
    let engine = cornerstone3D.getRenderingEngine(renderingEngineId);
    if (!engine) {
      engine = new RenderingEngine(renderingEngineId);
    }

    // Create viewport options
    const viewportOptions = {
      viewportId,
      type: Enums.ViewportType.STACK,
      element,
      defaultOptions: {
        background: [0, 0, 0] as [number, number, number],
      }
    };

    // Create and enable the viewport using type assertion for compatibility
    const viewport = await engine.enableElement(viewportOptions) as any;

    // Set the stack of images on the viewport
    if (viewport && typeof viewport.setStack === 'function') {
      await viewport.setStack(imageIds);
    }

    // Render the image
    if (viewport && typeof viewport.render === 'function') {
      viewport.render();
    }
  } catch (error) {
    console.error('Error loading and displaying image stack:', error);
    throw error;
  }
}

/**
 * Load and display a volume for 3D viewing
 * @param element DOM element for the viewport
 * @param imageIds Array of image IDs to load
 * @param viewportId Viewport ID
 * @param volumeId Volume ID
 * @param viewportType Type of viewport to create
 * @param renderingEngineId Optional rendering engine ID
 */
export async function loadAndDisplayVolume(
  element: HTMLDivElement,
  imageIds: string[],
  viewportId: string,
  volumeId = 'volume-0',
  viewportType = Enums.ViewportType.ORTHOGRAPHIC,
  renderingEngineId = 'default'
): Promise<void> {
  try {
    // Get or create the rendering engine
    let engine = cornerstone3D.getRenderingEngine(renderingEngineId);
    if (!engine) {
      engine = new RenderingEngine(renderingEngineId);
    }

    // Create volume load options
    const volumeLoadOptions = {
      imageIds,
    };

    // Create the volume
    const volume = await volumeLoader.createAndCacheVolume(volumeId, volumeLoadOptions);

    // Determine orientation based on viewport type
    let orientation = Enums.OrientationAxis.AXIAL;
    
    // Create viewport options
    const viewportOptions = {
      viewportId,
      type: viewportType,
      element,
      defaultOptions: {
        orientation,
        background: [0, 0, 0] as [number, number, number],
      },
    };

    // Create and enable viewport using type assertion for compatibility
    const viewport = await engine.enableElement(viewportOptions) as any;

    // If the viewport is a volume viewport, set the volumes
    const isVolumeType = viewportType.toString().includes('VOLUME');
    if (isVolumeType && engine) {
      await setVolumesForViewports(engine, [{ volumeId }], [viewportId]);
    } else {
      // For other viewport types, try to jump to first slice if supported
      try {
        if (viewport && typeof viewport.setSliceIndex === 'function') {
          viewport.setSliceIndex(0);
        } else {
          // Try to find a method to set the initial slice
          // Some versions use different APIs, so we try various approaches
          // @ts-ignore - Handling API differences
          if (viewport && typeof viewport.jumpToSlice === 'function') {
            // @ts-ignore
            viewport.jumpToSlice(0);
          }
          // Fallback to setting the slice directly if possible
          else if (viewport && viewport.slice !== undefined) {
            // @ts-ignore
            viewport.slice = 0;
            if (typeof viewport.render === 'function') {
              viewport.render();
            }
          }
        }
      } catch (err) {
        console.warn('Could not set initial slice index:', err);
      }
    }

    // Render the image
    if (viewport && typeof viewport.render === 'function') {
      viewport.render();
    }
  } catch (error) {
    console.error('Error loading and displaying volume:', error);
    throw error;
  }
}

/**
 * Detect if an image is a 2D image (single slice)
 * @param imageId The image ID to check
 * @param metadata Optional metadata for the image
 * @returns True if the image is a 2D image, false otherwise
 */
export function is2DImage(imageId: string, metadata?: any): boolean {
  // Check by file name
  const fileName = imageId.split('/').pop()?.toLowerCase() || '';
  const is2DImageFormat = 
    fileName.endsWith('.png') || 
    fileName.endsWith('.jpg') || 
    fileName.endsWith('.jpeg') || 
    fileName.endsWith('.gif') ||
    fileName.endsWith('.bmp');
    
  if (is2DImageFormat) {
    return true;
  }
  
  // Check if it's a single-slice DICOM
  const isDicom = fileName.endsWith('.dcm');
  
  if (isDicom && metadata) {
    // Look for metadata properties that indicate a single slice
    const isSingleSlice = 
      (metadata.numberOfFrames === 1) ||
      (!metadata.sliceThickness && !metadata.spacingBetweenSlices) ||
      (metadata.sopClassUID === '1.2.840.10008.5.1.4.1.1.7'); // Secondary Capture Image Storage
      
    return isSingleSlice;
  }
  
  return false;
}

/**
 * Clean up Cornerstone3D resources when no longer needed
 * @param renderingEngineId The ID of the rendering engine to destroy
 * @param toolGroupIds Optional array of tool group IDs to destroy
 */
export function cleanupCornerstone3D(
  renderingEngineId: string, 
  toolGroupIds?: string[]
): void {
  try {
    // Clean up tool groups if specified
    if (toolGroupIds) {
      toolGroupIds.forEach(toolGroupId => {
        const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
        if (toolGroup) {
          ToolGroupManager.destroyToolGroup(toolGroupId);
        }
      });
    }
    
    // Clean up rendering engine
    const renderingEngine = cornerstone3D.getRenderingEngine(renderingEngineId);
    if (renderingEngine) {
      renderingEngine.destroy();
    }
    
    console.log(`Cleaned up Cornerstone3D resources for renderingEngine: ${renderingEngineId}`);
  } catch (error) {
    console.error('Error cleaning up Cornerstone3D resources:', error);
  }
}

/**
 * Create image IDs from File objects
 * @param files Array of File objects to create image IDs from
 * @returns Array of image IDs
 */
export async function createImageIdsFromFiles(files: File[]): Promise<string[]> {
  if (!files || files.length === 0) {
    return [];
  }
  
  // Process each file and create an image ID
  const imageIds = files.map(file => {
    // Create blob URL for the file
    const objectUrl = URL.createObjectURL(file);
    const filename = file.name.toLowerCase();
    
    // Determine the image loader prefix based on file type
    if (filename.endsWith('.dcm')) {
      return `wadouri:${objectUrl}`;
    } else if (
      filename.endsWith('.jpg') || 
      filename.endsWith('.jpeg') || 
      filename.endsWith('.png') || 
      filename.endsWith('.gif') || 
      filename.endsWith('.bmp')
    ) {
      // For standard image formats
      return `imageLoader:${objectUrl}`;
    } else {
      // Default to wadouri for other formats
      return `wadouri:${objectUrl}`;
    }
  });
  
  return imageIds;
}

/**
 * Register custom image loaders for standard image formats
 */
function registerCustomImageLoaders(): void {
  // Register a loader for standard image formats like PNG, JPEG, etc.
  imageLoader.registerImageLoader('imageLoader', function(imageId: string) {
    // Strip the imageLoader: prefix
    const url = imageId.replace('imageLoader:', '');
    
    const promise = new Promise<Record<string, any>>((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      
      image.onload = function() {
        // Create a canvas to draw the image
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d');
        
        if (!ctx) {
          reject(new Error('Could not get 2D context'));
          return;
        }
        
        // Draw the image onto the canvas
        ctx.drawImage(image, 0, 0);
        
        // Get the image data
        const imageData = ctx.getImageData(0, 0, image.width, image.height);
        const pixelData = imageData.data;
        
        // Create a Cornerstone3D image object
        const cornerstoneImage = {
          imageId,
          width: image.width,
          height: image.height,
          getPixelData: () => pixelData,
          getFrameMetadata: () => ({}),
          getPixelLength: () => image.width * image.height * 4,
          getIntercept: () => 0,
          getSlope: () => 1,
          getInvert: () => false,
          getWindowLevel: () => ({
            windowWidth: 255,
            windowCenter: 127.5,
          }),
          getDefaultViewport: () => ({
            voi: {
              windowWidth: 255,
              windowCenter: 127.5,
            },
            scale: 1,
            translation: {
              x: 0,
              y: 0,
            },
            inversed: false,
          }),
          columnPixelSpacing: 1,
          rowPixelSpacing: 1,
          color: true,
          rgba: true,
          sizeInBytes: image.width * image.height * 4,
          rowLength: image.width,
          minPixelValue: 0,
          maxPixelValue: 255,
          invert: false,
          getCanvas: () => canvas,
          voiLUTFunction: 'LINEAR',
          minMaxPixelValues: undefined,
          isPreScaled: true,
          preScale: {
            enabled: true,
            scaled: true,
            scalingParameters: {
              modality: 'PT',
              rescaleSlope: 1,
              rescaleIntercept: 0,
              suvbw: 1
            }
          }
        };
        
        resolve(cornerstoneImage);
      };
      
      image.onerror = function(error) {
        reject(new Error(`Could not load image: ${error}`));
      };
      
      image.src = url;
    });
    
    return {
      promise,
      cancelFn: undefined,
      decache: undefined
    };
  });
  
  console.log('Custom image loader registered for standard image formats');
}

/**
 * Determine if a set of imageIds can properly form a volume
 * @param imageIds Array of image IDs to check
 * @returns {Promise<boolean>} Whether the images can form a proper volume
 */
export async function canLoadAsVolume(imageIds: string[]): Promise<boolean> {
  // Volumes require at least 3 slices
  if (!imageIds || imageIds.length < 3) {
    console.log('Not enough images to form a volume (minimum 3 required)');
    return false;
  }

  try {
    // For proper volume loading, we need:
    // 1. All images to be DICOM
    // 2. Consistent dimensions
    // 3. Proper spacing information
    
    // Check the first image to get baseline metadata
    const firstImageId = imageIds[0];
    if (!firstImageId) return false;
    
    // Load metadata for the first image
    const firstImagePromise = imageLoader.loadAndCacheImage(firstImageId);
    const firstImage = await firstImagePromise;
    
    if (!firstImage) {
      console.log('First image could not be loaded, cannot form volume');
      return false;
    }
    
    // Get dimensions of the first image
    const { rows, columns } = firstImage;
    if (!rows || !columns) {
      console.log('First image does not have proper dimensions');
      return false;
    }
    
    // For a small set of images, we can check them all
    // For larger sets, we check a sample to avoid performance issues
    const samplesToCheck = imageIds.length <= 10 ? imageIds.length : 3;
    const sampleIndices = [0, Math.floor(imageIds.length / 2), imageIds.length - 1].slice(0, samplesToCheck);
    
    // Check metadata consistency
    for (const idx of sampleIndices) {
      if (idx === 0) continue; // Skip first image, already checked
      
      const sampleImageId = imageIds[idx];
      if (!sampleImageId) continue;
      
      try {
        const sampleImagePromise = imageLoader.loadAndCacheImage(sampleImageId);
        const sampleImage = await sampleImagePromise;
        
        if (!sampleImage) {
          console.log(`Image at index ${idx} could not be loaded`);
          return false;
        }
        
        // Check for consistent dimensions
        if (sampleImage.rows !== rows || sampleImage.columns !== columns) {
          console.log(`Inconsistent dimensions detected: First image ${rows}x${columns}, Sample image ${sampleImage.rows}x${sampleImage.columns}`);
          return false;
        }
      } catch (error) {
        console.error(`Error checking sample image at index ${idx}:`, error);
        return false;
      }
    }
    
    // If we made it this far, we likely have a valid volume
    console.log(`Image set appears to be a valid volume with ${imageIds.length} slices`);
    return true;
  } catch (error) {
    console.error('Error determining if images can form a volume:', error);
    return false;
  }
} 