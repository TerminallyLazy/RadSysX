"""
Simplified BiomedParse API stub for testing routing.
This is a minimal version that doesn't require BiomedParse dependencies.
"""

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/biomedparse/v1", tags=["biomedparse"])


class HealthResponse(BaseModel):
    status: str
    gpu_available: bool
    message: str


@router.get("/health", response_model=HealthResponse)
async def health():
    """Health check endpoint that doesn't require BiomedParse."""
    import torch
    return {
        "status": "healthy",
        "gpu_available": torch.cuda.is_available(),
        "message": "BiomedParse stub - full implementation requires dependencies"
    }


@router.post("/predict-2d")
async def predict_2d():
    """Stub endpoint - requires full BiomedParse setup."""
    return {
        "error": "BiomedParse not fully configured. Install dependencies and checkpoint.",
        "help": "See BIOMEDPARSE_QUICKSTART.md for setup instructions"
    }


@router.post("/predict-3d-nifti")
async def predict_3d_nifti():
    """Stub endpoint - requires full BiomedParse setup."""
    return {
        "error": "BiomedParse not fully configured. Install dependencies and checkpoint.",
        "help": "See BIOMEDPARSE_QUICKSTART.md for setup instructions"
    }
