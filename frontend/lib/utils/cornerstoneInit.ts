/**
 * Cornerstone 3D Initialization and Utilities
 * Updated for Cornerstone3D v3.x - follows official examples and migration guide
 * 
 * Key changes in v3.x:
 * - SharedArrayBuffer no longer required
 * - GPU detection simplified (no internet dependency) 
 * - CPU fallback automatically handled
 * - Improved cache management
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { 
  Types as CoreTypes,
  Enums as CoreEnums,
  CONSTANTS as CoreCONSTANTS_TYPENAME,
  RenderingEngine as CoreRenderingEngineClass,
  metaData as CoreMetaData,
  imageLoader as CoreImageLoader,
  utilities as CoreUtilities,
} from '@cornerstonejs/core';

// Note: MouseBindings enum removed due to inconsistent export path in v3.x; numeric literal bindings used instead.
import type { 
  Types as ToolTypes_NAMESPACE, // Alias for the namespace type
  Enums as ToolEnums,
  ToolGroupManager as ToolGroupManagerClass, 
  SynchronizerManager as SynchronizerManagerClass,
  PanTool as PanToolClass_TYPENAME,
  ZoomTool as ZoomToolClass_TYPENAME,
  StackScrollTool as StackScrollToolClass_TYPENAME, 
  WindowLevelTool as WindowLevelToolClass_TYPENAME,
  LengthTool as LengthToolClass_TYPENAME,
  ProbeTool as ProbeToolClass_TYPENAME,
  RectangleROITool as RectangleROIToolClass_TYPENAME,
  EllipticalROITool as EllipticalROIToolClass_TYPENAME,
  BidirectionalTool as BidirectionalToolClass_TYPENAME,
  AngleTool as AngleToolClass_TYPENAME,
  BrushTool as BrushToolClass_TYPENAME, 
  CircleScissorsTool as CircleScissorsToolClass_TYPENAME, 
  RectangleScissorsTool as RectangleScissorsToolClass_TYPENAME 
} from '@cornerstonejs/tools';

// UI Tool mapping types for consistency
export type UiToolType = 
  | 'Pan' | 'Zoom' | 'WindowLevel' | 'StackScroll' 
  | 'Length' | 'Probe' | 'RectangleROI' | 'EllipticalROI'
  | 'Bidirectional' | 'Angle'
  | 'Brush' | 'SphereBrush' 
  | 'CircleScissor' | 'RectangleScissor'
  | null;

interface CornerstoneModulesType {
  csCoreResolved?: any; // Contiene csCoreModule.default o csCoreModule
  csToolsResolved?: any; // Contiene csToolsModule.default o csToolsModule
  csDicomImageLoaderResolved?: any;

  // Tipi dei namespace/oggetti specifici per type hinting
  CoreTypes?: typeof CoreTypes;
  CoreEnums?: typeof CoreEnums;
  CoreCONSTANTS?: typeof CoreCONSTANTS_TYPENAME;
  CoreRenderingEngineClass?: typeof CoreRenderingEngineClass;
  CoreMetaData?: typeof CoreMetaData;
  CoreImageLoader?: typeof CoreImageLoader;
  CoreVolumeLoader?: any;
  CoreUtilities?: typeof CoreUtilities;
  CoreCache?: any;
  getRenderingEngine?: typeof import('@cornerstonejs/core').getRenderingEngine; // Funzione

  ToolTypes?: typeof ToolTypes_NAMESPACE; // Use the aliased namespace type
  ToolEnums?: typeof ToolEnums;
  ToolGroupManagerClass?: typeof ToolGroupManagerClass;
  SynchronizerManagerClass?: typeof SynchronizerManagerClass;

  // Campi per le classi dei Tool specifici
  PanToolClass?: typeof PanToolClass_TYPENAME;
  ZoomToolClass?: typeof ZoomToolClass_TYPENAME;
  StackScrollToolClass?: typeof StackScrollToolClass_TYPENAME;
  WindowLevelToolClass?: typeof WindowLevelToolClass_TYPENAME;
  LengthToolClass?: typeof LengthToolClass_TYPENAME;
  ProbeToolClass?: typeof ProbeToolClass_TYPENAME;
  RectangleROIToolClass?: typeof RectangleROIToolClass_TYPENAME;
  EllipticalROIToolClass?: typeof EllipticalROIToolClass_TYPENAME;
  BidirectionalToolClass?: typeof BidirectionalToolClass_TYPENAME;
  AngleToolClass?: typeof AngleToolClass_TYPENAME;
  BrushToolClass?: typeof BrushToolClass_TYPENAME;
  CircleScissorsToolClass?: typeof CircleScissorsToolClass_TYPENAME;
  RectangleScissorsToolClass?: typeof RectangleScissorsToolClass_TYPENAME;
}

interface GlobalCornerstoneState {
  isInitializing: boolean;
  isInitializedCore: boolean;
  isInitializedTools: boolean;
  isInitializedDicomLoader: boolean;
  modulesLoaded: boolean;
  initializationPromise?: Promise<void>; // ensures callers can await full init
  renderingEngine: CoreTypes.IRenderingEngine | null;
  toolGroup: ToolTypes_NAMESPACE.IToolGroup | null; // Use aliased namespace for IToolGroup
}

let cornerstoneModules: CornerstoneModulesType | undefined;

function getGlobalCornerstoneState(): GlobalCornerstoneState {
  if (!(globalThis as any).__cornerstoneGlobalState) {
    (globalThis as any).__cornerstoneGlobalState = {
      isInitializing: false,
      isInitializedCore: false,
      isInitializedTools: false,
      isInitializedDicomLoader: false,
      modulesLoaded: false,
      renderingEngine: null,
      toolGroup: null,
    };
  }
  return (globalThis as any).__cornerstoneGlobalState;
}

async function loadCornerstoneModules(): Promise<CornerstoneModulesType> {
  if (typeof window === 'undefined') {
    console.warn('Cornerstone modules can only be loaded in browser environment. Returning placeholders.');
    // Return a fully populated placeholder to satisfy the type, actual values are undefined
    return {
        csCoreResolved: undefined, csToolsResolved: undefined, csDicomImageLoaderResolved: undefined,
        CoreTypes: undefined, CoreEnums: undefined, CoreCONSTANTS: undefined,
        CoreRenderingEngineClass: undefined, CoreMetaData: undefined, CoreImageLoader: undefined,
        CoreVolumeLoader: undefined, CoreUtilities: undefined, CoreCache: undefined,
        getRenderingEngine: (() => undefined) as any,
        ToolTypes: undefined, ToolEnums: undefined, ToolGroupManagerClass: undefined,
        SynchronizerManagerClass: undefined, PanToolClass: undefined, ZoomToolClass: undefined,
        StackScrollToolClass: undefined, WindowLevelToolClass: undefined, LengthToolClass: undefined,
        ProbeToolClass: undefined, RectangleROIToolClass: undefined, EllipticalROIToolClass: undefined,
        BidirectionalToolClass: undefined, AngleToolClass: undefined, BrushToolClass: undefined,
        CircleScissorsToolClass: undefined, RectangleScissorsToolClass: undefined,
      } as CornerstoneModulesType;
  }

  const globalState = getGlobalCornerstoneState();
  if (globalState.modulesLoaded && cornerstoneModules) {
    return cornerstoneModules;
  }

  console.log('Loading Cornerstone 3D modules dynamically...');
  try {
    const [
      csCoreModuleResponse,
      csToolsModuleResponse,
      csDicomImageLoaderModuleResponse,
    ] = await Promise.all([
      import('@cornerstonejs/core'),
      import('@cornerstonejs/tools'),
      import('@cornerstonejs/dicom-image-loader'),
    ]);

    const csCoreResolved = csCoreModuleResponse.default || csCoreModuleResponse;
    const csToolsResolved = csToolsModuleResponse.default || csToolsModuleResponse;
    const csDicomImageLoaderResolved = csDicomImageLoaderModuleResponse.default || csDicomImageLoaderModuleResponse;

    const modulesResult: CornerstoneModulesType = {
      csCoreResolved,
      csToolsResolved,
      csDicomImageLoaderResolved,

      CoreTypes: (csCoreResolved as any).Types as typeof CoreTypes, 
      CoreEnums: (csCoreResolved as any).Enums as typeof CoreEnums,
      CoreCONSTANTS: (csCoreResolved as any).CONSTANTS as typeof CoreCONSTANTS_TYPENAME,
      CoreRenderingEngineClass: (csCoreResolved as any).RenderingEngine as typeof CoreRenderingEngineClass,
      CoreMetaData: (csCoreResolved as any).metaData as typeof CoreMetaData,
      CoreImageLoader: (csCoreResolved as any).imageLoader as typeof CoreImageLoader,
      CoreVolumeLoader: (csCoreResolved as any).volumeLoader as any,
      CoreUtilities: (csCoreResolved as any).utilities as typeof CoreUtilities,
      CoreCache: (csCoreResolved as any).cache as any,
      getRenderingEngine: (csCoreResolved as any).getRenderingEngine as typeof import('@cornerstonejs/core').getRenderingEngine,

      ToolTypes: (csToolsResolved as any).Types as typeof ToolTypes_NAMESPACE,
      ToolEnums: (csToolsResolved as any).Enums as typeof ToolEnums,
      ToolGroupManagerClass: (csToolsResolved as any).ToolGroupManager as typeof ToolGroupManagerClass,
      SynchronizerManagerClass: (csToolsResolved as any).SynchronizerManager as typeof SynchronizerManagerClass,

      // Assegna le classi dei Tool specifici
      PanToolClass: (csToolsResolved as any).PanTool as typeof PanToolClass_TYPENAME,
      ZoomToolClass: (csToolsResolved as any).ZoomTool as typeof ZoomToolClass_TYPENAME,
      StackScrollToolClass: (csToolsResolved as any).StackScrollTool as typeof StackScrollToolClass_TYPENAME,
      WindowLevelToolClass: (csToolsResolved as any).WindowLevelTool as typeof WindowLevelToolClass_TYPENAME,
      LengthToolClass: (csToolsResolved as any).LengthTool as typeof LengthToolClass_TYPENAME,
      ProbeToolClass: (csToolsResolved as any).ProbeTool as typeof ProbeToolClass_TYPENAME,
      RectangleROIToolClass: (csToolsResolved as any).RectangleROITool as typeof RectangleROIToolClass_TYPENAME,
      EllipticalROIToolClass: (csToolsResolved as any).EllipticalROITool as typeof EllipticalROIToolClass_TYPENAME,
      BidirectionalToolClass: (csToolsResolved as any).BidirectionalTool as typeof BidirectionalToolClass_TYPENAME,
      AngleToolClass: (csToolsResolved as any).AngleTool as typeof AngleToolClass_TYPENAME,
      BrushToolClass: (csToolsResolved as any).BrushTool as typeof BrushToolClass_TYPENAME,
      CircleScissorsToolClass: (csToolsResolved as any).CircleScissorsTool as typeof CircleScissorsToolClass_TYPENAME,
      RectangleScissorsToolClass: (csToolsResolved as any).RectangleScissorsTool as typeof RectangleScissorsToolClass_TYPENAME,
    };

    cornerstoneModules = modulesResult;
    globalState.modulesLoaded = true;
    
    console.log('✅ Cornerstone 3D modules loaded successfully');
    
    return modulesResult;
  } catch (error) {
    console.error('❌ Failed to load Cornerstone 3D modules:', error);
    throw new Error('Failed to load required Cornerstone3D modules');
  }
}

/**
 * Initialize Cornerstone 3D with v3.x compatible configuration
 * Now much simpler - no SharedArrayBuffer, automatic GPU detection
 */
export async function initializeCornerstone3D(): Promise<void> {
  if (typeof window === 'undefined') {
    console.log('Skipping Cornerstone 3D initialization on server side');
    return;
  }

  const globalState = getGlobalCornerstoneState();

  if (globalState.isInitializedCore && globalState.isInitializedTools && globalState.isInitializedDicomLoader) {
    console.log('Cornerstone 3D already fully initialized (global state).');
    return;
  }

  if (globalState.isInitializing) {
    // Another call is already initializing; simply await the stored promise
    console.log('Cornerstone 3D initialization already in progress – awaiting.');
    if (globalState.initializationPromise) {
      await globalState.initializationPromise;
    }
    return;
  }

  console.log('Initializing Cornerstone 3D (v3.x compatible)...');
  globalState.isInitializing = true;

  // Store the promise so concurrent callers can await
  globalState.initializationPromise = (async () => {
    try {
      const modules = await loadCornerstoneModules();
      // Ensure all crucial modules and their properties are loaded
      if (!modules.csCoreResolved || !modules.csToolsResolved || 
          !modules.CoreEnums || !modules.ToolGroupManagerClass || !modules.CoreCONSTANTS ||
          !modules.CoreRenderingEngineClass || !modules.getRenderingEngine || !modules.ToolEnums || !modules.ToolTypes ||
          !modules.PanToolClass || !modules.ZoomToolClass || !modules.StackScrollToolClass || 
          !modules.WindowLevelToolClass || !modules.BrushToolClass) { 
        throw new Error('Failed to load critical Cornerstone 3D modules/objects or their properties for initialization.');
      }

      // Destructure necessary classes and objects from modules
      const {
        csCoreResolved,
        csToolsResolved,
        csDicomImageLoaderResolved,
        ToolGroupManagerClass: ToolGroupManager,
        // CoreCONSTANTS and ToolTypes will be accessed via modules.CoreCONSTANTS and modules.ToolTypes
        CoreRenderingEngineClass: RenderingEngine,
        getRenderingEngine,
        PanToolClass, ZoomToolClass, StackScrollToolClass, WindowLevelToolClass, LengthToolClass,
        ProbeToolClass, RectangleROIToolClass, EllipticalROIToolClass, BidirectionalToolClass, AngleToolClass,
        BrushToolClass
      } = modules;

      if (!globalState.isInitializedCore) {
        console.log('Initializing Cornerstone 3D Core...');
        const cornerstoneConfig = {};
        csCoreResolved.init(cornerstoneConfig);
        globalState.isInitializedCore = true;
        console.log('✅ Cornerstone 3D Core initialized');
      }

      if (!globalState.isInitializedTools) {
        console.log('Initializing Cornerstone 3D Tools...');
        csToolsResolved.init();
        globalState.isInitializedTools = true;
        console.log('✅ Cornerstone 3D Tools initialized');
      }

      if (!globalState.isInitializedDicomLoader) {
        console.log('Initializing Cornerstone DICOM Image Loader...');
        // init() registers wadouri/wadors/dicomfile scheme handlers and spawns decode workers
        csDicomImageLoaderResolved.init();
        globalState.isInitializedDicomLoader = true;
        console.log('✅ Cornerstone DICOM Image Loader initialized');
      }
      
      if (!globalState.renderingEngine) {
          const re = getRenderingEngine(DEFAULT_RENDERING_ENGINE_ID);
          if (re) {
              globalState.renderingEngine = re;
          } else {
              globalState.renderingEngine = new RenderingEngine(DEFAULT_RENDERING_ENGINE_ID);
          }
      }
      
      if (ToolGroupManager && !globalState.toolGroup) {
          const defaultToolGroupId = 'default-tool-group';
          let toolGroup : ToolTypes_NAMESPACE.IToolGroup | undefined = ToolGroupManager.getToolGroup(defaultToolGroupId);
          if (!toolGroup) {
              toolGroup = ToolGroupManager.createToolGroup(defaultToolGroupId) as ToolTypes_NAMESPACE.IToolGroup;
          }
          if (toolGroup) {
              globalState.toolGroup = toolGroup;
              if (toolGroup && Object.keys((toolGroup as any).getToolInstances?.() ?? {}).length === 0) {
                  const toolsToAdd = [
                      PanToolClass, ZoomToolClass, StackScrollToolClass, WindowLevelToolClass, LengthToolClass, 
                      ProbeToolClass, RectangleROIToolClass, EllipticalROIToolClass, BidirectionalToolClass, AngleToolClass,
                      BrushToolClass 
                  ];

                  toolsToAdd.forEach(ToolClassToAdd => {
                      if (ToolClassToAdd && ToolClassToAdd.toolName) {
                          csToolsResolved.addTool(ToolClassToAdd); 
                          toolGroup!.addTool(ToolClassToAdd.toolName);
                      }
                  });
                  
                  // NEW ➜ Activate navigation tools once with fallback bindings
                  try {
                    const secondaryBtn = modules.ToolEnums?.MouseBindings?.Secondary ?? 2;
                    const wheelBtn = modules.ToolEnums?.MouseBindings?.Wheel;
                    if (PanToolClass?.toolName) {
                      toolGroup.setToolActive(PanToolClass.toolName, {
                        bindings: [{ mouseButton: secondaryBtn }],
                      });
                    }
                    if (ZoomToolClass?.toolName) {
                      toolGroup.setToolActive(ZoomToolClass.toolName, {
                        bindings: [{ mouseButton: wheelBtn }],
                      });
                      // Disable implicit pan when zooming via wheel
                      toolGroup.setToolConfiguration?.(ZoomToolClass.toolName, { pan: false }, true);
                    }
                  } catch (err) {
                    console.warn('⚠️ Unable to set default Pan/Zoom bindings:', err);
                  }
              }
          }
      }

      console.log('🎉 Cornerstone 3D initialization complete (v3.x)!');
    } catch (_error: any) { 
      console.error('❌ Cornerstone 3D initialization failed:', _error);
      throw new Error(`Cornerstone 3D initialization failed: ${(_error as Error).message}`);
    } finally {
      globalState.isInitializing = false;
    }
  })();

  await globalState.initializationPromise;
  return;
}

/**
 * Get the singleton RenderingEngine instance
 */
export async function getRenderingEngineInstance(renderingEngineId: string = DEFAULT_RENDERING_ENGINE_ID): Promise<CoreTypes.IRenderingEngine> {
  const globalState = getGlobalCornerstoneState();
  
  if (globalState.renderingEngine && globalState.renderingEngine.id === renderingEngineId) {
    return globalState.renderingEngine;
  }
  
  await initializeCornerstone3D(); 
  const modules = cornerstoneModules; 

  if (!modules || !modules.getRenderingEngine || !modules.CoreRenderingEngineClass) {
    throw new Error('Cornerstone Core modules not available to get RenderingEngine or RENDERING_ENGINE_UID is missing.');
  }

  let renderingEngine = modules.getRenderingEngine(renderingEngineId);
  if (!renderingEngine) {
    renderingEngine = new modules.CoreRenderingEngineClass(renderingEngineId);
    if (renderingEngineId === DEFAULT_RENDERING_ENGINE_ID) {
        globalState.renderingEngine = renderingEngine; 
    }
  }
  return renderingEngine;
}

/**
 * Get Cornerstone volumeLoader module (v3.x)
 */
export async function getVolumeLoader(): Promise<any> {
  await initializeCornerstone3D();
  const modules = cornerstoneModules;
  if (!modules?.CoreVolumeLoader) {
    throw new Error('Cornerstone volumeLoader module not available.');
  }
  return modules.CoreVolumeLoader;
}

/**
 * Get Cornerstone imageLoader module (v3.x)
 * Used to pre-load images and populate the metadata provider
 */
export async function getImageLoader(): Promise<any> {
  await initializeCornerstone3D();
  const modules = cornerstoneModules;
  if (!modules?.CoreImageLoader) {
    throw new Error('Cornerstone imageLoader module not available.');
  }
  return modules.CoreImageLoader;
}

/**
 * Get Cornerstone cache module (v3.x)
 */
export async function getCache(): Promise<any> {
  await initializeCornerstone3D();
  const modules = cornerstoneModules;
  if (!modules?.CoreCache) {
    throw new Error('Cornerstone cache module not available.');
  }
  return modules.CoreCache;
}

/**
 * Create tool group with v3.x compatible API
 */
export async function createToolGroup(toolGroupId: string): Promise<ToolTypes_NAMESPACE.IToolGroup> {
  await initializeCornerstone3D(); 
  const modules = cornerstoneModules;

  if (!modules || !modules.ToolGroupManagerClass) {
    throw new Error('Cornerstone ToolGroupManagerClass not available.');
  }
  
  let toolGroup = modules.ToolGroupManagerClass.getToolGroup(toolGroupId);
  if (!toolGroup) {
    toolGroup = modules.ToolGroupManagerClass.createToolGroup(toolGroupId);

    // Populate the toolGroup with the standard tool set once, immediately after creation
    if (toolGroup) {
      const {
        PanToolClass,
        ZoomToolClass,
        StackScrollToolClass,
        WindowLevelToolClass,
        LengthToolClass,
        ProbeToolClass,
        RectangleROIToolClass,
        EllipticalROIToolClass,
        BidirectionalToolClass,
        AngleToolClass,
        BrushToolClass,
        CircleScissorsToolClass,
        RectangleScissorsToolClass,
        csToolsResolved,
      } = modules as any;

      const toolClasses = [
        PanToolClass,
        ZoomToolClass,
        StackScrollToolClass,
        WindowLevelToolClass,
        LengthToolClass,
        ProbeToolClass,
        RectangleROIToolClass,
        EllipticalROIToolClass,
        BidirectionalToolClass,
        AngleToolClass,
        BrushToolClass,
        CircleScissorsToolClass,
        RectangleScissorsToolClass,
      ].filter(Boolean);

      toolClasses.forEach((ToolClass: any) => {
        try {
          if (!ToolClass?.toolName) return;
          // Register globally if not already present
          if (typeof csToolsResolved?.addTool === 'function') {
            csToolsResolved.addTool(ToolClass);
          }
          // Add to the newly created tool group
          if (!((toolGroup as any).hasTool?.(ToolClass.toolName))) {
            toolGroup!.addTool(ToolClass.toolName);
          }
        } catch (err) {
          console.warn(`⚠️  Unable to register or add tool '${ToolClass?.toolName}' to group '${toolGroupId}':`, err);
        }
      });

      // NEW ➜ Activate navigation tools once with fallback bindings
      try {
        const secondaryBtn = modules.ToolEnums?.MouseBindings?.Secondary ?? 2;
        const wheelBtn = modules.ToolEnums?.MouseBindings?.Wheel;
        if (PanToolClass?.toolName) {
          toolGroup.setToolActive(PanToolClass.toolName, {
            bindings: [{ mouseButton: secondaryBtn }],
          });
        }
        if (ZoomToolClass?.toolName) {
          toolGroup.setToolActive(ZoomToolClass.toolName, {
            bindings: [{ mouseButton: wheelBtn }],
          });
          // Disable implicit pan when zooming via wheel
          toolGroup.setToolConfiguration?.(ZoomToolClass.toolName, { pan: false }, true);
        }
      } catch (err) {
        console.warn('⚠️ Unable to set default Pan/Zoom bindings:', err);
      }
    }
  }
  if (!toolGroup) { 
      throw new Error(`Failed to create or get tool group: ${toolGroupId}`);
  }
  return toolGroup as ToolTypes_NAMESPACE.IToolGroup; // Cast esplicito
}

/**
 * Map UI tool names to Cornerstone 3D tool names
 */
export async function mapUiToolToCornerstone3D(uiTool: UiToolType): Promise<string | null> {
    if (!uiTool) return null;

    await initializeCornerstone3D();
    const modules = cornerstoneModules;
    if (!modules || !modules.csToolsResolved || 
        !modules.PanToolClass || !modules.ZoomToolClass || !modules.StackScrollToolClass || 
        !modules.WindowLevelToolClass || !modules.LengthToolClass || !modules.ProbeToolClass || 
        !modules.RectangleROIToolClass || !modules.EllipticalROIToolClass || !modules.BidirectionalToolClass || 
        !modules.AngleToolClass || !modules.BrushToolClass || 
        !modules.CircleScissorsToolClass || !modules.RectangleScissorsToolClass
    ) { 
        console.warn("Cornerstone tools module or specific tool classes not loaded for tool mapping.");
        return uiTool; 
    }

    switch(uiTool) {
        case 'Pan': return modules.PanToolClass.toolName;
        case 'Zoom': return modules.ZoomToolClass.toolName;
        case 'WindowLevel': return modules.WindowLevelToolClass.toolName;
        case 'StackScroll': return modules.StackScrollToolClass.toolName;
        case 'Length': return modules.LengthToolClass.toolName;
        case 'Probe': return modules.ProbeToolClass.toolName;
        case 'RectangleROI': return modules.RectangleROIToolClass.toolName;
        case 'EllipticalROI': return modules.EllipticalROIToolClass.toolName;
        case 'Bidirectional': return modules.BidirectionalToolClass.toolName;
        case 'Angle': return modules.AngleToolClass.toolName;
        case 'Brush': return modules.BrushToolClass.toolName; 
        case 'SphereBrush': return modules.BrushToolClass.toolName; 
        case 'CircleScissor': return modules.CircleScissorsToolClass.toolName;
        case 'RectangleScissor': return modules.RectangleScissorsToolClass.toolName;
        default:
            console.warn(`No specific Cornerstone 3D tool mapping for UI tool: ${uiTool}. Using name directly.`);
            return uiTool;
    }
}

/**
 * Set active tool for a tool group (v3.x compatible)
 */
export async function setActiveToolInGroup(toolGroupId: string, uiTool: UiToolType): Promise<void> {
  const toolGroup = await createToolGroup(toolGroupId);
  const modules = cornerstoneModules!;

  const newToolName = await mapUiToolToCornerstone3D(uiTool);

  // Handle de-selection (passing null/undefined means no active tool)
  if (!newToolName) {
    toolGroup.setToolActive(undefined as any, {} as any);
    return;
  }

  const prevPrimary = toolGroup.getCurrentActivePrimaryToolName?.();
  if (prevPrimary === newToolName) {
    return;
  }

  // Gracefully cancel any ongoing drawing on the previous tool before passivating it
  try {
    if (prevPrimary) {
      // Skip cancel/complete for navigation tools and Window/Level to preserve VOI state
      const wlName = modules?.WindowLevelToolClass?.toolName;
      const panName = modules?.PanToolClass?.toolName;
      const zoomName = modules?.ZoomToolClass?.toolName;
      const scrollName = modules?.StackScrollToolClass?.toolName;
      const skipCleanupFor = new Set([wlName, panName, zoomName, scrollName].filter(Boolean) as string[]);
      if (skipCleanupFor.has(prevPrimary)) {
        // Do not cancel/complete; this avoids reverting VOI or navigation state
        throw 'skip-cleanup';
      }
      const prevInst: any = toolGroup.getToolInstance?.(prevPrimary);
      if (prevInst) {
        // Annulla eventuale disegno in corso su **tutti** i viewport e raccogli gli UID delle annotazioni create –
        const canceledUIDs: string[] = [];
        toolGroup?.viewportsInfo?.forEach?.(({ renderingEngineId, viewportId }: any) => {
          const engine = modules?.getRenderingEngine?.(renderingEngineId);
          const vp: any = engine?.getViewport?.(viewportId);
          if (vp?.element && typeof prevInst.cancel === 'function') {
            const uid = prevInst.cancel(vp.element);
            if (uid) canceledUIDs.push(uid);
          }
        });

        // Completa qualsiasi operazione pendente (safe-guard)
        if (typeof prevInst.complete === 'function') {
          prevInst.complete();
        }

        // Rimuove annotazioni corrotte/incomplete per evitare crash (es. RectangleROI senza handles)
        if (canceledUIDs.length > 0) {
          const removeAnnotationFn = modules?.csToolsResolved?.annotation?.removeAnnotation;
          if (typeof removeAnnotationFn === 'function') {
            canceledUIDs.forEach((uid) => {
              try {
                removeAnnotationFn(uid);
              } catch {}
            });
          }
        }
      }
    }
  } catch {}

  // NEW ➜ Passivate previous primary tool before changing bindings
  if (prevPrimary && prevPrimary !== newToolName) {
    try {
      toolGroup.setToolPassive(prevPrimary);
    } catch {}
  }

  // Ensure new tool is available in the group
  try {
    if (!toolGroup.hasTool?.(newToolName)) {
      toolGroup.addTool(newToolName);
    }
  } catch {}

  // Activate new primary tool on LMB, but for Window/Level keep secondary/wheel bindings to coexist with Pan/Zoom behavior
  const isWindowLevel = newToolName === modules?.WindowLevelToolClass?.toolName;
  toolGroup.setToolActive(newToolName, {
    bindings: [{ mouseButton: modules.ToolEnums?.MouseBindings?.Primary ?? 1 }],
  });

  // Implementa modalità Pan+Zoom combinata per UX radiologica ottimale
  try {
    const panToolName = modules?.PanToolClass?.toolName;
    const zoomToolName = modules?.ZoomToolClass?.toolName;
    
    if (panToolName && zoomToolName) {
      // Assicurati che Pan e Zoom siano registrati (una tantum)
      if (!toolGroup.hasTool?.(panToolName)) {
        toolGroup.addTool(panToolName);
      }
      if (!toolGroup.hasTool?.(zoomToolName)) {
        toolGroup.addTool(zoomToolName);
      }

      // Se il tool primario è Pan o Zoom dobbiamo invertire i ruoli dei due navigation tools
      if (newToolName === panToolName) {
        // Pan primario + Zoom su wheel
        toolGroup.setToolActive(zoomToolName, {
          bindings: [{ mouseButton: modules.ToolEnums?.MouseBindings?.Wheel }]
        });
      } else if (newToolName === zoomToolName) {
        // Zoom primario + Pan su RMB
        toolGroup.setToolActive(panToolName, {
          bindings: [{ mouseButton: modules.ToolEnums?.MouseBindings?.Secondary ?? 2 }]
        });
      }
      // Caso annotazioni: Pan/Zoom sono già attivi con i binding secondari/wheel assegnati al momento della creazione del ToolGroup.
    }
  } catch {}

  // Preserve VOI: when switching away from Window/Level, do not reset synchronizer state.
  // Additionally, ensure Zoom configuration avoids implicit pan.
  if (newToolName === modules?.ZoomToolClass?.toolName) {
    try { toolGroup.setToolConfiguration(newToolName, { pan: false }); } catch {}
  }

  // Nota: il globalCameraSync propaga lo stato aggiornato agli altri viewport; questa re-applicazione garantisce che
  // il valore seed sia quello desiderato prima che il sync parta.
}

/**
 * Get Cornerstone 3D enums
 */
export async function getEnums(): Promise<{ csCore: typeof CoreEnums, csTools: typeof ToolEnums }> {
  await initializeCornerstone3D(); 
  const modules = cornerstoneModules;
  if (!modules || !modules.CoreEnums || !modules.ToolEnums) {
      throw new Error("Cornerstone Enums not available after initialization.");
  }
  return {
      csCore: modules.CoreEnums,
      csTools: modules.ToolEnums
  };
}

// Legacy compatibility functions (keeping for backward compatibility)
export const initCornerstone = initializeCornerstone3D;

/**
 * Initialize with CPU rendering - V3.x handles this automatically
 * Keeping for API compatibility but v3.x auto-fallback makes this redundant
 */
export async function initializeCornerstoneWithCPU(): Promise<void> {
  console.warn("initializeCornerstoneWithCPU is deprecated. Use initializeCornerstone3D.");
  return initializeCornerstone3D();
}

// Default ID for singleton rendering engine since v3.x of Cornerstone3D no longer exports RENDERING_ENGINE_UID
const DEFAULT_RENDERING_ENGINE_ID = 'defaultRenderingEngine'; 

/**
 * Add viewport to both Camera and WindowLevel synchronizers (global singletons)
 */
export async function addViewportToGlobalSync(viewportId: string, renderingEngineId: string): Promise<void> {
  await initializeCornerstone3D();
  const modules = cornerstoneModules;
  if (!modules?.csToolsResolved) return;

  // Create Camera sync singleton
  if (!(globalThis as any).__globalCameraSync) {
    let factory = (modules.csToolsResolved as any).createCameraPositionSynchronizer;
    if (typeof factory !== 'function' && (modules.csToolsResolved as any).synchronizers) {
      factory = (modules.csToolsResolved as any).synchronizers.createCameraPositionSynchronizer;
    }
    if (typeof factory === 'function') {
      (globalThis as any).__globalCameraSync = factory('globalCameraSync');
    }
  }

  // Create VOI (Window/Level) sync singleton
  if (!(globalThis as any).__globalVOISync) {
    let wlFactory = (modules.csToolsResolved as any).createVOISynchronizer;
    if (typeof wlFactory !== 'function' && (modules.csToolsResolved as any).synchronizers) {
      wlFactory = (modules.csToolsResolved as any).synchronizers.createVOISynchronizer;
    }
    // Fallback to local dist bundle (exported synchronizers) if still undefined
    if (typeof wlFactory !== 'function') {
      try {
        // Dynamic import to avoid static dependency
        // eslint-disable-next-line import/no-relative-parent-imports, @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const localSync: any = await import('../../dist/@cornerstonejs/tools/dist/esm/synchronizers/synchronizers/createVOISynchronizer.js');
        wlFactory = localSync?.default;
      } catch {}
    }
    if (typeof wlFactory === 'function') {
      (globalThis as any).__globalVOISync = wlFactory('globalVOISync');
      try { (globalThis as any).__globalVOISync.setOptions({ syncOnFrameRendered: true }); } catch {}
    }
  }

  // Add viewport
  const camSync = (globalThis as any).__globalCameraSync as any;
  try { camSync?.add?.({ viewportId, renderingEngineId }); } catch {}

  const wlSync = (globalThis as any).__globalVOISync as any;
  try { wlSync?.add?.({ viewportId, renderingEngineId }); } catch {}
}

export async function removeViewportFromGlobalCameraSync(viewportId: string, renderingEngineId: string): Promise<void> {
  const sync = (globalThis as any).__globalCameraSync as any;
  if (!sync?.remove) return;
  try {
    sync.remove({ viewportId, renderingEngineId });
  } catch {}
} 