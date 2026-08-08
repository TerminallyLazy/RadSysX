from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any


PALETTE = {
    1: "#f97316",
    2: "#22c55e",
    3: "#38bdf8",
    4: "#eab308",
    5: "#f472b6",
    6: "#a78bfa",
    7: "#2dd4bf",
    8: "#fb7185",
    9: "#84cc16",
    10: "#60a5fa",
    11: "#f59e0b",
    12: "#14b8a6",
    13: "#c084fc",
    14: "#f43f5e",
    15: "#06b6d4",
}


def main() -> None:
    args = parse_args()
    root = args.biomedparse_root.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    sys.path.insert(0, str(root))

    import hydra
    import numpy as np
    import torch
    import torch.nn.functional as F
    from hydra import compose
    from hydra.core.global_hydra import GlobalHydra
    from PIL import Image
    from utils import process_input, process_output
    from inference import merge_multiclass_masks, postprocess

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats()

    GlobalHydra.instance().clear()
    t0 = time.perf_counter()
    hydra.initialize_config_dir(
        config_dir=str(root / "configs" / "model"),
        job_name="radsysx_biomedparse_demo",
        version_base=None,
    )
    cfg = compose(config_name="biomedparse_3D")
    model = hydra.utils.instantiate(cfg, _convert_="object")
    model_instantiated_seconds = time.perf_counter() - t0

    t0 = time.perf_counter()
    model.load_pretrained(str(args.checkpoint))
    model = model.to(device).eval()
    model_loaded_seconds = time.perf_counter() - t0

    sample_path = root / "examples" / "imgs" / "CT_AMOS_amos_0018.npz"
    npz_data = np.load(sample_path, allow_pickle=True)
    imgs_np = npz_data["imgs"]
    text_prompts = npz_data["text_prompts"].item()
    ids = parse_prompt_ids(args.prompt_ids, text_prompts)
    text = "[SEP]".join([str(text_prompts[str(prompt_id)]) for prompt_id in ids])

    imgs, pad_width, padded_size, valid_axis = process_input(imgs_np, 512)
    imgs = imgs.to(device).int()
    input_tensor = {
        "image": imgs.unsqueeze(0),
        "text": [text],
    }

    t0 = time.perf_counter()
    with torch.no_grad():
        output = model(input_tensor, mode="eval", slice_batch_size=args.slice_batch_size)
    if device.type == "cuda":
        torch.cuda.synchronize()
    inference_seconds = time.perf_counter() - t0

    mask_preds = output["predictions"]["pred_gmasks"]
    mask_preds = F.interpolate(mask_preds, size=(512, 512), mode="bicubic", align_corners=False, antialias=True)
    mask_preds = postprocess(mask_preds, output["predictions"]["object_existence"])
    mask_preds = merge_multiclass_masks(mask_preds, ids)
    mask_preds = process_output(mask_preds, pad_width, padded_size, valid_axis)
    if hasattr(mask_preds, "detach"):
        mask_np = mask_preds.detach().cpu().numpy()
    else:
        mask_np = np.asarray(mask_preds)
    mask_np = mask_np.astype(np.uint8, copy=False)

    label_summaries = summarize_labels(mask_np, ids, text_prompts)
    preview_slice = select_preview_slice(mask_np)
    preview = create_preview_png(imgs_np, mask_np, preview_slice)

    mask_path = output_dir / "mask.npz"
    preview_path = output_dir / "preview.png"
    np.savez_compressed(mask_path, seg=mask_np, ids=np.array(ids, dtype=np.int16))
    preview.save(preview_path)

    peak_vram_gib = None
    gpu_name = None
    if device.type == "cuda":
        peak_vram_gib = torch.cuda.max_memory_allocated() / 1024**3
        gpu_name = torch.cuda.get_device_name(0)

    summary = {
        "source": args.source,
        "modelId": "microsoft/BiomedParse",
        "modelVersion": model_version_from_checkpoint(args.checkpoint),
        "promptIds": ids,
        "inputShape": list(imgs_np.shape),
        "maskShape": list(mask_np.shape),
        "nonzeroVoxels": int((mask_np > 0).sum()),
        "previewSlice": preview_slice,
        "labels": label_summaries,
        "timings": {
            "modelInstantiatedSeconds": round(model_instantiated_seconds, 3),
            "modelLoadedSeconds": round(model_loaded_seconds, 3),
            "inferenceSeconds": round(inference_seconds, 3),
        },
        "runtime": {
            "python": sys.version.split()[0],
            "torchVersion": torch.__version__,
            "torchCuda": torch.version.cuda,
            "device": str(device),
            "gpuName": gpu_name,
            "peakVramGib": round(peak_vram_gib, 3) if peak_vram_gib is not None else None,
        },
        "warnings": [
            "Research demo only: output is a preview artifact, not a validated clinical segmentation.",
        ],
    }
    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the RadSysX BioMedParse v2 integration demo.")
    parser.add_argument("--biomedparse-root", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--source", choices=["included_ct_amos"], default="included_ct_amos")
    parser.add_argument("--slice-batch-size", type=int, default=4)
    parser.add_argument("--prompt-ids", default="")
    return parser.parse_args()


def parse_prompt_ids(raw: str, text_prompts: dict[str, Any]) -> list[int]:
    valid_ids = sorted(int(key) for key in text_prompts if key != "instance_label")
    if not raw.strip():
        return valid_ids
    requested: list[int] = []
    for part in raw.split(","):
        value = part.strip()
        if not value:
            continue
        prompt_id = int(value)
        if prompt_id not in valid_ids:
            raise ValueError(f"Prompt id {prompt_id} is not available in the included CT AMOS sample.")
        requested.append(prompt_id)
    return requested or valid_ids


def summarize_labels(mask_np, ids: list[int], text_prompts: dict[str, Any]) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for label in ids:
        coords = (mask_np == label).nonzero()
        voxel_count = int(len(coords[0]))
        bounding_box = None
        if voxel_count:
            z_values, y_values, x_values = coords
            bounding_box = [
                int(z_values.min()),
                int(y_values.min()),
                int(x_values.min()),
                int(z_values.max()),
                int(y_values.max()),
                int(x_values.max()),
            ]
        summaries.append(
            {
                "label": label,
                "prompt": str(text_prompts[str(label)]),
                "voxelCount": voxel_count,
                "boundingBox": bounding_box,
                "color": PALETTE.get(label, "#67e8f9"),
            }
        )
    return summaries


def select_preview_slice(mask_np) -> int:
    nonzero_by_slice = (mask_np > 0).sum(axis=(1, 2))
    if int(nonzero_by_slice.max()) > 0:
        return int(nonzero_by_slice.argmax())
    return int(mask_np.shape[0] // 2)


def create_preview_png(imgs_np, mask_np, slice_index: int):
    import numpy as np
    from PIL import Image

    image = imgs_np[slice_index].astype(np.float32)
    min_value = float(image.min())
    max_value = float(image.max())
    if max_value > min_value:
        image = (image - min_value) / (max_value - min_value)
    base = (image * 255).clip(0, 255).astype(np.uint8)
    rgb = np.stack([base, base, base], axis=-1).astype(np.float32)

    mask = mask_np[slice_index]
    overlay = rgb.copy()
    for label, color in PALETTE.items():
        selected = mask == label
        if not selected.any():
            continue
        overlay[selected] = hex_to_rgb(color)
    alpha = (mask > 0).astype(np.float32)[..., None] * 0.52
    blended = rgb * (1 - alpha) + overlay * alpha
    return Image.fromarray(blended.clip(0, 255).astype(np.uint8), mode="RGB")


def hex_to_rgb(color: str) -> tuple[int, int, int]:
    value = color.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def model_version_from_checkpoint(path: Path) -> str:
    parts = path.resolve().parts
    if "snapshots" in parts:
        index = parts.index("snapshots")
        if index + 1 < len(parts):
            return parts[index + 1]
    return "biomedparse_v2.ckpt"


if __name__ == "__main__":
    main()
