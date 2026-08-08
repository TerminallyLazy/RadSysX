from __future__ import annotations

import io
import os
import time
from dataclasses import dataclass
from uuid import uuid4

import httpx
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, SecondaryCaptureImageStorage


@dataclass(frozen=True)
class SeedStudy:
    study_uid: str
    series_uid: str
    sop_uid: str
    accession_number: str
    patient_id: str
    patient_name: str
    modality: str
    description: str


SEED_STUDIES = [
    SeedStudy(
        study_uid="1.2.840.113619.2.55.3.604688123.1234.1700000001.101",
        series_uid="1.2.840.113619.2.55.3.604688123.1234.1700000001.101.1",
        sop_uid="1.2.840.113619.2.55.3.604688123.1234.1700000001.101.1.1",
        accession_number="ACC-CT-24001",
        patient_id="Patient/example-ct-01",
        patient_name="RadSysX^ChestCT",
        modality="CT",
        description="Chest CT with contrast",
    ),
    SeedStudy(
        study_uid="1.2.840.113619.2.55.3.604688123.1234.1700000002.201",
        series_uid="1.2.840.113619.2.55.3.604688123.1234.1700000002.201.1",
        sop_uid="1.2.840.113619.2.55.3.604688123.1234.1700000002.201.1.1",
        accession_number="ACC-MR-24017",
        patient_id="Patient/example-mr-02",
        patient_name="RadSysX^BrainMR",
        modality="MR",
        description="Brain MRI follow-up",
    ),
]


def build_instance(study: SeedStudy) -> bytes:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    meta.MediaStorageSOPInstanceUID = study.sop_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = "1.2.826.0.1.3680043.10.54321.1"

    dataset = FileDataset(
        filename_or_obj=None,
        dataset={},
        file_meta=meta,
        preamble=b"\0" * 128,
    )
    dataset.SOPClassUID = SecondaryCaptureImageStorage
    dataset.SOPInstanceUID = study.sop_uid
    dataset.StudyInstanceUID = study.study_uid
    dataset.SeriesInstanceUID = study.series_uid
    dataset.PatientID = study.patient_id
    dataset.PatientName = study.patient_name
    dataset.AccessionNumber = study.accession_number
    dataset.Modality = study.modality
    dataset.StudyDescription = study.description
    dataset.SeriesDescription = f"{study.description} Series"
    dataset.StudyDate = "20260308"
    dataset.StudyTime = "090000"
    dataset.SeriesNumber = 1
    dataset.InstanceNumber = 1
    dataset.Rows = 2
    dataset.Columns = 2
    dataset.SamplesPerPixel = 1
    dataset.PhotometricInterpretation = "MONOCHROME2"
    dataset.BitsAllocated = 8
    dataset.BitsStored = 8
    dataset.HighBit = 7
    dataset.PixelRepresentation = 0
    dataset.PixelData = b"\x00\x7f\x7f\xff"
    dataset.is_little_endian = True
    dataset.is_implicit_VR = False

    buffer = io.BytesIO()
    dataset.save_as(buffer, write_like_original=False)
    return buffer.getvalue()


def build_multipart_related(payload: bytes, content_type: str = "application/dicom") -> tuple[str, bytes]:
    boundary = f"radsysx-seed-{uuid4().hex}"
    body = (
        f"--{boundary}\r\n"
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("ascii") + payload + f"\r\n--{boundary}--\r\n".encode("ascii")
    return boundary, body


def main() -> None:
    orthanc_url = os.getenv(
        "RADSYSX_ORTHANC_DICOMWEB_URL",
        "http://localhost:8042/dicom-web",
    ).rstrip("/")
    username = os.getenv("RADSYSX_ORTHANC_USERNAME")
    password = os.getenv("RADSYSX_ORTHANC_PASSWORD")
    auth = (username, password) if username and password else None

    with httpx.Client(base_url=orthanc_url, auth=auth, timeout=10.0) as client:
        for _ in range(30):
            try:
                response = client.get("/studies", params={"limit": 1})
                response.raise_for_status()
                break
            except Exception:
                time.sleep(2)
        else:
            raise RuntimeError("Orthanc DICOMweb endpoint did not become ready in time.")

        for index, study in enumerate(SEED_STUDIES, start=1):
            existing = client.get(
                "/studies",
                params={"StudyInstanceUID": study.study_uid, "limit": 1},
            )
            existing.raise_for_status()
            if existing.json():
                continue

            payload = build_instance(study)
            boundary, body = build_multipart_related(payload)
            store = client.post(
                "/studies",
                content=body,
                headers={
                    "Content-Type": f'multipart/related; type="application/dicom"; boundary={boundary}'
                },
            )
            store.raise_for_status()
            print(f"Seeded sample study {index} ({study.modality})")


if __name__ == "__main__":
    main()
