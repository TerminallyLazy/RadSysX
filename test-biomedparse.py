#!/usr/bin/env python3
"""
BiomedParse Test Script
Tests the BiomedParse API with sample NIfTI and 2D image files.
"""

import os
import sys
import requests
from pathlib import Path

# Configuration
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")
TEST_DATA_DIR = Path(__file__).parent / "test-data"

# Color codes for terminal output
class Colors:
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    BLUE = '\033[94m'
    RESET = '\033[0m'
    BOLD = '\033[1m'

def print_header(text):
    print(f"\n{Colors.BOLD}{Colors.BLUE}{'='*60}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.BLUE}{text:^60}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.BLUE}{'='*60}{Colors.RESET}\n")

def print_success(text):
    print(f"{Colors.GREEN}✓{Colors.RESET} {text}")

def print_error(text):
    print(f"{Colors.RED}✗{Colors.RESET} {text}")

def print_warning(text):
    print(f"{Colors.YELLOW}⚠{Colors.RESET} {text}")

def print_info(text):
    print(f"{Colors.BLUE}ℹ{Colors.RESET} {text}")

def check_backend():
    """Check if the backend server is running."""
    print_header("Checking Backend Server")
    try:
        response = requests.get(f"{BACKEND_URL}/api/biomedparse/v1/health", timeout=5)
        if response.ok:
            data = response.json()
            print_success(f"Backend server is running at {BACKEND_URL}")
            print_info(f"Status: {data.get('status', 'unknown')}")
            print_info(f"GPU Available: {data.get('gpu_available', False)}")
            return True
        else:
            print_error(f"Backend returned status code: {response.status_code}")
            return False
    except requests.ConnectionError:
        print_error(f"Cannot connect to backend at {BACKEND_URL}")
        print_warning("Make sure the backend server is running:")
        print_warning("  uvicorn backend.server:app --reload --port 8000")
        return False
    except Exception as e:
        print_error(f"Error checking backend: {e}")
        return False

def test_2d_analysis():
    """Test 2D image analysis."""
    print_header("Testing 2D Image Analysis")

    # Find a test image
    test_images = list((TEST_DATA_DIR / "2d").glob("*.png"))
    if not test_images:
        test_images = list((TEST_DATA_DIR / "2d").glob("*.jpg"))

    if not test_images:
        print_warning("No 2D test images found in test-data/2d/")
        return False

    test_image = test_images[0]
    print_info(f"Using test image: {test_image.name}")

    # Prepare the request
    url = f"{BACKEND_URL}/api/biomedparse/v1/predict-2d"
    params = {
        "return_heatmap": "true",
        "threshold": "0.5"
    }

    # Choose prompts based on image name
    if "lung" in test_image.name.lower():
        prompts = ["lung", "nodule"]
    elif "pathology" in test_image.name.lower():
        prompts = ["neoplastic cells", "inflammatory cells"]
    else:
        prompts = ["tissue", "lesion"]

    print_info(f"Prompts: {', '.join(prompts)}")

    files = {"file": open(test_image, "rb")}

    # Add prompts as form data
    data = {}
    for i, prompt in enumerate(prompts):
        data[f"prompts"] = prompt

    try:
        print_info("Sending request to backend...")
        response = requests.post(url, params=params, files=files, data={"prompts": prompts}, timeout=60)

        if response.ok:
            result = response.json()
            print_success("2D analysis completed successfully!")
            print_info(f"Results: {len(result.get('results', []))} segmentations")
            for i, res in enumerate(result.get("results", [])):
                print_info(f"  [{i+1}] Prompt: '{res['prompt']}' | Confidence: {res['classification_confidence']:.2%}")
            return True
        else:
            print_error(f"Analysis failed with status {response.status_code}")
            print_error(f"Response: {response.text[:200]}")
            return False
    except Exception as e:
        print_error(f"Error during 2D analysis: {e}")
        return False

def test_3d_analysis():
    """Test 3D NIfTI analysis."""
    print_header("Testing 3D NIfTI Analysis")

    # Find a test NIfTI file (prefer smaller ones)
    test_files = sorted((TEST_DATA_DIR / "nifti").glob("*.nii.gz"), key=lambda x: x.stat().st_size)

    if not test_files:
        print_warning("No NIfTI test files found in test-data/nifti/")
        return False

    # Use the smallest file for faster testing
    test_file = test_files[0]
    file_size_mb = test_file.stat().st_size / (1024 * 1024)
    print_info(f"Using test file: {test_file.name} ({file_size_mb:.1f} MB)")

    if file_size_mb > 100:
        print_warning(f"File is large ({file_size_mb:.1f} MB) - this may take a while...")

    # Prepare the request
    url = f"{BACKEND_URL}/api/biomedparse/v1/predict-3d-nifti"
    params = {
        "return_heatmap": "true",
        "threshold": "0.5"
    }

    # Choose prompts based on filename
    if "kidney" in test_file.name.lower():
        prompts = ["kidney", "tumor"]
    elif "brain" in test_file.name.lower() or "BRATS" in test_file.name:
        prompts = ["brain", "tumor"]
    elif "amos" in test_file.name.lower():
        prompts = ["liver", "kidney"]
    else:
        prompts = ["organ", "lesion"]

    print_info(f"Prompts: {', '.join(prompts)}")

    files = {"file": open(test_file, "rb")}

    try:
        print_info("Sending request to backend (this may take a while for large volumes)...")
        response = requests.post(url, params=params, files=files, data={"prompts": prompts}, timeout=300)

        if response.ok:
            result = response.json()
            print_success("3D analysis completed successfully!")
            print_info(f"Results: {len(result.get('results', []))} segmentations")
            for i, res in enumerate(result.get("results", [])):
                print_info(f"  [{i+1}] Prompt: '{res['prompt']}' | Shape: {res['mask_shape']} | Confidence: {res['presence_confidence']:.2%}")
                print_info(f"      Mask URL: {res['mask_url']}")
                if res.get('heatmap_url'):
                    print_info(f"      Heatmap URL: {res['heatmap_url']}")
            return True
        else:
            print_error(f"Analysis failed with status {response.status_code}")
            print_error(f"Response: {response.text[:500]}")
            return False
    except requests.Timeout:
        print_error("Request timed out - the file may be too large or processing is slow")
        print_warning("Try with a smaller file or increase the timeout")
        return False
    except Exception as e:
        print_error(f"Error during 3D analysis: {e}")
        return False

def main():
    print(f"{Colors.BOLD}BiomedParse Test Suite{Colors.RESET}")
    print(f"Backend URL: {BACKEND_URL}")
    print(f"Test Data: {TEST_DATA_DIR}")

    # Check prerequisites
    if not TEST_DATA_DIR.exists():
        print_error(f"Test data directory not found: {TEST_DATA_DIR}")
        sys.exit(1)

    # Check backend
    if not check_backend():
        sys.exit(1)

    # Run tests
    tests_passed = 0
    tests_total = 0

    # Test 2D
    tests_total += 1
    if test_2d_analysis():
        tests_passed += 1

    # Test 3D
    tests_total += 1
    if test_3d_analysis():
        tests_passed += 1

    # Summary
    print_header("Test Summary")
    if tests_passed == tests_total:
        print_success(f"All tests passed! ({tests_passed}/{tests_total})")
        sys.exit(0)
    else:
        print_warning(f"Some tests failed: {tests_passed}/{tests_total} passed")
        sys.exit(1)

if __name__ == "__main__":
    main()
