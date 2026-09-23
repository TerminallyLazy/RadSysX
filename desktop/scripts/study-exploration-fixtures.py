"""Generate a private synthetic 34-frame study; no patient images or downloads."""
import argparse
from pathlib import Path
import secrets
import numpy as np
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

parser=argparse.ArgumentParser();parser.add_argument('--output',required=True)
root=Path(parser.parse_args().output);root.mkdir(parents=True,exist_ok=True)
study,series,frame=generate_uid(),generate_uid(),generate_uid()
marker=secrets.randbelow(5)+3
for index in range(34):
    uid=generate_uid();meta=FileMetaDataset()
    meta.MediaStorageSOPClassUID=CTImageStorage;meta.MediaStorageSOPInstanceUID=uid;meta.TransferSyntaxUID=ExplicitVRLittleEndian
    ds=FileDataset(None,{},file_meta=meta,preamble=b'\0'*128)
    ds.SOPClassUID=CTImageStorage;ds.SOPInstanceUID=uid;ds.StudyInstanceUID=study;ds.SeriesInstanceUID=series;ds.FrameOfReferenceUID=frame
    ds.PatientID='SYNTHETIC';ds.PatientName='SYNTHETIC';ds.Modality='CT';ds.StudyDate='20260923';ds.StudyTime='120000'
    ds.SeriesNumber=1;ds.InstanceNumber=index+1;ds.Rows=64;ds.Columns=64;ds.SamplesPerPixel=1
    ds.PhotometricInterpretation='MONOCHROME2';ds.BitsAllocated=16;ds.BitsStored=16;ds.HighBit=15;ds.PixelRepresentation=1
    ds.PixelSpacing=[0.7,1.2];ds.SliceThickness=2;ds.ImageOrientationPatient=[1,0,0,0,1,0];ds.ImagePositionPatient=[0,0,index*2]
    ds.RescaleSlope=1;ds.RescaleIntercept=0;ds.WindowCenter=40;ds.WindowWidth=400
    yy,xx=np.mgrid[:64,:64];pixels=np.where((xx-32)**2+(yy-32)**2<24**2,60,-800).astype('<i2')
    if index==31:
        for box in range(marker):pixels[28:33,10+box*6:13+box*6]=1000
    ds.PixelData=pixels.tobytes();ds.save_as(root/f'frame-{index:03}.dcm',enforce_file_format=True)
(root/'expected-marker.txt').write_text(str(marker))
