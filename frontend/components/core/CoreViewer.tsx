"use client";

import React, { useEffect, useRef, useState } from 'react';
import {
  initializeCornerstone3D,
  createToolGroup,
  setActiveToolInGroup,
  getRenderingEngineInstance,
  getEnums,
  addViewportToGlobalSync,
  removeViewportFromGlobalCameraSync,
  type UiToolType,
  getVolumeLoader,
  getCache,
  getImageLoader,
} from '@/lib/utils/cornerstoneInit';
import type { Types as CoreTypes } from '@cornerstonejs/core';

export type CoreViewerMode = 'orthographic' | 'volume3d' | 'multiplanar';

export interface CoreViewerProps {
  mode: CoreViewerMode;
  viewportId: string;
  imageIds?: string[];
  localFiles?: File[];
  activeTool?: UiToolType;
  onImageLoaded?: (success: boolean) => void;
  onError?: (error: string) => void;
  className?: string;
  // Orthographic specific
  orientation?: 'AXIAL' | 'SAGITTAL' | 'CORONAL';
  // Volume specific  
  enableSync?: boolean;
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  wadoRsRoot?: string;
  // Architetturali per il sync del layout
  onReady: (viewportId: string) => void;
  loadSignal: boolean;
}

interface CoreViewerState {
  loading: boolean;
  error: string | null;
  initialized: boolean;
  currentTool: UiToolType;
}

/**
 * CoreViewer - Consolidated viewer engine that eliminates redundancy
 * between DicomViewer and AdvancedViewer by providing unified core functionality
 */
export function CoreViewer({
  mode,
  viewportId,
  imageIds,
  localFiles,
  activeTool = null,
  onImageLoaded,
  onError,
  className = "",
  orientation = 'AXIAL',
  enableSync = true,
  studyInstanceUID,
  seriesInstanceUID,
  wadoRsRoot,
  onReady,
  loadSignal,
}: CoreViewerProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  
  // State management
  const [state, setState] = useState<CoreViewerState>({
    loading: false,
    error: null,
    initialized: false,
    currentTool: null
  });

  // Persistent refs for Cornerstone entities
  const toolGroupIdRef = useRef<string>(`toolgroup-${viewportId}`);
  // Ref to keep track of active volume (used in 3D mode for cleanup)
  const activeVolumeIdRef = useRef<string | null>(null);
  // Ref to keep track of previously loaded stack IDs to avoid redundant camera resets
  const prevImageIdsRef = useRef<string[] | null>(null);
  const firstLoadRef = useRef<boolean>(true);

  // Silence "unused" warnings for props that are reserved for future features
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _reservedForFuture = { enableSync, studyInstanceUID, seriesInstanceUID, wadoRsRoot };

  // Initialize Cornerstone on mount
  useEffect(() => {
    initializeCornerstone3D().catch(err => {
      console.error(`CoreViewer [${viewportId}]: Failed to initialize Cornerstone:`, err);
      const errorMsg = "Core system initialization failed";
      setState(prev => ({ ...prev, error: errorMsg }));
      onError?.(errorMsg);
    });
  }, [viewportId, onError]);

  // Handle tool changes
  useEffect(() => {
    if (!state.initialized || !toolGroupIdRef.current) return;

    const handleToolChange = async () => {
      try {
        console.log(`CoreViewer [${viewportId}]: Setting tool ${String(activeTool)}`);
        await setActiveToolInGroup(toolGroupIdRef.current, activeTool);
        setState(prev => ({ ...prev, currentTool: activeTool }));
      } catch (err) {
        console.error(`CoreViewer [${viewportId}]: Error setting tool:`, err);
      }
    };
    
    if (activeTool !== state.currentTool) {
        handleToolChange();
    }

  }, [activeTool, state.initialized, viewportId, state.currentTool]);

  // Setup viewport and tool group (Phase 1: Creation)
  useEffect(() => {
    let cancelled = false;
    const element = elementRef.current;
    if (!element) return;

    const setupViewport = async () => {
      if (cancelled) return;

      try {
        const renderingEngine = await getRenderingEngineInstance();
        const Enums = await getEnums();

        if (!Enums?.csCore?.ViewportType || !Enums?.csCore?.OrientationAxis) {
          throw new Error("Failed to load Cornerstone Enums");
        }

        const viewportConfig: CoreTypes.PublicViewportInput = {
          viewportId,
          element,
          type: Enums.csCore.ViewportType.STACK, // Default
        };

        // ------------------------------------------------------------------
        // Defensive cleanup: if a viewport with the same ID already exists
        // in the rendering engine (e.g. due to rapid layout changes where
        // the previous React component unmounted but its async cleanup has
        // not yet completed), we must disable it before creating the new
        // one.  Otherwise Cornerstone will fail to create a renderer and
        // subsequent calls like `setStack` will throw errors such as
        // "No renderer found for the viewport".
        // ------------------------------------------------------------------
        const maybeExisting = renderingEngine.getViewport(viewportId);
        if (maybeExisting) {
          try {
            console.warn(`CoreViewer [${viewportId}]: Existing viewport detected during setup. Disabling previous instance to avoid ID collision.`);
            renderingEngine.disableElement(viewportId);
          } catch (cleanupErr) {
            console.error(`CoreViewer [${viewportId}]: Failed to disable pre-existing viewport:`, cleanupErr);
          }
        }

        switch (mode) {
          case 'orthographic':
            viewportConfig.type = Enums.csCore.ViewportType.STACK;
            break;
          case 'volume3d':
            viewportConfig.type = Enums.csCore.ViewportType.VOLUME_3D;
            break;
          case 'multiplanar':
            viewportConfig.type = Enums.csCore.ViewportType.ORTHOGRAPHIC;
            viewportConfig.defaultOptions = {
              orientation: Enums.csCore.OrientationAxis[orientation],
            };
            break;
        }
        
        if (cancelled) return;
        
        renderingEngine.enableElement(viewportConfig);

        // Extended debug logging
        console.log(`CoreViewer [${viewportId}]: enableElement completed. Viewport type = ${viewportConfig.type}`);

        const toolGroup = await createToolGroup(toolGroupIdRef.current);
        if (cancelled) return;
        toolGroup.addViewport(viewportId, renderingEngine.id);

        if (enableSync) {
          await addViewportToGlobalSync(viewportId, renderingEngine.id);
        }

        // Emit ready signal only after the element has dimensions
        if (resizeObserverRef.current) {
          resizeObserverRef.current.disconnect();
        }
        
        resizeObserverRef.current = new ResizeObserver(() => {
          if (element.clientWidth > 10 && element.clientHeight > 10) {
            if (!cancelled) {
              console.log(`CoreViewer [${viewportId}]: Layout ready, emitting onReady.`);
              onReady(viewportId);
            }
            if (resizeObserverRef.current) {
              resizeObserverRef.current.disconnect();
            }
          }
        });
        resizeObserverRef.current.observe(element);
        
        setState(prev => ({ ...prev, initialized: true, error: null }));

      } catch (err) {
        if (!cancelled) {
          console.error(`CoreViewer [${viewportId}]: Viewport setup failed:`, err);
          onError?.((err as Error).message);
          setState(prev => ({ ...prev, error: (err as Error).message }));
        }
      }
    };
    
    setupViewport();

    return () => {
      cancelled = true;
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, viewportId]); // Re-run if mode or ID changes

  // Data Loading (Phase 2: Triggered by Signal)
  useEffect(() => {
    const element = elementRef.current;
    const initialized = state.initialized;

    const loadData = async () => {
      if (!loadSignal || !element || !initialized) {
        console.log(`CoreViewer [${viewportId}]: Skipping load - conditions not met`, {
          loadSignal,
          hasElement: !!element,
          initialized
        });
        return;
      }

      console.log(`CoreViewer [${viewportId}]: Load signal received. Inspecting imageIds:`, {
        imageIdsLength: imageIds?.length || 0,
        imageIdsContent: imageIds?.slice(0, 3), // Log first 3 IDs
        imageIdsEmpty: !imageIds || imageIds.length === 0,
        mode,
        localFilesLength: localFiles?.length || 0
      });

      // If imageIds are empty but we have loadSignal, this confirms the stale prop issue
      if (mode !== 'volume3d' && (!imageIds || imageIds.length === 0)) {
        console.warn(`CoreViewer [${viewportId}]: Load signal received but imageIds is empty! This indicates stale props.`);
        // Don't proceed with empty imageIds
        return;
      }
      
      console.log(`CoreViewer [${viewportId}]: Loading data (loadSignal=${loadSignal})...`);

      setState(prev => ({ ...prev, loading: true, error: null }));
      onImageLoaded?.(false); // Signal that loading is starting

      const hasNewImages = JSON.stringify(imageIds) !== JSON.stringify(prevImageIdsRef.current);

      if (!imageIds || imageIds.length === 0) {
        console.warn(`CoreViewer [${viewportId}]: No imageIds provided for loading.`);
        setState(prev => ({ ...prev, loading: false }));
        return;
      }

      // If this is not the first load and images haven't changed, skip reloading to preserve VOI and avoid resets
      if (!hasNewImages && !firstLoadRef.current) {
        console.log(`CoreViewer [${viewportId}]: Skipping reload (no new images); preserving current VOI.`);
        setState(prev => ({ ...prev, loading: false }));
        onImageLoaded?.(true);
        return;
      }

      // Check if we have enough images for volume rendering
      if (mode === 'volume3d' && imageIds.length < 3) {
        const errorMsg = `Volume rendering requires at least 3 images. Current series has ${imageIds.length} image(s).`;
        console.warn(`CoreViewer [${viewportId}]: ${errorMsg}`);
        setState(prev => ({
          ...prev,
          loading: false,
          error: errorMsg
        }));
        onError?.(errorMsg);
        return;
      }

      try {
        console.log(`CoreViewer [${viewportId}]: Load signal received, loading data...`);
        const renderingEngine = await getRenderingEngineInstance();
        let viewport = renderingEngine.getViewport(viewportId);

        if (!viewport) {
          throw new Error(`Viewport with ID ${viewportId} not found.`);
        }

        if (activeVolumeIdRef.current) {
          console.log(`CoreViewer [${viewportId}]: Destroying previous volume ${activeVolumeIdRef.current} before loading new data.`);
          const cacheModule = await getCache();
          cacheModule.removeVolumeLoadObject(activeVolumeIdRef.current);
          activeVolumeIdRef.current = null;
          console.log(`CoreViewer [${viewportId}]: Previous volume removed from cache.`);
        }
        
        renderingEngine.resize(true, true);
        
        const Enums = await getEnums();

        if (hasNewImages) {
          viewport = renderingEngine.getViewport(viewportId);
          if (!viewport) throw new Error(`Viewport with ID ${viewportId} no longer available.`);
          if (viewport.type === Enums.csCore.ViewportType.STACK) {
            await (viewport as CoreTypes.IStackViewport).setStack(imageIds, 0);
            console.log(`CoreViewer [${viewportId}]: setStack completed. First ID = ${imageIds[0]}`);
          } else if (viewport.type === Enums.csCore.ViewportType.ORTHOGRAPHIC || viewport.type === Enums.csCore.ViewportType.VOLUME_3D) {
            // Volume creation from wadouri: blob URLs requires all image metadata
            // to be available upfront. Pre-load all images to populate the metadata provider.
            const imageLoader = await getImageLoader();
            console.log(`CoreViewer [${viewportId}]: Pre-loading ${imageIds.length} images for metadata...`);
            try {
              await Promise.all(
                imageIds.map((id) => imageLoader.loadAndCacheImage(id))
              );
            } catch (preloadErr) {
              console.warn(`CoreViewer [${viewportId}]: Image pre-load failed, volume creation may fail:`, preloadErr);
            }

            const volumeId = `volume-${viewportId}-${Date.now()}`;
            activeVolumeIdRef.current = volumeId;

            const volumeLoader = await getVolumeLoader();
            const volume = await volumeLoader.createAndCacheVolume(volumeId, {
              imageIds,
            });

            viewport = renderingEngine.getViewport(viewportId);
            if (!viewport) throw new Error(`Viewport with ID ${viewportId} no longer available (post volume create).`);
            await (viewport as CoreTypes.IVolumeViewport).setVolumes([
              { volumeId: volume.volumeId },
            ]);
            console.log(`CoreViewer [${viewportId}]: Volume ${volume.volumeId} created and set successfully.`);
          }
        }

        if (hasNewImages) {
          try {
            const fresh = renderingEngine.getViewport(viewportId);
            if (fresh && typeof (fresh as any).resetCamera === 'function') {
              fresh.resetCamera();
            }
          } catch (e) {
            console.warn(`CoreViewer [${viewportId}]: resetCamera skipped (viewport not ready):`, e);
          }
          prevImageIdsRef.current = imageIds;
          firstLoadRef.current = false;
        }

        // This is a more reliable point to trigger a final render
        try {
          const fresh = renderingEngine.getViewport(viewportId);
          if (fresh && typeof fresh.render === 'function') {
            fresh.render();
          }
        } catch (e) {
          console.warn(`CoreViewer [${viewportId}]: render skipped (viewport not ready):`, e);
        }
        console.log(`CoreViewer [${viewportId}]: Image stack loaded and rendered successfully.`);
        setState(prev => ({ ...prev, loading: false }));
        onImageLoaded?.(true);

      } catch (err) {
        const errorMsg = err instanceof Error
          ? err.message
          : (typeof err === 'string' ? err : JSON.stringify(err) || 'Unknown loading error');
        console.error(`CoreViewer [${viewportId}]: Failed to load image stack:`, errorMsg, err);
        onError?.(errorMsg);
        setState(prev => ({ ...prev, loading: false, error: errorMsg }));
      }
    };

    loadData().catch((uncaught) => {
      // Prevent unhandled rejection from crashing the Next.js error overlay
      const msg = uncaught instanceof Error
        ? uncaught.message
        : (typeof uncaught === 'string' ? uncaught : JSON.stringify(uncaught) || 'Unknown error');
      console.error(`CoreViewer [${viewportId}]: Unhandled error in loadData:`, msg);
    });

  }, [loadSignal, imageIds, state.initialized, viewportId, onError, onImageLoaded, mode, localFiles]);

  // Handle local file loading (if needed, expand this effect)
  useEffect(() => {
    if (localFiles && localFiles.length > 0) {
      console.warn("CoreViewer: Local file loading is a placeholder and not fully implemented.");
      // Future: integrate with a local file loader service
    }
  }, [localFiles]);

  // Unmount cleanup
  useEffect(() => {
    const currentElement = elementRef.current; // Capture ref value here

    return () => {
      const cleanup = async () => {
        try {
          const re = await getRenderingEngineInstance();
          const existingViewport = re.getViewport(viewportId);

          // Only clean up if this component owns the viewport element
          if (existingViewport && existingViewport.element === currentElement) {
            console.log(`CoreViewer [${viewportId}]: Cleaning up owned viewport...`);

            // Remove from synchronizers first
            try {
              await removeViewportFromGlobalCameraSync(viewportId, re.id);
            } catch (syncErr) {
              console.warn(`CoreViewer [${viewportId}]: Error removing from sync:`, syncErr);
            }

            // Then disable the element
            try {
              re.disableElement(viewportId);
              console.log(`CoreViewer [${viewportId}]: Viewport disabled successfully.`);
            } catch (disableErr) {
              console.warn(`CoreViewer [${viewportId}]: Error disabling element:`, disableErr);
            }
          } else if (existingViewport) {
            console.log(`CoreViewer [${viewportId}]: Cleanup skipped - viewport re-assigned to different element.`);
          } else {
            console.log(`CoreViewer [${viewportId}]: Cleanup skipped - viewport does not exist.`);
          }

          // Check if a volume was loaded (in 3D mode) and needs to be destroyed
          if (activeVolumeIdRef.current) {
            // This part is crucial for 3D/MPR modes to avoid memory leaks
            const cache = await getCache();
            cache.removeVolumeLoadObject(activeVolumeIdRef.current);
            console.log(`CoreViewer [${viewportId}]: Destroyed volume ${activeVolumeIdRef.current}`);
            activeVolumeIdRef.current = null;
          }
        } catch (err) {
          // Log errors on unmount but don't bother the user
          console.warn(`CoreViewer [${viewportId}]: Non-critical error during unmount cleanup:`, err);
        }
      };
      cleanup();
    };
  }, [viewportId]);

  return (
    <div
      ref={elementRef}
      className={`relative w-full h-full border border-gray-700 bg-black ${className}`}
      onContextMenu={(e) => e.preventDefault()} // Prevent default context menu
    >
      <div className="absolute top-1 left-1 text-white text-xs bg-black bg-opacity-50 px-2 py-1 rounded">
        {state.loading && <span>Loading...</span>}
        {state.error && <span className="text-red-500">Error: {state.error}</span>}
        {!state.loading && !state.error && <span className="text-gray-400">{viewportId}</span>}
      </div>
    </div>
  );
}