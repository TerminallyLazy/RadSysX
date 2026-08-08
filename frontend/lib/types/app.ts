import React from 'react';
import { LoadedImage } from '@/lib/types';

export type ViewportLayout = "1x1" | "2x2" | "3x3";

export type C3DToolName =
  | 'Pan'
  | 'Zoom'
  | 'WindowLevel'
  | 'StackScroll'
  | 'Length'
  | 'RectangleROI'
  | 'EllipticalROI'
  | 'Angle'
  | 'Probe'
  | 'Brush'
  | 'CircleScissor'
  | 'RectangleScissor'
  | null;

export type AIModel = "mammogram" | "brain-mri" | "chest-xray";

export interface AIResult {
  type: string;
  confidence: number;
  findings: string[];
  segmentation?: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface ImageAnalysis {
  description: string;
  findings: string[];
  measurements?: {
    width?: number;
    height?: number;
    aspectRatio?: number;
    density?: number;
  };
  abnormalities?: string[];
}

export interface ToolbarProps {
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  activeTool?: C3DToolName;
  setActiveTool?: React.Dispatch<React.SetStateAction<C3DToolName>>;
}

export interface ViewportGridProps {
  layout: ViewportLayout;
  expandedViewportId: string | null;
  onViewportExpand: (viewportId: string | null) => void;
  viewportRefs: React.RefObject<HTMLDivElement>[];
  loadedImages?: LoadedImage[];
  currentImageIndex: number;
  activeTool: unknown;
}

export interface RadSysXAgentsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// Extended toolbar props for specialized toolbars
export interface LeftToolbarProps extends ToolbarProps {
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
  layout: ViewportLayout;
  onLayoutChange: (layout: ViewportLayout) => void;
  onToggleFullscreen: () => void;
  setIsRadSysXModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export interface RightPanelProps extends ToolbarProps {
  csImageIds: string[];
  setCsImageIds: React.Dispatch<React.SetStateAction<string[]>>;
  blobUrls: string[];
  setBlobUrls: React.Dispatch<React.SetStateAction<string[]>>;
  loadedImages: LoadedImage[];
  setLoadedImages: React.Dispatch<React.SetStateAction<LoadedImage[]>>;
  isSeriesLoaded: boolean;
  setIsSeriesLoaded: React.Dispatch<React.SetStateAction<boolean>>;
} 