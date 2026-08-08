/* eslint-disable */
import React, { useState } from 'react';
import {
  Move, ZoomIn, ContrastIcon, Layers, Ruler, Square, Gauge, ScanLine,
  Stethoscope, LineChart, Crop, Circle, ArrowLeftRight, Download, Share2, FileImage,
  Settings, Layout, Sun, Moon, Maximize2, RotateCcw
} from 'lucide-react';
import { useToast } from '@/lib/use-toast';
import { CustomToolButton } from '@/components/CustomToolButton';
import { Panel } from '@/components/Panel';
import { cn } from '@/lib/utils';
import { LeftToolbarProps } from '@/lib/types/app';

// Extended props used only by this toolbar
interface ExtraProps {
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
  layout: '1x1' | '2x2' | '3x3';
  onLayoutChange: (layout: '1x1' | '2x2' | '3x3') => void;
  onToggleFullscreen: () => void;
  setIsRadSysXModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

type Props = LeftToolbarProps & ExtraProps;

export function LeftToolbar(props: Props) {
  const {
    isExpanded,
    onExpandedChange,
    activeTool,
    setActiveTool,
    theme,
    onThemeChange,
    layout,
    onLayoutChange,
    onToggleFullscreen,
  } = props;

  const [toolHistory, setToolHistory] = useState<(typeof activeTool)[]>([]);
  const [showSegmentationPanel, setShowSegmentationPanel] = useState(false);

  const segmentationTools = ['Brush', 'CircleScissor', 'RectangleScissor'] as const;
  const { toast } = useToast();

  const toolMapping: Record<string, typeof activeTool> = {
    pan: 'Pan',
    zoom: 'Zoom',
    windowLevel: 'WindowLevel',
    distance: 'Length',
    rectangle: 'RectangleROI',
    angle: 'Angle',
    probe: 'Probe',
    stackScroll: 'StackScroll',
    segmentation: 'Brush',
  } as const;

  const handleToolClick = (uiKey: string) => {
    if (uiKey === 'segmentation') {
      setShowSegmentationPanel(prev => !prev);
      return;
    }

    const c3dTool = toolMapping[uiKey];
    if (!c3dTool) {
      toast({ title: 'Tool Not Implemented', description: `Tool "${uiKey}" not mapped yet.` });
      return;
    }

    setShowSegmentationPanel(false);

    if (setActiveTool) {
      if (activeTool === c3dTool) return;
      setActiveTool(c3dTool);
      setToolHistory(prev => [...prev.filter(t => t !== c3dTool), c3dTool]);
    }
  };

  const handleSegmentationSelect = (tool: typeof segmentationTools[number]) => {
    setShowSegmentationPanel(false);
    if (setActiveTool) {
      if (activeTool === tool) return;
      setActiveTool(tool);
      setToolHistory(prev => [...prev.filter(t => t !== tool), tool]);
    }
  };

  const cycleLayout = () => {
    const order: ExtraProps['layout'][] = ['1x1', '2x2', '3x3'];
    const next = order[(order.indexOf(layout) + 1) % order.length];
    onLayoutChange(next);
  };

  return (
    <Panel
      className="h-full flex flex-col shadow-md overflow-hidden relative bg-white dark:bg-card"
      width={isExpanded ? 320 : 48}
    >
      <div className="flex items-center justify-between h-12 px-4 border-b border-[#e4e7ec] dark:border-[#2D3848]">
        <span className={cn('font-medium truncate text-center w-full', !isExpanded && 'opacity-0')}>Tools</span>
        <button
          className="p-2 hover:bg-[#f4f6f8] dark:hover:bg-[#2D3848] rounded-md text-foreground/80 hover:text-[#4cedff]"
          onClick={() => onExpandedChange(!isExpanded)}
        >
          {isExpanded ? <RotateCcw className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
        </button>
      </div>

      <div className={cn('flex-1 overflow-y-auto transition-all duration-200', !isExpanded && 'opacity-0')}>
        {/* View Section */}
        <div className="tool-section border-b border-[#e4e7ec] dark:border-[#2D3848]">
          <h3 className="tool-section-title text-[#64748b] dark:text-foreground/60">View</h3>
          <div className="tool-grid">
            <CustomToolButton icon={Move} label="Pan" active={activeTool === 'Pan'} onClick={() => handleToolClick('pan')} />
            <CustomToolButton icon={ZoomIn} label="Zoom" active={activeTool === 'Zoom'} onClick={() => handleToolClick('zoom')} />
            <CustomToolButton icon={ContrastIcon} label="Window/Level" active={activeTool === 'WindowLevel'} onClick={() => handleToolClick('windowLevel')} />
            <CustomToolButton icon={Layers} label="Scroll" active={activeTool === 'StackScroll'} onClick={() => handleToolClick('stackScroll')} />
          </div>
        </div>
        {/* Measure Section */}
        <div className="tool-section border-b border-[#e4e7ec] dark:border-[#2D3848]">
          <h3 className="tool-section-title">Measure</h3>
          <div className="tool-grid">
            <CustomToolButton icon={Ruler} label="Distance" active={activeTool === 'Length'} onClick={() => handleToolClick('distance')} />
            <CustomToolButton icon={Square} label="Rectangle" active={activeTool === 'RectangleROI'} onClick={() => handleToolClick('rectangle')} />
            <CustomToolButton icon={Gauge} label="Angle" active={activeTool === 'Angle'} onClick={() => handleToolClick('angle')} />
            <CustomToolButton icon={ScanLine} label="Probe" active={activeTool === 'Probe'} onClick={() => handleToolClick('probe')} />
          </div>
        </div>
        {/* Analyze Section */}
        <div className="tool-section border-b border-[#e4e7ec] dark:border-[#2D3848]">
          <h3 className="tool-section-title">Analyze</h3>
          <div className="tool-grid">
            <CustomToolButton icon={Stethoscope} label="Diagnose" onClick={() => handleToolClick('diagnose')} />
            <CustomToolButton icon={LineChart} label="Statistics" onClick={() => handleToolClick('statistics')} />
            <CustomToolButton icon={Crop} label="Segment" active={segmentationTools.includes(activeTool as any)} onClick={() => handleToolClick('segmentation')} />
            <CustomToolButton icon={ArrowLeftRight} label="Compare" onClick={() => handleToolClick('compare')} />
          </div>
        </div>
        {/* Workspace Section */}
        <div className="tool-section">
          <h3 className="tool-section-title">Workspace</h3>
          <div className="tool-grid">
            <CustomToolButton icon={Layout} label="Layout" onClick={cycleLayout} />
            <CustomToolButton icon={theme === 'dark' ? Sun : Moon} label={theme === 'dark' ? 'Light' : 'Dark'} onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')} />
            <CustomToolButton icon={Maximize2} label="Fullscreen" onClick={onToggleFullscreen} />
            <CustomToolButton icon={RotateCcw} label="Reset" onClick={() => toast({ title: 'Reset View' })} />
          </div>
        </div>
      </div>

      {/* Floating segmentation panel */}
      {showSegmentationPanel && (
        <div className="absolute left-full top-1/3 ml-2 z-50">
          <div className="bg-white dark:bg-card border border-border rounded-lg shadow-lg p-3 w-44 space-y-2">
            <h4 className="text-xs font-semibold text-foreground/70 uppercase tracking-wide mb-1">Segmentation</h4>
            <div className="grid grid-cols-3 gap-3">
              <CustomToolButton icon={Crop} label="Brush" active={activeTool === 'Brush'} onClick={() => handleSegmentationSelect('Brush')} />
              <CustomToolButton icon={Circle} label="Circle" active={activeTool === 'CircleScissor'} onClick={() => handleSegmentationSelect('CircleScissor')} />
              <CustomToolButton icon={Square} label="Rect" active={activeTool === 'RectangleScissor'} onClick={() => handleSegmentationSelect('RectangleScissor')} />
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
} 