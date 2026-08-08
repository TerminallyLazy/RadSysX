---
name: medical-imaging
description: >-
  Medical image analysis guidance for BiomedParse segmentation results.
  Use when interpreting 2D or 3D medical image segmentation, discussing
  imaging modalities, or explaining segmentation outputs.
---

# Medical Imaging Analysis

Guide for interpreting BiomedParse medical image segmentation results
and discussing medical imaging concepts.

## Supported Modalities

BiomedParse v2 supports these imaging modalities:
- **CT** (Computed Tomography) — lung, abdominal, cardiac
- **MRI** (Magnetic Resonance Imaging) — brain, cardiac, musculoskeletal
- **X-Ray** — chest, bone
- **Ultrasound** — abdominal, cardiac, obstetric
- **Pathology** — histological slides
- **Endoscopy** — GI tract
- **Dermoscopy** — skin lesions
- **Fundus** — retinal imaging
- **OCT** (Optical Coherence Tomography) — retinal layers

## Analysis Types

### 2D Analysis
- Input: PNG/JPG images
- Output: Segmentation masks + heatmaps (NPZ format)
- Use case: Single-slice analysis, pathology, dermoscopy

### 3D Analysis
- Input: NIfTI volumes (.nii.gz)
- Output: 3D segmentation masks + heatmaps (NPZ format)
- Use case: Volumetric CT/MRI analysis, organ segmentation

## Interpreting Results

When discussing segmentation results:
1. **Masks**: Binary regions identifying the segmented structure
2. **Heatmaps**: Probability maps showing model confidence (0.0-1.0)
3. **Threshold**: Default 0.5; lower values capture more area with less certainty

## Prompt Design for Segmentation

Effective prompts for BiomedParse follow anatomical terminology:
- Organ-level: "heart", "liver", "kidney", "lung"
- Structure-level: "left ventricle", "aorta", "portal vein"
- Pathology: "tumor", "nodule", "lesion", "hemorrhage"

## Limitations

- Results are for research purposes only, not clinical diagnosis
- Model confidence varies by modality and anatomical region
- 3D analysis requires GPU for reasonable performance
- Always correlate with clinical findings and expert review
