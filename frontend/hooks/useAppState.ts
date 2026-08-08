import { useState, useRef, useMemo, useEffect } from 'react';
import { C3DToolName, ViewportLayout } from '@/lib/types/app';
import { LoadedImage } from '@/lib/types';
import { UiToolType } from '@/lib/utils/cornerstoneInit';

export function useAppState() {
  // UI State
  const [showMediaControls, setShowMediaControls] = useState(true);
  const [isEventLogDetached, setIsEventLogDetached] = useState(false);
  const [layout, setLayout] = useState<ViewportLayout>("2x2");
  // Remember the last non-1x1 grid layout so we can restore it when collapsing
  const [lastGridLayout, setLastGridLayout] = useState<Exclude<ViewportLayout, '1x1'>>("2x2");
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [expandedViewportId, setExpandedViewportId] = useState<string | null>(null);
  const [activeViewportId, setActiveViewportId] = useState<string>('CT_AXIAL_1');
  const [activeTool, setActiveTool] = useState<C3DToolName>('Pan');
  const [isRadSysXModalOpen, setIsRadSysXModalOpen] = useState(false);

  // Image State
  const [csImageIds, setCsImageIds] = useState<string[]>([]);
  const [blobUrls, setBlobUrls] = useState<string[]>([]);
  const [loadedImages, setLoadedImages] = useState<LoadedImage[]>([]);
  const [isSeriesLoaded, setIsSeriesLoaded] = useState(false);

  // Layout & Sync State
  const [readyViewportIds, setReadyViewportIds] = useState(new Set<string>());
  const [loadSignal, setLoadSignal] = useState(false);

  // Viewport Refs
  const viewportRef1 = useRef<HTMLDivElement>(null);
  const viewportRef2 = useRef<HTMLDivElement>(null);
  const viewportRef3 = useRef<HTMLDivElement>(null);
  const viewportRef4 = useRef<HTMLDivElement>(null);
  const viewportRefs = useMemo(() => [viewportRef1, viewportRef2, viewportRef3, viewportRef4], []);

  // Viewport grid configuration
  const viewportGridConfig = useMemo(() => {
    switch (layout) {
      case '1x1': return { rows: 1, cols: 1 };
      case '2x2': return { rows: 2, cols: 2 };
      case '3x3': return { rows: 3, cols: 3 };
      default: return { rows: 1, cols: 1 };
    }
  }, [layout]);
  
  const expectedViewportIds = useMemo(() => {
    switch (layout) {
      case '1x1':
        return new Set<string>(['CT_AXIAL_1']);
      case '2x2':
      case '3x3':
        return new Set<string>([
          'CT_AXIAL_1',
          'CT_SAGITTAL_1',
          'CT_CORONAL_1',
        ]);
      default:
        return new Set<string>();
    }
  }, [layout]);

  // Replace expectedViewportCount derivation to use expectedViewportIds.size
  const expectedViewportCount = expectedViewportIds.size;

  // Convert domain-level C3DToolName to UI tool names understood by Cornerstone integration layer.
  // Since our CoreViewer layer now expects UiToolType (capital-case names), we can simply pass through
  // the enum value. In case of future UI renaming, maintain the switch for explicitness.
  const convertToUiTool = (c3dTool: C3DToolName): UiToolType | null => {
    switch (c3dTool) {
      case 'Pan':
      case 'Zoom':
      case 'WindowLevel':
      case 'StackScroll':
      case 'Length':
      case 'RectangleROI':
      case 'EllipticalROI':
      case 'Angle':
      case 'Probe':
      case 'Brush':
      case 'CircleScissor':
      case 'RectangleScissor':
        return c3dTool;
      default:
        return null;
    }
  };

  // Theme effect
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // Layout sync effect - this is the core of the race condition fix
  useEffect(() => {
    // 1. Reset the ready state and load signal whenever the layout changes
    setReadyViewportIds(new Set<string>());
    setLoadSignal(false);
    console.log(`Layout changed to ${layout}, expected ${expectedViewportCount} viewports. Ready state reset.`);
  }, [layout, expectedViewportCount]); // Dependency on count is key

  // Track previous csImageIds to detect new uploads
  const prevCsImageIdsRef = useRef<string>(JSON.stringify([]));

  useEffect(() => {
    const currentKey = JSON.stringify(csImageIds);
    const imagesChanged = currentKey !== prevCsImageIdsRef.current;

    // When new images arrive, reset loadSignal so we can re-pulse false→true
    if (imagesChanged && csImageIds.length > 0 && loadSignal) {
      setLoadSignal(false);
      prevCsImageIdsRef.current = currentKey;
      return; // Let the next render cycle re-evaluate
    }

    if (imagesChanged) {
      prevCsImageIdsRef.current = currentKey;
    }

    if (readyViewportIds.size === expectedViewportCount && expectedViewportCount > 0 && csImageIds.length > 0) {
      if (!loadSignal) {
        requestAnimationFrame(() => setLoadSignal(true));
      }
    } else if (loadSignal && csImageIds.length === 0) {
      setLoadSignal(false);
    }
  }, [readyViewportIds, expectedViewportCount, csImageIds, loadSignal]);

  useEffect(() => {
    console.table({
      expectedViewportCount,
      readyCount: readyViewportIds.size,
      readyIds: Array.from(readyViewportIds),
      loadSignal,
    });
  }, [readyViewportIds, loadSignal, expectedViewportCount]);

  // Extended logging: monitor csImageIds changes
  useEffect(() => {
    if (csImageIds.length > 0) {
      console.log("useAppState: csImageIds updated", {
        length: csImageIds.length,
        first3: csImageIds.slice(0, 3),
      });
    } else {
      console.log("useAppState: csImageIds is now empty");
    }
  }, [csImageIds]);

  // Event handlers
  const handleThemeChange = (newTheme: 'light' | 'dark') => setTheme(newTheme);

  const handleLayoutChange = (newLayout: ViewportLayout) => {
    // When switching to 1x1, preserve which grid layout we came from and keep/assign expanded viewport
    if (newLayout === '1x1') {
      if (layout !== '1x1') {
        setLastGridLayout(layout as Exclude<ViewportLayout, '1x1'>);
      }
      setLayout('1x1');
      setExpandedViewportId(prev => prev ?? 'CT_AXIAL_1');
      setActiveViewportId(prev => prev ?? 'CT_AXIAL_1');
      return;
    }
    // Switching to a grid layout cancels expansion and records the new grid as lastGridLayout
    setLastGridLayout(newLayout as Exclude<ViewportLayout, '1x1'>);
    setExpandedViewportId(null);
    setLayout(newLayout);
  };

  const handleViewportReady = (viewportId: string) => {
    if (!expectedViewportIds.has(viewportId)) return; // ignore stray ids
    setReadyViewportIds(prev => {
        const newSet = new Set(prev);
        newSet.add(viewportId);
        return newSet;
    });
  };

  const handleFullscreenToggle = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  const handleViewportExpandToggle = (viewportId: string | null) => {
    console.log("Toggling expand for viewportId:", viewportId);
    if (viewportId) {
      // Enter expanded: remember the current grid, then go 1x1 on the selected viewport
      if (layout !== '1x1') {
        setLastGridLayout(layout as Exclude<ViewportLayout, '1x1'>);
      }
      setExpandedViewportId(viewportId);
      setActiveViewportId(viewportId);
      setLayout('1x1');
    } else {
      // Exit expanded: restore the last grid layout
      setExpandedViewportId(null);
      setLayout(lastGridLayout);
    }
  };

  const handleViewportActivated = (viewportId: string) => {
    setActiveViewportId(viewportId);
    if (typeof document !== 'undefined') {
      document.body.setAttribute('data-active-viewport', viewportId);
    }
  };

  return {
    // UI State
    showMediaControls,
    setShowMediaControls,
    isEventLogDetached,
    setIsEventLogDetached,
    layout,
    setLayout,
    lastGridLayout,
    setLastGridLayout,
    leftPanelCollapsed,
    setLeftPanelCollapsed,
    rightPanelCollapsed,
    setRightPanelCollapsed,
    theme,
    setTheme,
    expandedViewportId,
    setExpandedViewportId,
    activeViewportId,
    setActiveViewportId,
    activeTool,
    setActiveTool,
    isRadSysXModalOpen,
    setIsRadSysXModalOpen,

    // Image State
    csImageIds,
    setCsImageIds,
    blobUrls,
    setBlobUrls,
    loadedImages,
    setLoadedImages,
    isSeriesLoaded,
    setIsSeriesLoaded,

    // Layout Sync State & Handlers
    loadSignal,
    handleViewportReady,
    expectedViewportCount,

    // Refs and utilities
    viewportRefs,
    convertToUiTool,
    viewportGridConfig,

    // Event handlers
    handleThemeChange,
    handleLayoutChange,
    handleFullscreenToggle,
    handleViewportExpandToggle,
    handleViewportActivated,
  };
} 