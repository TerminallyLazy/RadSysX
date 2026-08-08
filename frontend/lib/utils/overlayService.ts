// Overlay service for loading NPZ (seg/heatmap) and displaying as labelmap/overlay in Cornerstone3D
// Code runs in browser only

import { fetchNpz } from '@/lib/api/biomedparse';

export type OverlayConfig = {
  // 0..1 opacity for heatmap overlay
  heatmapOpacity?: number;
  // Optional per-prompt color (for future labelmap color assignment)
  color?: [number, number, number];
};

async function loadCornerstone(): Promise<{
  core: typeof import('@cornerstonejs/core');
  tools: typeof import('@cornerstonejs/tools');
}> {
  const [core, tools] = await Promise.all([
    import('@cornerstonejs/core'),
    import('@cornerstonejs/tools'),
  ]);
  return { core, tools };
}

export async function applyLabelmapFromNpz(
  viewportId: string,
  renderingEngineId: string,
  maskNpzName: string,
  opts?: OverlayConfig
): Promise<void> {
  const { core, tools } = await loadCornerstone();
  const { segmentation, Enums: ToolsEnums } = tools;
  const { cache } = core;

  const npz = await fetchNpz({ name: maskNpzName, key: 'seg' });
  const { shape, data_base64 } = npz; // shape = [D,H,W] uint8
  const raw = typeof window !== 'undefined' ? atob(data_base64) : Buffer.from(data_base64, 'base64').toString('binary');
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);

  // Build a labelmap volume matching the reference volume dimensions
  const renderingEngine = core.getRenderingEngine(renderingEngineId);
  if (!renderingEngine) throw new Error('Rendering engine not found');
  const viewport = renderingEngine.getViewport(viewportId) as any;
  const referenceId = viewport.getActors?.()[0]?.uid || viewport.getDefaultActor()?.uid;
  if (!referenceId) throw new Error('No reference volume/stack found for labelmap');
  const referenceVolume = cache.getVolume(referenceId);
  if (!referenceVolume) throw new Error('Reference volume not in cache');

  // Create a new empty labelmap with same dimensions, then fill from NPZ
  const labelmap = await core.volumeLoader.createAndCacheDerivedLabelmapVolume(referenceId) as any;
  const [w, h, d] = (labelmap.dimensions ?? [0, 0, 0]) as [number, number, number]; // Note: CS3D uses [w,h,numSlices]
  const [D, H, W] = shape; // backend is [D,H,W]
  if (w !== W || h !== H || d !== D) {
    // Fallback: if dims mismatch, best-effort copy into overlapping region
    // A full resample is out of scope here.
  }
  const voxelManager = labelmap.voxelManager as {
    getCompleteScalarDataArray?: () => ArrayLike<number>;
    setCompleteScalarDataArray?: (data: Uint8Array) => void;
  };
  const lmData = new Uint8Array(voxelManager.getCompleteScalarDataArray?.() ?? []);
  // Map [D,H,W] → CS3D [w,h,d] linearized
  for (let z = 0; z < Math.min(d, D); z++) {
    for (let y = 0; y < Math.min(h, H); y++) {
      for (let x = 0; x < Math.min(w, W); x++) {
        const src = z * (H * W) + y * W + x;
        const dst = z * (w * h) + y * w + x;
        lmData[dst] = buf[src] > 0 ? 1 : 0; // single segment index 1
      }
    }
  }
  voxelManager.setCompleteScalarDataArray?.(lmData);

  // Add segmentation to state and display
  const segmentationId = `bp-labelmap-${Date.now()}`;
  await segmentation.addSegmentations([
    {
      segmentationId,
      representation: {
        type: tools.Enums.SegmentationRepresentations.Labelmap,
        data: { volumeId: labelmap.volumeId },
      },
    },
  ]);

  await segmentation.addSegmentationRepresentations(viewportId, [
    {
      segmentationId,
      type: ToolsEnums.SegmentationRepresentations.Labelmap,
    },
  ]);

  // Basic visibility/opacity defaults
  const segmentationConfig = tools.segmentation.config as any;
  segmentationConfig.setSegmentRGBColor?.(segmentationId, 1, opts?.color || [255, 0, 0]);
  segmentationConfig.setRepresentationVisibility?.(viewportId, segmentationId, true);
  viewport.render?.();
}

export async function applyHeatmapFromNpz(
  viewportId: string,
  renderingEngineId: string,
  heatmapNpzName: string,
  opts?: OverlayConfig
): Promise<void> {
  const { core } = await loadCornerstone();
  const { cache } = core;

  const npz = await fetchNpz({ name: heatmapNpzName, key: 'prob' });
  const { shape, data_base64 } = npz; // [D,H,W] uint8
  const raw = typeof window !== 'undefined' ? atob(data_base64) : Buffer.from(data_base64, 'base64').toString('binary');
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);

  const renderingEngine = core.getRenderingEngine(renderingEngineId);
  if (!renderingEngine) throw new Error('Rendering engine not found');
  const viewport = renderingEngine.getViewport(viewportId) as any;
  const referenceId = viewport.getActors?.()[0]?.uid || viewport.getDefaultActor()?.uid;
  if (!referenceId) throw new Error('No reference volume/stack found for heatmap overlay');
  const referenceVolume = cache.getVolume(referenceId);
  if (!referenceVolume) throw new Error('Reference volume not in cache');

  // Cornerstone3D does not have a first-class volume overlay layer API stable yet; 
  // a simple approach is to create a texture actor and blend, or reuse labelmap with graded indices.
  // Here we opt to create a labelmap with graded indices (0..255) as a pseudo-heatmap layer.
  const labelmap = await core.volumeLoader.createAndCacheDerivedLabelmapVolume(referenceId) as any;
  const [w, h, d] = (labelmap.dimensions ?? [0, 0, 0]) as [number, number, number];
  const [D, H, W] = shape;
  const voxelManager = labelmap.voxelManager as {
    getCompleteScalarDataArray?: () => ArrayLike<number>;
    setCompleteScalarDataArray?: (data: Uint8Array) => void;
  };
  const lmData = new Uint8Array(voxelManager.getCompleteScalarDataArray?.() ?? []);
  for (let z = 0; z < Math.min(d, D); z++) {
    for (let y = 0; y < Math.min(h, H); y++) {
      for (let x = 0; x < Math.min(w, W); x++) {
        const src = z * (H * W) + y * W + x;
        const dst = z * (w * h) + y * w + x;
        lmData[dst] = buf[src]; // 0..255
      }
    }
  }
  voxelManager.setCompleteScalarDataArray?.(lmData);

  // For visualization, simple approach: map any nonzero to segment 1 and adjust opacity.
  // For a richer colormap, integrate shader-based rendering in a later step.
  const opacity = typeof opts?.heatmapOpacity === 'number' ? Math.max(0, Math.min(1, opts.heatmapOpacity)) : 0.4;
  (viewport as any).setLabelmapOpacity?.(labelmap.volumeId, opacity);
  viewport.render?.();
}


