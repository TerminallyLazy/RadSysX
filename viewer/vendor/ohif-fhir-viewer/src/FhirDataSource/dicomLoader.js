import dcmjs from 'dcmjs';
import { fetchDicomFile } from './fhirClient';

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;

function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function inspectBuffer(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const hasDICM = bytes.length >= 132 &&
    bytes[128] === 0x44 && bytes[129] === 0x49 &&
    bytes[130] === 0x43 && bytes[131] === 0x4D;
  const startsWithBrace = bytes[0] === 0x7B;
  return { hasDICM, startsWithBrace, size: bytes.length };
}

function naturalizeDataset(arrayBuffer) {
  const info = inspectBuffer(arrayBuffer);

  // Handle FHIR Binary JSON wrapper: {"resourceType":"Binary","data":"base64..."}
  if (info.startsWithBrace) {
    try {
      const text = new TextDecoder().decode(arrayBuffer);
      const json = JSON.parse(text);
      if (json.data) {
        arrayBuffer = base64ToArrayBuffer(json.data);
      } else {
        throw new Error('Response is JSON but has no "data" field — not a FHIR Binary resource');
      }
    } catch (e) {
      throw e;
    }
  }

  // Try Part 10 first, fall back to raw dataset (no preamble)
  let dicomData;
  try {
    dicomData = DicomMessage.readFile(arrayBuffer);
  } catch (e) {
    try {
      dicomData = DicomMessage.readFile(arrayBuffer, {
        TransferSyntaxUID: '1.2.840.10008.1.2',
      });
    } catch {
      const errInfo = inspectBuffer(arrayBuffer);
      throw new Error(
        `Failed to parse DICOM payload (${errInfo.size} bytes, DICM=${errInfo.hasDICM})`
      );
    }
  }

  const dataset = DicomMetaDictionary.naturalizeDataset(dicomData.dict);
  dataset._meta = DicomMetaDictionary.namifyDataset(dicomData.meta);
  return dataset;
}

export function parseDicomArrayBuffer(arrayBuffer) {
  return naturalizeDataset(arrayBuffer);
}

export async function loadDicomFromAttachment(attachment, serverRoot, authToken) {
  let arrayBuffer;
  let imageId;

  if (attachment.url) {
    const url = attachment.url.startsWith('http')
      ? attachment.url
      : `${serverRoot}${attachment.url}`;
    imageId = `dicomweb:${url}`;
    arrayBuffer = await fetchDicomFile(serverRoot, attachment.url, { authToken });
  } else if (attachment.data) {
    // Skip non-DICOM content types
    if (attachment.contentType && attachment.contentType !== 'application/dicom') {
      throw new Error(`Skipping non-DICOM attachment (contentType: ${attachment.contentType})`);
    }

    arrayBuffer = base64ToArrayBuffer(attachment.data);
    const blob = new Blob([arrayBuffer], { type: 'application/dicom' });
    const blobUrl = URL.createObjectURL(blob);
    imageId = `dicomweb:${blobUrl}`;
  } else {
    throw new Error('DocumentReference attachment has neither url nor data');
  }

  const naturalizedDataset = naturalizeDataset(arrayBuffer);

  return {
    imageId,
    metadata: naturalizedDataset,
  };
}
