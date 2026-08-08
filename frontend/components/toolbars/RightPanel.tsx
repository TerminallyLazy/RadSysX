/* eslint-disable */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { RightPanelProps } from '@/lib/types/app';
import { Panel } from '@/components/Panel';
import { cn } from '@/lib/utils';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ChevronLeft, ChevronRight, Maximize2, X } from 'lucide-react';
import { ImageSeriesUpload } from '@/components/ImageSeriesUpload';
import { useToast } from '@/lib/use-toast';
import { LoadedImage } from '@/lib/types';
import { processImageSeries, type ImageSeries } from '@/lib/services/imageUploadService';
import { predict2D, predict3DNifti, type Predict2DResponse, type Predict3DResponse } from '@/lib/api/biomedparse';
import { applyLabelmapFromNpz, applyHeatmapFromNpz } from '@/lib/utils/overlayService';
import { getPublicAppMode } from '@/lib/env';

interface ExtraProps {
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

type Props = RightPanelProps & ExtraProps;

export function RightPanel(props: Props) {
  const {
    isExpanded,
    onExpandedChange,
    csImageIds,
    setCsImageIds,
    blobUrls,
    setBlobUrls,
    loadedImages,
    setLoadedImages,
    isSeriesLoaded,
    setIsSeriesLoaded,
  } = props;

  const [selectedTab, setSelectedTab] = useState<'analysis' | 'voice' | 'events'>('analysis');
  const [isChatExpanded, setIsChatExpanded] = useState(false);
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const [prompts, setPrompts] = useState<string>('');
  const [returnHeatmap, setReturnHeatmap] = useState<boolean>(true);
  const [threshold, setThreshold] = useState<number>(0.5);
  const [sliceBatchSize, setSliceBatchSize] = useState<number | undefined>(undefined);
  const [bp2dResult, setBp2dResult] = useState<Predict2DResponse | null>(null);
  const [bp3dResult, setBp3dResult] = useState<Predict3DResponse | null>(null);
  const [heatmapOpacity, setHeatmapOpacity] = useState<number>(0.4);
  const appMode = getPublicAppMode();
  const experimentalImagingEnabled = appMode === 'research';

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const handleUploadComplete = useCallback(async (files: File[]) => {
    if (!files.length) return;
    try {
      const series: ImageSeries = await processImageSeries(files);
      const newLoaded = series.images;
      setLoadedImages(newLoaded);
      setCsImageIds(series.images.map(img => img.imageId));
      setBlobUrls(series.images.map(img => img.localUrl));
      setIsSeriesLoaded(false);
      toast({ title: 'Upload Successful', description: `${newLoaded.length} image(s) processed` });
    } catch (err: any) {
      toast({ title: 'Upload Failed', description: err?.message ?? 'Unknown error', variant: 'destructive' });
    }
  }, [setLoadedImages, setCsImageIds, setBlobUrls, setIsSeriesLoaded, toast]);

  const handleLoadSeries = () => {
    if (loadedImages.length === 0) return;
    setIsSeriesLoaded(true);
  };

  const pickRepresentativeFile = (): File | null => {
    // Prefer NIfTI if present, else take first non-DICOM image for 2D
    const nifti = loadedImages.find(img => /\.nii(\.gz)?$/i.test(img.file.name));
    if (nifti) return nifti.file;
    const nonDicom = loadedImages.find(img => !/\.(dcm|dicom)$/i.test(img.file.name));
    return nonDicom ? nonDicom.file : null;
  };

  const onAnalyze = async () => {
    try {
      const file = pickRepresentativeFile();
      if (!file) {
        toast({ title: 'No compatible file', description: 'Provide a NIfTI for 3D or an image for 2D', variant: 'destructive' });
        return;
      }
      const promptList = prompts.split(',').map(p => p.trim()).filter(Boolean);
      if (promptList.length === 0) {
        toast({ title: 'Missing prompts', description: 'Enter at least one prompt' });
        return;
      }
      if (/\.nii(\.gz)?$/i.test(file.name)) {
        const res = await predict3DNifti({ file, prompts: promptList, return_heatmap: returnHeatmap, threshold, slice_batch_size: sliceBatchSize });
        setBp3dResult(res);
        setBp2dResult(null);
        toast({ title: '3D analysis completed', description: `${res.results.length} prompt(s)`});
      } else {
        const res = await predict2D({ file, prompts: promptList, return_heatmap: returnHeatmap, threshold });
        setBp2dResult(res);
        setBp3dResult(null);
        toast({ title: '2D analysis completed', description: `${res.results.length} prompt(s)`});
      }
    } catch (err: any) {
      toast({ title: 'Analysis failed', description: err?.message ?? 'Unknown error', variant: 'destructive' });
    }
  };

  return (
    <div className="h-full flex flex-col text-center bg-white dark:bg-[#141a29]">
      {/* Header */}
      <div className="flex items-center h-12 px-4 border-b border-[#e4e7ec] dark:border-[#2D3848]">
        <button
          className="p-2 hover:bg-[#f4f6f8] dark:hover:bg-[#2D3848] rounded-md text-foreground/80 hover:text-[#4cedff]"
          onClick={() => onExpandedChange(!isExpanded)}
        >
          {isExpanded ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
        <span className={cn('font-medium flex-1 text-center', !isExpanded && 'opacity-0')}>Analysis</span>
      </div>

      {/* Body */}
      <div className={cn('flex-1 overflow-hidden', !isExpanded && 'hidden')}>
        <div className="h-full p-4">
          <Tabs defaultValue="analysis" value={selectedTab} onValueChange={v => setSelectedTab(v as any)}>
            <TabsList className="grid w-full grid-cols-3 gap-1 p-1 rounded-md">
              <TabsTrigger value="analysis">Analysis</TabsTrigger>
              <TabsTrigger value="voice">Voice</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
            </TabsList>

            <TabsContent value="analysis" className="mt-4">
              <div className="space-y-4">
                {!experimentalImagingEnabled && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-left">
                    <div className="text-sm font-semibold text-amber-300">Clinical boundary active</div>
                    <p className="mt-2 text-sm text-foreground/80">
                      Local file upload and direct browser-side analysis are disabled in {appMode} mode.
                      Use the clinical worklist and backend AI job APIs instead.
                    </p>
                  </div>
                )}
                {experimentalImagingEnabled && (
                  <>
                    <ImageSeriesUpload onUploadComplete={handleUploadComplete} />
                    {loadedImages.length > 0 && !isSeriesLoaded && (
                      <button onClick={handleLoadSeries} className="w-full px-4 py-3 rounded-md bg-[#4cedff] text-[#1b2237]">Load Series</button>
                    )}
                    <div className="space-y-2 text-left">
                      <label className="block text-sm">Prompts (comma-separated)</label>
                      <input value={prompts} onChange={e => setPrompts(e.target.value)} className="w-full px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-transparent" placeholder="liver, tumor" />
                      <div className="flex items-center space-x-4 mt-2">
                        <label className="flex items-center space-x-2 text-sm">
                          <input type="checkbox" checked={returnHeatmap} onChange={e => setReturnHeatmap(e.target.checked)} />
                          <span>Return heatmap</span>
                        </label>
                        <label className="flex items-center space-x-2 text-sm">
                          <span>Threshold</span>
                          <input type="number" min={0} max={1} step={0.05} value={threshold} onChange={e => setThreshold(Number(e.target.value))} className="w-20 px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-transparent" />
                        </label>
                        <label className="flex items-center space-x-2 text-sm">
                          <span>Slice batch</span>
                          <input type="number" min={1} step={1} value={sliceBatchSize ?? ''} onChange={e => setSliceBatchSize(e.target.value ? Number(e.target.value) : undefined)} className="w-16 px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-transparent" />
                        </label>
                      </div>
                      <button onClick={onAnalyze} className="w-full px-4 py-3 rounded-md bg-emerald-400 text-[#1b2237]">Analyze with BiomedParse</button>
                    </div>
                  </>
                )}

                {/* Results Panel */}
                {(bp2dResult || bp3dResult) && (
                  <div className="mt-4 space-y-2">
                    <div className="text-sm font-semibold">Results</div>
                    <div className="space-y-2">
                      {(bp2dResult?.results ?? bp3dResult?.results ?? []).map((r, idx) => (
                        <div key={idx} className="p-2 rounded border border-gray-300 dark:border-gray-700">
                          <div className="flex justify-between text-sm">
                            <span className="font-medium">{r.prompt}</span>
                            {'presence_confidence' in r ? (
                              <span>presence: {(r as any).presence_confidence?.toFixed?.(2)}</span>
                            ) : (
                              <span>class: {(r as any).classification_confidence?.toFixed?.(2)}</span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500">mask conf: {r.mask_confidence.toFixed ? r.mask_confidence.toFixed(2) : r.mask_confidence}</div>
                          {'mask_url' in r && (r as any).mask_url && (
                            <div className="text-xs break-all">mask_url: {(r as any).mask_url}</div>
                          )}
                          {'heatmap_url' in r && (r as any).heatmap_url && (
                            <div className="text-xs break-all">heatmap_url: {(r as any).heatmap_url}</div>
                          )}
                          {/* Overlay controls */}
                          {'mask_url' in r && (r as any).mask_url && (
                            <div className="mt-2 flex items-center space-x-2">
                              <button
                                className="px-2 py-1 text-xs rounded bg-blue-500 text-white"
                                onClick={async () => {
                                  try {
                                    // Extract filename from /files/<name>.npz
                                    const name = (r as any).mask_url.split('/').pop();
                                    if (!name) return;
                                    // Assume main viewport id is known externally; for demo use 'viewport-1' & rendering engine id 'renderingEngine'
                                    await applyLabelmapFromNpz('viewport-1', 'renderingEngine', name);
                                    toast({ title: 'Labelmap applied', description: r.prompt });
                                  } catch (e: any) {
                                    toast({ title: 'Failed to apply labelmap', description: e?.message ?? 'Unknown', variant: 'destructive' });
                                  }
                                }}
                              >Apply Labelmap</button>
                              {'heatmap_url' in r && (r as any).heatmap_url && (
                                <>
                                  <label className="text-xs">Opacity</label>
                                  <input type="range" min={0} max={1} step={0.05} value={heatmapOpacity} onChange={e => setHeatmapOpacity(Number(e.target.value))} />
                                  <button
                                    className="px-2 py-1 text-xs rounded bg-amber-500 text-white"
                                    onClick={async () => {
                                      try {
                                        const name = (r as any).heatmap_url.split('/').pop();
                                        if (!name) return;
                                        await applyHeatmapFromNpz('viewport-1', 'renderingEngine', name, { heatmapOpacity });
                                        toast({ title: 'Heatmap applied', description: r.prompt });
                                      } catch (e: any) {
                                        toast({ title: 'Failed to apply heatmap', description: e?.message ?? 'Unknown', variant: 'destructive' });
                                      }
                                    }}
                                  >Apply Heatmap</button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>
            <TabsContent value="voice" className="mt-4">Voice (TBD)</TabsContent>
            <TabsContent value="events" className="mt-4">Events (TBD)</TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
} 
