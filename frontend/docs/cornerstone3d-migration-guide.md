# Cornerstone3D Migration Guide: Comprehensive Reference

## Table of Contents
1. [Understanding the Migration Context](#understanding-the-migration-context)
2. [Core Libraries Overview](#core-libraries-overview)
3. [Key Architectural Differences](#key-architectural-differences)
4. [Step-by-Step Migration Process](#step-by-step-migration-process)
5. [Code Examples](#code-examples)
6. [Common Issues and Solutions](#common-issues-and-solutions)
7. [Testing and Validation](#testing-and-validation)
8. [RadSysX-Specific Implementation](#radsysx-specific-implementation)

## Understanding the Migration Context

Migrating from legacy Cornerstone to Cornerstone3D represents a fundamental shift in how medical imaging is handled in web applications. Cornerstone3D is not simply an upgrade but a complete reimagining of the architecture with a focus on:

- Efficient GPU memory usage
- Better 3D volume support
- Enhanced tool management
- Improved performance for multiple viewports

The migration requires careful planning and implementation as the APIs are not backward compatible.

## Core Libraries Overview

### Legacy Cornerstone Libraries
- **cornerstone-core**: Basic image rendering
- **cornerstone-tools**: Tool implementation
- **cornerstone-math**: Mathematical utilities
- **cornerstone-wado-image-loader**: DICOM loading

### Cornerstone3D Libraries
- **@cornerstonejs/core**: Advanced rendering engine with 2D/3D support
- **@cornerstonejs/tools**: Tool management with improved architecture
- **@cornerstonejs/dicom-image-loader**: Enhanced DICOM loading
- **@cornerstonejs/streaming-image-volume-loader**: Streaming volume loading
- **@cornerstonejs/nifti-volume-loader**: NIFTI format support

## Key Architectural Differences

### 1. Rendering Engine

**Legacy Cornerstone:**
- Each viewport has its own canvas
- Direct DOM-to-rendering approach
- Limited to 2D rendering
- No shared WebGL context between viewports

**Cornerstone3D:**
- Single WebGL context with offscreen rendering
- Results transferred to on-screen canvases
- Shared GPU texture memory
- Multiple viewport types (Stack, Volume, 3D)

### 2. Tool Management

**Legacy Cornerstone:**
- Tools are attached directly to DOM elements
- Global tool state
- Limited tool configuration

**Cornerstone3D:**
- Tool groups that manage multiple viewports
- Tools have specific strategies and configurations
- Better event handling
- Improved annotation management

### 3. Volume Support

**Legacy Cornerstone:**
- No native volume support (required react-vtkjs-viewport)
- Limited MPR capabilities

**Cornerstone3D:**
- First-class volume support
- Multiple orientations (axial, sagittal, coronal)
- Streaming volume loading
- Enhanced MPR with oblique slicing

### 4. Segmentation

**Legacy Cornerstone:**
- Limited segmentation support
- No 3D segmentation visualization

**Cornerstone3D:**
- Labelmap representations
- 3D surface rendering
- Cross-viewport segmentation editing
- Advanced segmentation tools

### 5. Synchronization

**Legacy Cornerstone:**
- Basic synchronization capabilities
- Manual sync implementation often required

**Cornerstone3D:**
- Built-in synchronizers
- Camera synchronization
- Window/level synchronization
- Advanced linked viewport behavior

## Step-by-Step Migration Process

### 1. Library Setup and Initialization

**Legacy Cornerstone (From RadSysX codebase):**
```javascript
import * as cornerstone from 'cornerstone-core';
import * as cornerstoneTools from 'cornerstone-tools';
import * as cornerstoneMath from 'cornerstone-math';
import * as cornerstoneWADOImageLoader from 'cornerstone-wado-image-loader';
import dicomParser from 'dicom-parser';

// Initialize external dependencies
cornerstoneTools.external.cornerstone = cornerstone;
cornerstoneTools.external.cornerstoneMath = cornerstoneMath;
cornerstoneWADOImageLoader.external.cornerstone = cornerstone;
cornerstoneWADOImageLoader.external.dicomParser = dicomParser;

// Initialize tools
cornerstoneTools.init();

// Register image loaders
cornerstone.registerImageLoader('wadouri', cornerstoneWADOImageLoader.wadouri.loadImage);
```

**Cornerstone3D (From RadSysX cornerstone3DInit.ts):**
```typescript
// Core functionality
import * as cornerstone3D from '@cornerstonejs/core';
import {
  RenderingEngine,
  Enums,
  volumeLoader,
  setVolumesForViewports,
  cache,
  imageLoader
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
  WindowLevelTool
} from '@cornerstonejs/tools';

// DICOM Image Loader
import * as dicomImageLoaderLib from '@cornerstonejs/dicom-image-loader';

export async function initializeCornerstone3D(): Promise<void> {
  // Initialize the core library
  await cornerstone3D.init();
  
  // Initialize the tools library
  await csToolsInit();

  // Initialize the DICOM image loader
  dicomImageLoaderLib.configure({
    useWebWorkers: true,
    decodeConfig: {
      convertFloatPixelDataToInt: false,
      use16BitDataType: true,
    },
  });

  // Set up web workers
  dicomImageLoaderLib.webWorkerManager.initialize({
    maxWebWorkers: Math.min(navigator.hardwareConcurrency || 4, 4),
    startWebWorkersOnDemand: true,
    taskConfiguration: {
      decodeTask: {
        initializeCodecsOnStartup: true,
        usePDFJS: false,
        strict: false,
      },
    },
  });

  // Register image loaders
  imageLoader.registerImageLoader('dicomFile', dicomImageLoaderLib.wadouri.loadFileRequest);
  imageLoader.registerImageLoader('wadouri', dicomImageLoaderLib.wadouri.loadFileRequest);
}
```

### 2. Setting up the Rendering Engine

**Legacy Cornerstone (From RadSysX codebase):**
```javascript
// Enable an element for cornerstone
const element = document.getElementById('viewer');
cornerstone.enable(element);

// Load and display an image
cornerstone.loadImage(imageId).then(image => {
  cornerstone.displayImage(element, image);
});
```

**Cornerstone3D (From RadSysX cornerstone3DInit.ts):**
```typescript
// Create a rendering engine
const renderingEngineId = 'myRenderingEngine';
const renderingEngine = new RenderingEngine(renderingEngineId);

// Setup a viewport
const viewportId = 'CT_AXIAL';
const viewportInput = {
  viewportId,
  type: Enums.ViewportType.STACK, // For 2D images
  element: document.getElementById('viewer'),
  defaultOptions: {
    background: [0, 0, 0],
  },
};

// Enable the viewport
renderingEngine.enableElement(viewportInput);

// Get the viewport
const viewport = renderingEngine.getViewport(viewportId);

// Set the stack of images
await viewport.setStack([imageId]);

// Render
viewport.render();
```

### 3. Tool Configuration

**Legacy Cornerstone (From RadSysX codebase):**
```javascript
// Add tools
cornerstoneTools.addTool(cornerstoneTools.PanTool);
cornerstoneTools.addTool(cornerstoneTools.ZoomTool);
cornerstoneTools.addTool(cornerstoneTools.WwwcTool);

// Activate tools
cornerstoneTools.setToolActive('Pan', { mouseButtonMask: 2 });
cornerstoneTools.setToolActive('Zoom', { mouseButtonMask: 4 });
cornerstoneTools.setToolActive('Wwwc', { mouseButtonMask: 1 });
```

**Cornerstone3D (From RadSysX cornerstone3DInit.ts):**
```typescript
// Add tools to the tool registry
addTool(PanTool);
addTool(ZoomTool);
addTool(WindowLevelTool);

// Create a tool group
const toolGroupId = 'myToolGroup';
const toolGroup = ToolGroupManager.createToolGroup(toolGroupId);

// Add tools to the tool group
toolGroup.addTool(PanTool.toolName);
toolGroup.addTool(ZoomTool.toolName);
toolGroup.addTool(WindowLevelTool.toolName);

// Set tool active with mouse bindings
toolGroup.setToolActive(WindowLevelTool.toolName, {
  bindings: [
    { mouseButton: MouseBindings.Primary } // Left mouse button
  ]
});
toolGroup.setToolActive(PanTool.toolName, {
  bindings: [
    { mouseButton: MouseBindings.Secondary } // Right mouse button
  ]
});

// Add viewports to the tool group
toolGroup.addViewport(viewportId, renderingEngineId);
```

### 4. Volume Loading and Display

**Legacy Cornerstone:**
Limited native support for volumes.

**Cornerstone3D (From RadSysX cornerstone3DInit.ts):**
```typescript
// Create and load a volume
const volumeId = 'myVolumeId';
const volume = await volumeLoader.createAndCacheVolume(volumeId, {
  imageIds: volumeImageIds,
});

// Load the volume
await volume.load();

// Set volume on viewport (for a volume viewport)
await setVolumesForViewports(
  renderingEngine,
  [{ volumeId }],
  [viewportId]
);

// Render
renderingEngine.render();
```

### 5. Annotations and Measurements

**Legacy Cornerstone (From RadSysX codebase):**
```javascript
// Add length tool
cornerstoneTools.addTool(cornerstoneTools.LengthTool);
cornerstoneTools.setToolActive('Length', { mouseButtonMask: 1 });

// Get tool measurement data
const measurementData = cornerstoneTools.getToolState(element, 'Length');
```

**Cornerstone3D (From RadSysX cornerstone3DInit.ts):**
```typescript
import { 
  addTool, 
  LengthTool,
  annotation 
} from "@cornerstonejs/tools";

// Add length tool
addTool(LengthTool);

// Add tool to tool group
toolGroup.addTool(LengthTool.toolName);

// Set tool active
toolGroup.setToolActive(LengthTool.toolName, {
  bindings: [
    { mouseButton: MouseBindings.Primary }
  ]
});

// Query annotations
const annotations = annotation.state.getAnnotations(toolGroup.id, LengthTool.toolName);
```

### 6. Segmentation

**Legacy Cornerstone:**
Limited native support, often required third-party libraries.

**Cornerstone3D (From RadSysX example):**
```typescript
import { segmentation } from "@cornerstonejs/tools";
import { volumeLoader } from "@cornerstonejs/core";

// Create segmentation volume from reference volume
const segmentationId = 'mySegmentation';
await volumeLoader.createAndCacheDerivedLabelmapVolume(volumeId, {
  volumeId: segmentationId
});

// Add segmentation to state
await segmentation.addSegmentations([
  {
    segmentationId,
    representation: {
      type: Enums.SegmentationRepresentations.Labelmap,
      data: {
        volumeId: segmentationId
      }
    }
  }
]);

// Add to viewport(s)
await segmentation.addSegmentationRepresentations(toolGroupId, [
  {
    segmentationId,
    type: Enums.SegmentationRepresentations.Labelmap
  }
]);
```

## Code Examples

### Basic Cornerstone3D Setup with React

This example is based on the existing implementation in RadSysX:

```jsx
import React, { useEffect, useRef } from 'react';
import { 
  RenderingEngine, 
  Enums,
  setVolumesForViewports
} from '@cornerstonejs/core';
import {
  ToolGroupManager,
  addTool,
  PanTool,
  ZoomTool,
  WindowLevelTool,
  LengthTool,
  Enums as ToolEnums
} from '@cornerstonejs/tools';
import { initializeCornerstone3D } from '@/lib/utils/cornerstone3DInit';
import { createImageIdsAndCacheMetaData } from '@/lib/utils/dicomImageUtils';

const { ViewportType } = Enums;
const { MouseBindings } = ToolEnums;

const DicomViewer = ({ imageIds, viewportType = 'STACK' }) => {
  const viewportRef = useRef(null);
  
  useEffect(() => {
    const setup = async () => {
      // Initialize Cornerstone3D
      await initializeCornerstone3D();
      
      // Create rendering engine
      const renderingEngineId = 'myRenderingEngine';
      const viewportId = 'CT_AXIAL';
      const renderingEngine = new RenderingEngine(renderingEngineId);
      
      // Set up the viewport
      const viewportInput = {
        viewportId,
        type: viewportType === 'STACK' 
          ? Enums.ViewportType.STACK 
          : Enums.ViewportType.ORTHOGRAPHIC,
        element: viewportRef.current,
        defaultOptions: {
          orientation: Enums.OrientationAxis.AXIAL,
          background: [0, 0, 0],
        },
      };
      
      // Enable the viewport
      renderingEngine.enableElement(viewportInput);
      
      // Add tools
      addTool(PanTool);
      addTool(ZoomTool);
      addTool(WindowLevelTool);
      addTool(LengthTool);
      
      // Create a tool group
      const toolGroupId = 'myToolGroup';
      const toolGroup = ToolGroupManager.createToolGroup(toolGroupId);
      
      // Add tools to the tool group
      toolGroup.addTool(PanTool.toolName);
      toolGroup.addTool(ZoomTool.toolName);
      toolGroup.addTool(WindowLevelTool.toolName);
      toolGroup.addTool(LengthTool.toolName);
      
      // Set active tools
      toolGroup.setToolActive(WindowLevelTool.toolName, {
        bindings: [{ mouseButton: MouseBindings.Primary }]
      });
      toolGroup.setToolActive(PanTool.toolName, {
        bindings: [{ mouseButton: MouseBindings.Secondary }]
      });
      
      // Add viewport to tool group
      toolGroup.addViewport(viewportId, renderingEngineId);
      
      // Load content based on viewport type
      if (viewportType === 'STACK') {
        // Get the viewport
        const viewport = renderingEngine.getViewport(viewportId);
        
        // Set the stack of images
        await viewport.setStack(imageIds);
        
        // Render
        viewport.render();
      } else {
        // For volume viewports
        const volumeId = 'myVolume';
        const volume = await volumeLoader.createAndCacheVolume(volumeId, {
          imageIds,
        });
        
        // Load the volume
        await volume.load();
        
        // Set volume on viewport
        await setVolumesForViewports(
          renderingEngine,
          [{ volumeId }],
          [viewportId]
        );
        
        // Render
        renderingEngine.render();
      }
      
      // Clean up
      return () => {
        if (renderingEngine) {
          renderingEngine.destroy();
        }
      };
    };
    
    setup();
  }, [imageIds, viewportType]);
  
  return (
    <div 
      ref={viewportRef} 
      style={{ 
        width: '100%', 
        height: '500px', 
        backgroundColor: '#000' 
      }}
    />
  );
};

export default DicomViewer;
```

### Multi-Viewport Layout Example

This is similar to the implementation found in your AdvancedViewer.tsx:

```jsx
import React, { useEffect, useRef } from 'react';
import { 
  RenderingEngine, 
  Enums, 
  volumeLoader,
  setVolumesForViewports 
} from '@cornerstonejs/core';
import {
  ToolGroupManager,
  addTool,
  PanTool,
  ZoomTool,
  WindowLevelTool,
  CrosshairsTool,
  Enums as ToolEnums
} from '@cornerstonejs/tools';
import { initializeCornerstone3D } from '@/lib/utils/cornerstone3DInit';

const { ViewportType, OrientationAxis } = Enums;
const { MouseBindings } = ToolEnums;

const MultiViewportLayout = ({ imageIds }) => {
  const containerRef = useRef(null);
  const viewportRefs = {
    axial: useRef(null),
    sagittal: useRef(null),
    coronal: useRef(null),
    volume3d: useRef(null)
  };
  
  useEffect(() => {
    const setup = async () => {
      if (!imageIds || imageIds.length === 0) return;
      
      // Initialize Cornerstone3D
      await initializeCornerstone3D();
      
      // Create rendering engine
      const renderingEngineId = 'multiViewportEngine';
      const renderingEngine = new RenderingEngine(renderingEngineId);
      
      const viewportIds = {
        axial: 'AXIAL_VIEW',
        sagittal: 'SAGITTAL_VIEW',
        coronal: 'CORONAL_VIEW',
        volume3d: '3D_VIEW'
      };
      
      // Set up viewport inputs
      const viewportInputs = [
        {
          viewportId: viewportIds.axial,
          type: ViewportType.ORTHOGRAPHIC,
          element: viewportRefs.axial.current,
          defaultOptions: {
            orientation: OrientationAxis.AXIAL,
            background: [0, 0, 0],
          },
        },
        {
          viewportId: viewportIds.sagittal,
          type: ViewportType.ORTHOGRAPHIC,
          element: viewportRefs.sagittal.current,
          defaultOptions: {
            orientation: OrientationAxis.SAGITTAL,
            background: [0, 0, 0],
          },
        },
        {
          viewportId: viewportIds.coronal,
          type: ViewportType.ORTHOGRAPHIC,
          element: viewportRefs.coronal.current,
          defaultOptions: {
            orientation: OrientationAxis.CORONAL,
            background: [0, 0, 0],
          },
        },
        {
          viewportId: viewportIds.volume3d,
          type: ViewportType.VOLUME_3D,
          element: viewportRefs.volume3d.current,
          defaultOptions: {
            background: [0, 0, 0],
          },
        },
      ];
      
      // Enable all viewports
      renderingEngine.setViewports(viewportInputs);
      
      // Add tools
      addTool(PanTool);
      addTool(ZoomTool);
      addTool(WindowLevelTool);
      addTool(CrosshairsTool);
      
      // Create tool groups - one for MPR, one for 3D
      const mprToolGroupId = 'MPR_TOOL_GROUP';
      const volume3dToolGroupId = '3D_TOOL_GROUP';
      
      // Create the MPR tool group and add tools
      const mprToolGroup = ToolGroupManager.createToolGroup(mprToolGroupId);
      mprToolGroup.addTool(PanTool.toolName);
      mprToolGroup.addTool(ZoomTool.toolName);
      mprToolGroup.addTool(WindowLevelTool.toolName);
      mprToolGroup.addTool(CrosshairsTool.toolName);
      
      // Set active tools for MPR
      mprToolGroup.setToolActive(WindowLevelTool.toolName, {
        bindings: [{ mouseButton: MouseBindings.Primary }]
      });
      mprToolGroup.setToolActive(PanTool.toolName, {
        bindings: [{ mouseButton: MouseBindings.Secondary }]
      });
      mprToolGroup.setToolActive(ZoomTool.toolName, {
        bindings: [{ mouseButton: MouseBindings.Auxiliary }]
      });
      mprToolGroup.setToolActive(CrosshairsTool.toolName, {
        bindings: [{ mouseButton: MouseBindings.Primary, modifierKey: 'Shift' }]
      });
      
      // Create the 3D tool group and add tools
      const volume3dToolGroup = ToolGroupManager.createToolGroup(volume3dToolGroupId);
      volume3dToolGroup.addTool(PanTool.toolName);
      volume3dToolGroup.addTool(ZoomTool.toolName);
      
      // Set active tools for 3D
      volume3dToolGroup.setToolActive(PanTool.toolName, {
        bindings: [{ mouseButton: MouseBindings.Primary }]
      });
      volume3dToolGroup.setToolActive(ZoomTool.toolName, {
        bindings: [{ mouseButton: MouseBindings.Secondary }]
      });
      
      // Add viewports to tool groups
      mprToolGroup.addViewport(viewportIds.axial, renderingEngineId);
      mprToolGroup.addViewport(viewportIds.sagittal, renderingEngineId);
      mprToolGroup.addViewport(viewportIds.coronal, renderingEngineId);
      volume3dToolGroup.addViewport(viewportIds.volume3d, renderingEngineId);
      
      // Create and load volume
      const volumeId = `volume-${Date.now()}`;
      const volume = await volumeLoader.createAndCacheVolume(volumeId, {
        imageIds,
      });
      
      await volume.load();
      
      // Set volumes on viewports
      await setVolumesForViewports(
        renderingEngine,
        [{ volumeId }],
        [viewportIds.axial, viewportIds.sagittal, viewportIds.coronal, viewportIds.volume3d]
      );
      
      // Render all viewports
      renderingEngine.render();
      
      // Cleanup function
      return () => {
        if (renderingEngine) {
          renderingEngine.destroy();
        }
      };
    };
    
    setup();
  }, [imageIds]);
  
  return (
    <div 
      ref={containerRef} 
      style={{ 
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: '5px',
        width: '100%',
        height: '700px'
      }}
    >
      <div ref={viewportRefs.axial} style={{ backgroundColor: '#000' }} />
      <div ref={viewportRefs.sagittal} style={{ backgroundColor: '#000' }} />
      <div ref={viewportRefs.coronal} style={{ backgroundColor: '#000' }} />
      <div ref={viewportRefs.volume3d} style={{ backgroundColor: '#000' }} />
    </div>
  );
};

export default MultiViewportLayout;
```

## Common Issues and Solutions

### Issue 1: Missing WebGL Support

**Problem**: Cornerstone3D requires WebGL2 support in the browser.

**Solution**:
```javascript
function hasWebGL2Support() {
  try {
    const canvas = document.createElement('canvas');
    return !!window.WebGL2RenderingContext && 
           !!canvas.getContext('webgl2');
  } catch (e) {
    return false;
  }
}

// Check before initialization
if (!hasWebGL2Support()) {
  console.error('WebGL2 is not supported in this browser. Cornerstone3D requires WebGL2.');
  // Fall back to a message or alternative viewer
  return;
}
```

### Issue 2: Volume Loading Failures

**Problem**: Volumes fail to load or render correctly.

**Solution**:
```javascript
// Always handle volume loading errors
try {
  const volume = await volumeLoader.createAndCacheVolume(volumeId, {
    imageIds,
  });
  
  // Wait for volume to load before setting on viewport
  await volume.load();
  
  // Verify volume is loaded before rendering
  if (volume.isLoaded !== true) {
    throw new Error('Volume failed to load completely');
  }
  
  // Set on viewport and render
  await setVolumesForViewports(renderingEngine, [{ volumeId }], [viewportId]);
  renderingEngine.render();
} catch (error) {
  console.error('Volume loading failed', error);
  // Provide fallback or error message
}
```

### Issue 3: Tool Binding Conflicts

**Problem**: Mouse events are triggering multiple tools or not working as expected.

**Solution**:
```javascript
// Clear existing tools when setting up new ones
const toolGroupId = 'myToolGroup';
// Remove any existing tool group with this ID
if (ToolGroupManager.getToolGroup(toolGroupId)) {
  ToolGroupManager.destroyToolGroup(toolGroupId);
}

// Create new tool group
const toolGroup = ToolGroupManager.createToolGroup(toolGroupId);

// Ensure tools don't conflict by using different mouse buttons
toolGroup.setToolActive(WindowLevelTool.toolName, {
  bindings: [{ mouseButton: MouseBindings.Primary }]
});

toolGroup.setToolActive(PanTool.toolName, {
  bindings: [{ mouseButton: MouseBindings.Secondary }]
});

// Or use modifier keys
toolGroup.setToolActive(AnotherTool.toolName, {
  bindings: [{ 
    mouseButton: MouseBindings.Primary,
    modifierKey: 'Shift'
  }]
});
```

### Issue 4: Memory Management

**Problem**: Memory leaks when creating and destroying viewports.

**Solution** (From RadSysX cornerstone3DInit.ts):
```javascript
// Proper cleanup function
export function cleanupCornerstone3D(
  renderingEngineId: string, 
  toolGroupIds?: string[]
): void {
  // Clean up tool groups if provided
  if (toolGroupIds && toolGroupIds.length > 0) {
    for (const toolGroupId of toolGroupIds) {
      const toolGroup = ToolGroupManager.getToolGroup(toolGroupId);
      if (toolGroup) {
        // First remove all viewports from the tool group
        toolGroup.removeViewports(renderingEngineId);
        // Then destroy the tool group
        ToolGroupManager.destroyToolGroup(toolGroupId);
      }
    }
  }
  
  // Clean up the rendering engine
  const renderingEngine = cornerstone3D.getRenderingEngine(renderingEngineId);
  if (renderingEngine) {
    renderingEngine.destroy();
  }
  
  // Clear cache (optionally, if desired)
  // cache.purgeCache();
}
```

### Issue 5: CORS and Image Loading

**Problem**: Images fail to load due to CORS restrictions.

**Solution**:
```javascript
// Configure correct CORS settings
dicomImageLoaderLib.configure({
  useWebWorkers: true,
  decodeConfig: {
    convertFloatPixelDataToInt: false,
    use16BitDataType: true,
  },
});

dicomImageLoaderLib.webWorkerManager.initialize({
  maxWebWorkers: Math.min(navigator.hardwareConcurrency || 4, 4),
  startWebWorkersOnDemand: true,
  taskConfiguration: {
    decodeTask: {
      initializeCodecsOnStartup: true,
      usePDFJS: false,
      strict: false,
    },
  },
});

// For custom requests with authentication
const imageId = 'wadors:https://server.com/studies/1.2.3/series/1.2.4/instances/1.2.5/frames/1';
const headers = {
  Authorization: 'Bearer TOKEN_HERE',
  'Access-Control-Allow-Origin': '*',
};

// Use request headers provider from dicomImageLoaderLib
dicomImageLoaderLib.wadors.setHeaderProvider(() => headers);
```

## Testing and Validation

When migrating, test key functionality:

1. **Basic image display** - Ensure images load correctly in stack viewports
2. **Volume rendering** - Test MPR views and 3D volumes
3. **Tool interactions** - Verify all tools work as expected
4. **Segmentation** - Test creating and displaying segmentations
5. **Performance** - Check performance with large datasets

Create test cases for each component:

```javascript
// Example test for initialization
test('should initialize Cornerstone3D', async () => {
  await initializeCornerstone3D();
  
  // Check if core is initialized
  expect(cornerstone3D.getEnabledElementByIds).toBeDefined();
  
  // Check if tools are initialized
  expect(ToolGroupManager.createToolGroup).toBeDefined();
});

// Example test for viewport creation
test('should create a viewport', async () => {
  const renderingEngine = new RenderingEngine('testEngine');
  const element = document.createElement('div');
  document.body.appendChild(element);
  
  renderingEngine.enableElement({
    viewportId: 'testViewport',
    type: Enums.ViewportType.STACK,
    element
  });
  
  const viewport = renderingEngine.getViewport('testViewport');
  expect(viewport).toBeDefined();
  
  // Clean up
  renderingEngine.destroy();
  document.body.removeChild(element);
});
```

## RadSysX-Specific Implementation

The RadSysX project already has a solid foundation for migrating to Cornerstone3D. The key files are:

1. **cornerstoneInit.ts** - Legacy Cornerstone implementation
2. **cornerstone3DInit.ts** - Modern Cornerstone3D implementation
3. **DicomViewer.tsx** - 2D viewer component using Legacy Cornerstone
4. **AdvancedViewer.tsx** - 3D viewer component using Cornerstone3D

To complete the migration:

1. Replace DicomViewer.tsx with a Cornerstone3D-based implementation
2. Update ViewportManager.tsx to use Cornerstone3D for all viewports
3. Standardize on single tool mapping approach from UI tools to Cornerstone3D tools
4. Ensure consistent cleanup when components unmount

### Recommended Migration Steps for RadSysX

1. **Update package.json** - Remove legacy packages, ensure correct Cornerstone3D versions
2. **Consolidate initialization** - Use only cornerstone3DInit.ts, remove cornerstoneInit.ts
3. **Update DicomViewer component** - Refactor to use Cornerstone3D APIs
4. **Update ViewportManager** - Make it work exclusively with Cornerstone3D
5. **Test thoroughly** - Ensure all existing functionality works with new implementation

### Cornerstone Compatibility Mode

For a gradual migration, you can implement a compatibility layer:

```typescript
// compatibility.ts
import * as cornerstone3D from '@cornerstonejs/core';
import * as cornerstoneTools3D from '@cornerstonejs/tools';

// Create a legacy-like API for gradual migration
export const cornerstone = {
  enable: (element: HTMLElement) => {
    const renderingEngine = new cornerstone3D.RenderingEngine('compatEngine');
    renderingEngine.enableElement({
      viewportId: element.id || 'viewport',
      type: cornerstone3D.Enums.ViewportType.STACK,
      element
    });
    return renderingEngine;
  },
  
  disable: (element: HTMLElement) => {
    // Find and destroy the rendering engine for this element
    const engines = cornerstone3D.getRenderingEngines();
    for (const engine of engines) {
      const viewports = engine.getViewports();
      for (const viewport of viewports) {
        if (viewport.element === element) {
          engine.disableElement(viewport.id);
          return;
        }
      }
    }
  },
  
  // Add more legacy-compatible methods as needed
};
```

This approach provides a stepping stone while gradually refactoring the codebase to use the new APIs directly. 